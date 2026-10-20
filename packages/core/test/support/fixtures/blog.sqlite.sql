-- Reference schema: the blog domain, SQLite dialect. The same tables, columns and keys as
-- blog.sql (PostgreSQL), so that every suite runs unchanged:
--
-- - bigserial keys are INTEGER PRIMARY KEY AUTOINCREMENT (the rowid, never reused);
-- - the array column posts.tags is JSON text (an array of strings);
-- - jsonb is JSON text; booleans are 0 / 1;
-- - timestamps are ISO 8601 text in UTC with milliseconds, the form the adapter writes;
-- - uuid is text, generated (version 4) when no value is given.
--
-- SQLite reports a unique violation by its columns; the adapter rebuilds Postgres's
-- default constraint name from them (users_email_key).
--
-- Load with loadFixture(db, "blog") from ../db.ts.

CREATE TABLE users (
  id            integer PRIMARY KEY AUTOINCREMENT,
  email         text NOT NULL UNIQUE,
  name          text,
  age           integer,
  role          text NOT NULL DEFAULT 'member',
  password_hash text,
  settings      text,
  lock_version  integer NOT NULL DEFAULT 1,
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- has_one: users -> profiles
CREATE TABLE profiles (
  id         integer PRIMARY KEY AUTOINCREMENT,
  user_id    integer NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  bio        text,
  avatar_url text
);

-- has_many / belongs_to: users -> posts
CREATE TABLE posts (
  id           integer PRIMARY KEY AUTOINCREMENT,
  author_id    integer NOT NULL REFERENCES users (id),
  title        text NOT NULL,
  body         text,
  published    boolean DEFAULT 0,
  views        integer DEFAULT 0,
  tags         text,
  published_at text,
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX posts_author_id_index ON posts (author_id);

CREATE TABLE comments (
  id          integer PRIMARY KEY AUTOINCREMENT,
  post_id     integer NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_id   integer REFERENCES users (id),
  body        text NOT NULL,
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX comments_post_id_index ON comments (post_id);
CREATE INDEX comments_author_id_index ON comments (author_id);

-- many_to_many: posts <-> tags through posts_tags
CREATE TABLE tags (
  id   integer PRIMARY KEY AUTOINCREMENT,
  name text UNIQUE
);

CREATE TABLE posts_tags (
  post_id integer NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id  integer NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- uuid primary key
CREATE TABLE orgs (
  id   text PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  name text NOT NULL
);

-- composite primary key
CREATE TABLE memberships (
  org_id  text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'member',
  PRIMARY KEY (org_id, user_id)
);
