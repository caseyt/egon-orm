// @run
// The checked sources of the Egon side of guide/coming-from-prisma.md,
// coming-from-drizzle.md and coming-from-sequelize.md: one region per task, shared by the
// three pages. Each `#region` is included by name; everything outside a region is the
// scaffolding that makes the regions compile and run (docs:integration runs this file and
// checks its `// =>` comments).
// #region imports
import { postgres } from "@egon-orm/postgres";
import {
  belongsTo,
  cast,
  change,
  count,
  createRepo,
  fragment,
  from,
  hasMany,
  Schema,
  t,
  timestamps,
} from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";
// #endregion imports

// #region define
export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"])
      .validateRequired(["email"])
      .validateFormat("email", /@/)
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
  published: t.boolean().default(false),
  views: t.integer().default(0),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });

  static changeset(post: Post | typeof Post, params: unknown) {
    return cast(post, params, ["title", "published"]).validateRequired(["title"]);
  }
}
// #endregion define

// #region connect
const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });
// #endregion connect

// #region migration
// The tables, with what Prisma's @unique and @default say: in Egon they belong to the database.
const tables = defineMigration({
  up(m) {
    m.createTable("users", (table) => {
      table.id({ type: "integer" }); //              serial: an integer, as User.id says
      table.text("email").notNull().unique(); //           @unique (users_email_key)
      table.text("name");
      table.text("role").notNull().default("member"); //   @default("member")
      table.timestamps();
    });
    m.createTable("posts", (table) => {
      table.id({ type: "integer" });
      table.references("author_id", "users", { type: "integer" }).notNull();
      table.text("title").notNull();
      table.boolean("published").notNull().default(false);
      table.integer("views").notNull().default(0);
      table.timestamps();
    });
  },
  down(m) {
    m.dropTable("posts");
    m.dropTable("users");
  },
});
// #endregion migration

export async function run(): Promise<void> {
  // #region migrate
  const admin = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter: admin,
    migrations: [{ version: 1, name: "tables", migration: tables }],
  }).up();
  await admin.close();
  // #endregion migrate

  // #region create
  const created = await repo.insert(User.changeset(User, { email: "ada@example.com", name: "Ada" }));
  if (!created.success) {
    // Invalid input (an email without "@", say): a form would show these messages instead.
    throw new Error(`invalid: ${JSON.stringify(created.error.errorMessages())}`);
  }
  const ada = created.data; // type: User, with its id, role and timestamps filled in
  ada.role; // => "member"

  const bo = await repo.insertOrThrow(User.changeset(User, { email: "bo@example.com" })); // throws if invalid
  // #endregion create

  // #region create-error
  const taken = await repo.insert(User.changeset(User, { email: "ada@example.com" }));
  taken.success; // => false
  if (!taken.success) {
    taken.error.errorMessages(); // => { email: ["has already been taken"] }
  }
  // #endregion create-error

  // #region nested-create
  const withPosts = await repo.insertOrThrow(
    User.changeset(User, {
      email: "cy@example.com",
      posts: [{ title: "Hello" }, { title: "Again" }],
    }).castAssoc("posts"),
  ); // the user and both posts, in one transaction
  // type: User. The posts are on the returned row, but its type does not say so: to use
  // them, check with isLoaded(User, cy, "posts"), or read the user again with a preload.
  const cy = await repo.one(from(User, "u").where({ id: withPosts.id }).preload("posts"));
  cy?.posts.length; // => 2
  // #endregion nested-create

  // #region fixtures
  // The rows the next examples read: Ada has a draft and a launch post, Bo has notes.
  await repo.insertAll(Post, [
    { authorId: ada.id, title: "Draft", published: false },
    { authorId: ada.id, title: "Launch", published: true, views: 10 },
    { authorId: bo.id, title: "Notes", published: true, views: 3 },
  ]);
  // #endregion fixtures

  // #region find-by-id
  const user = await repo.get(User, ada.id); // User | null
  user?.email; // => "ada@example.com"
  const sure = await repo.getOrThrow(User, ada.id); // throws NoResultsError if missing
  // #endregion find-by-id

  // #region find-unique
  const byEmail = await repo.getBy(User, { email: "bo@example.com" }); // User | null
  byEmail?.id === bo.id; // => true
  // #endregion find-unique

  // #region find-many
  const popular = await repo.all(
    from(Post, "p")
      .where({ published: true })
      .orderBy(({ p }) => p.views.desc())
      .limit(10),
  ); // type: Post[]
  popular.map((p) => p.title); // => ["Launch", "Notes"]
  // #endregion find-many

  // #region find-first
  const latest = await repo.first(from(Post, "p").orderBy(({ p }) => p.id.desc())); // Post | null
  latest?.title; // => "Notes"
  // #endregion find-first

  // #region select
  const emails = await repo.all(from(User, "u").select(({ u }) => ({ id: u.id, email: u.email })));
  // type: { id: number; email: string }[]
  emails.length; // => 3
  // #endregion select

  // #region operators
  const matches = await repo.all(
    from(User, "u").where(({ u }) =>
      u.email.like("%@example.com").and(u.name.isNull().or(u.id.in([ada.id, bo.id]))),
    ),
  );
  matches.length; // => 3
  // #endregion operators

  // #region count
  await repo.count(from(Post, "p").where({ published: true })); // => 2
  // #endregion count

  // #region paginate
  const page2 = await repo.all(
    from(Post, "p")
      .orderBy(({ p }) => p.id)
      .limit(2)
      .offset(2),
  );

  const afterId = page2[0]?.id ?? 0; // keyset: continue after the last row seen
  const next = await repo.all(
    from(Post, "p")
      .where(({ p }) => p.id.gt(afterId))
      .orderBy(({ p }) => p.id)
      .limit(2),
  );
  next.length; // => 2
  // #endregion paginate

  // #region include
  const authors = await repo.all(
    from(User, "u")
      .preload("posts")
      .orderBy(({ u }) => u.id),
  ); // type: Loaded<typeof User, "posts">[]: each user has its posts, as Post[]
  authors[0]?.posts.length; // => 2

  const recent = await repo.all(
    from(User, "u").preload("posts", (q) =>
      q
        .where(({ posts }) => posts.published)
        .orderBy(({ posts }) => posts.createdAt.desc())
        .limit(1),
    ), // the latest published post of each user, still one query for all users
  );
  // #endregion include

  // #region filter-relation
  const writers = await repo.all(
    from(User, "u")
      .joinAssoc("u", "posts", "p")
      .where(({ p }) => p.published)
      .distinct(),
  ); // type: User[]: the users with at least one published post
  writers.length; // => 2
  // #endregion filter-relation

  // #region group-by
  const perAuthor = await repo.all(
    from(Post, "p")
      .groupBy(({ p }) => p.authorId)
      .orderBy(({ p }) => p.authorId)
      .select(({ p }) => ({ authorId: p.authorId, posts: count(p.id) })),
  ); // type: { authorId: number; posts: number }[]
  perAuthor.length; // => 3
  // #endregion group-by

  // #region update
  const renamed = await repo.updateOrThrow(User.changeset(sure, { name: "Ada Lovelace" }));
  renamed.name; // => "Ada Lovelace"
  // #endregion update

  // #region update-many
  const bumped = await repo.updateAll(
    from(Post, "p")
      .where({ published: true })
      .set(({ p }) => ({ views: p.views.add(1) })),
  );
  bumped.count; // => 2
  // #endregion update-many

  // #region upsert
  const upserted = await repo.insertOrThrow(change(User, { email: "ada@example.com", name: "Ada L." }), {
    onConflict: { target: ["email"], update: ["name"] },
  });
  upserted.id === ada.id; // => true
  // #endregion upsert

  // #region transaction
  const moved = await repo.transaction(async (tx) => {
    const author = await tx.getByOrThrow(User, { email: "bo@example.com" });
    await tx.updateAll(from(Post, "p").where({ authorId: ada.id }).set({ authorId: author.id }));
    return tx.count(from(Post, "p").where({ authorId: author.id }));
  });
  moved.success; // => true
  // #endregion transaction

  // #region raw
  const { rows } = await repo.raw(fragment`select count(*)::int as n from posts where views > ${5}`);
  rows[0]; // => { n: 1 }
  // #endregion raw

  // #region delete
  const draft = await repo.getByOrThrow(Post, { title: "Draft" });
  await repo.deleteOrThrow(draft);
  // #endregion delete

  // #region delete-many
  const removed = await repo.deleteAll(from(Post, "p").where(({ p }) => p.views.lt(5)));
  removed.count; // => 3
  // #endregion delete-many

  void withPosts;
  void recent;
  await repo.close();
}
