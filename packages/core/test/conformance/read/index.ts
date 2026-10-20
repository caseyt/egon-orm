// The read conformance suite: what the repo's reads must do against a real database,
// written once and run by each dialect package with a profile of its own. It covers every
// read method, every select shape, the join kinds and their null handling, every logical
// type read back through real columns, ordering and paging, aggregates over empty sets,
// composite and uuid keys, database schemas, `one` and `first` over 0, 1 and many rows, a
// long stream left early, and concurrent reads.
//
// One database per run of the suite, over the blog fixture with a small fixed data set.
// Every repo a test makes is closed after the test, once its connections are back.
import {
  type AnyFieldType,
  avg,
  coalesce,
  count,
  createRepo,
  type DatabaseAdapter,
  DatabaseError,
  defineType,
  type Expr,
  fragment,
  from,
  isRow,
  MultipleResultsError,
  max,
  meta,
  NoResultsError,
  type PoolEvent,
  param,
  QueryError,
  type Repo,
  type RepoOptions,
  type RepoQueryEvent,
  Schema,
  stateOf,
  sum,
  t,
  val,
} from "egon-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AnySchema } from "../../../src/contracts/schema.js";
import { ROW } from "../../../src/contracts/schema.js";
import { resolveCodec, stringType } from "../../../src/types/index.js";
import {
  Comment,
  createTestDatabase,
  Membership,
  Org,
  Post,
  Profile,
  Tag,
  type TestDatabase,
  type TestDatabaseHandle,
  User,
  UserSettings,
} from "../../support/index.js";
import { ROUND_TRIP_CASES } from "../adapter/values.js";
import type { MakeReadAdapterOptions, ReadConformanceProfile } from "./profile.js";

export type { MakeReadAdapterOptions, ReadConformanceProfile } from "./profile.js";

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleepMs(10);
  }
}

function checkedOut(stats: PoolEvent): number {
  return stats.size - stats.idle;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// --- the data set ---------------------------------------------------------------------

const ORG_A = "0190d8a0-0000-7000-8000-00000000000a";
const ORG_B = "0190d8a0-0000-7000-8000-00000000000b";
const at = (iso: string): Date => new Date(iso);

const USERS = [
  {
    id: 1,
    email: "ada@example.com",
    name: "Ada",
    age: 36,
    role: "admin",
    passwordHash: "hash-of-ada",
    settings: { theme: "dark", emailNotifications: false },
    lockVersion: 3,
    createdAt: at("2026-01-01T10:00:00.000Z"),
    updatedAt: at("2026-01-05T10:00:00.000Z"),
  },
  {
    id: 2,
    email: "grace@example.com",
    name: null,
    age: 85,
    role: "member",
    passwordHash: null,
    settings: null,
    lockVersion: 1,
    createdAt: at("2026-01-02T10:00:00.000Z"),
    updatedAt: at("2026-01-02T10:00:00.000Z"),
  },
  {
    id: 3,
    email: "linus@example.com",
    name: "Linus",
    age: null,
    role: "member",
    passwordHash: null,
    settings: null,
    lockVersion: 1,
    createdAt: at("2026-01-03T10:00:00.000Z"),
    updatedAt: at("2026-01-03T10:00:00.000Z"),
  },
  {
    id: 4,
    email: "margaret@example.com",
    name: "Margaret",
    age: 17,
    role: "member",
    passwordHash: null,
    settings: null,
    lockVersion: 1,
    createdAt: at("2026-01-04T10:00:00.000Z"),
    updatedAt: at("2026-01-04T10:00:00.000Z"),
  },
];

const POSTS = [
  {
    id: 10,
    authorId: 1,
    title: "Notes on the engine",
    body: "Long notes",
    published: true,
    views: 120,
    tagList: ["math", "engines"],
    publishedAt: at("2026-02-01T08:30:00.123Z"),
    createdAt: at("2026-02-01T08:00:00.000Z"),
    updatedAt: at("2026-02-01T08:00:00.000Z"),
  },
  {
    id: 11,
    authorId: 1,
    title: "Unfinished draft",
    body: null,
    published: false,
    views: 0,
    tagList: null,
    publishedAt: null,
    createdAt: at("2026-02-03T08:00:00.000Z"),
    updatedAt: at("2026-02-03T08:00:00.000Z"),
  },
  {
    id: 12,
    authorId: 2,
    title: "Compilers, briefly",
    body: "Short",
    published: true,
    views: 45,
    tagList: ["compilers"],
    publishedAt: at("2026-02-02T09:00:00.000Z"),
    createdAt: at("2026-02-02T08:00:00.000Z"),
    updatedAt: at("2026-02-02T08:00:00.000Z"),
  },
];

const COMMENTS = [
  { id: 100, postId: 10, authorId: 2, body: "Lovely", createdAt: at("2026-03-01T00:00:00.000Z") },
  { id: 101, postId: 10, authorId: 3, body: "Agreed", createdAt: at("2026-03-02T00:00:00.000Z") },
  { id: 102, postId: 12, authorId: null, body: "Anonymous", createdAt: at("2026-03-03T00:00:00.000Z") },
];

const PROFILES = [{ id: 1000, userId: 1, bio: "Analyst", avatarUrl: null }];

const ORGS = [
  { id: ORG_A, name: "Engines Ltd" },
  { id: ORG_B, name: "Compilers Inc" },
];

const MEMBERSHIPS = [
  { orgId: ORG_A, userId: 1, role: "owner" },
  { orgId: ORG_A, userId: 2, role: "member" },
  { orgId: ORG_B, userId: 2, role: "admin" },
];

/** A table the stream test fills with many rows. */
class StreamRow extends Schema("stream_rows", {
  id: t.integer().primaryKey(),
  label: t.string(),
}) {}

/** A table with a composite key, filled with many rows for `reload`. */
class Pair extends Schema("pairs", {
  a: t.integer().primaryKey(),
  b: t.string().primaryKey(),
}) {}

/** A schema without a primary key. */
class Note extends Schema(
  "notes",
  {
    body: t.string(),
  },
  { primaryKey: false },
) {}

/** Inserts rows through the adapter, each value converted as the repo would write it. */
async function insertRows(
  adapter: DatabaseAdapter,
  profile: ReadConformanceProfile,
  schema: AnySchema,
  rows: readonly Readonly<Record<string, unknown>>[],
  table: string = profile.quoteIdentifier(meta(schema).source as string),
): Promise<void> {
  const schemaMeta = meta(schema);
  for (const row of rows) {
    const names = Object.keys(row);
    const fields = names.map((name) => {
      const field = schemaMeta.fieldsByName.get(name);
      if (field === undefined) throw new Error(`${schemaMeta.name} has no field ${name}`);
      return field;
    });
    const values = fields.map((field) => {
      const value = row[field.name];
      return value === null ? null : resolveCodec(field.type, adapter).toDb(value);
    });
    const placeholders = names.map((_, i) => profile.param(i + 1));
    await adapter.execute(
      `insert into ${table} (${fields.map((field) => profile.quoteIdentifier(field.column)).join(", ")}) values (${placeholders.join(", ")})`,
      values,
    );
  }
}

/** The plain field values of a row, for comparing with the data set. */
function fieldsOf(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row as object)) out[key] = (row as Record<string, unknown>)[key];
  // An embed reads back as a row of its embedded class (step 15): compared by its fields.
  if (out.settings instanceof UserSettings) out.settings = Object.fromEntries(Object.entries(out.settings));
  return out;
}

function expectUser(row: unknown, expected: (typeof USERS)[number]): void {
  expect(row).toBeInstanceOf(User);
  expect(fieldsOf(row)).toEqual({ ...expected, password: undefined });
}

/**
 * Runs the read conformance suite for one adapter. Call it at the top level of an
 * `*.itest.ts` file; it creates and drops a test database of its own.
 */
export function runReadConformance(profile: ReadConformanceProfile): void {
  describe(`read conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let db: TestDatabase;
    const adapters: DatabaseAdapter[] = [];
    const repos: Repo[] = [];

    function adapter(options: Partial<MakeReadAdapterOptions> = {}): DatabaseAdapter {
      const made = profile.makeAdapter(db, { poolMax: options.poolMax ?? 4 });
      adapters.push(made);
      return made;
    }

    function repo(options: Partial<RepoOptions> & Partial<MakeReadAdapterOptions> = {}): Repo {
      const { poolMax, ...rest } = options;
      const made = createRepo({
        adapter: rest.adapter ?? adapter(poolMax === undefined ? {} : { poolMax }),
        ...rest,
      });
      repos.push(made);
      return made;
    }

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "read", fixtures: ["blog"] });
      db = handle.db;
      // The profile's text type: a key column cannot be `text` on every database.
      const text = profile.columnType(stringType() as AnyFieldType) as string;
      await db.exec(`create table stream_rows (id integer primary key, label ${text} not null)`);
      await db.exec(`create table notes (body ${text} not null)`);
      await db.exec(`create table pairs (a integer not null, b ${text} not null, primary key (a, b))`);
      const seeding = profile.makeAdapter(db, { poolMax: 1 });
      try {
        await insertRows(seeding, profile, User, USERS);
        await insertRows(seeding, profile, Post, POSTS);
        await insertRows(seeding, profile, Comment, COMMENTS);
        await insertRows(seeding, profile, Profile, PROFILES);
        await insertRows(seeding, profile, Org, ORGS);
        await insertRows(seeding, profile, Membership, MEMBERSHIPS);
        await insertRows(seeding, profile, Note, [{ body: "first" }, { body: "second" }]);
        await db.exec(profile.insertSeries(50_000));
        await db.exec(profile.insertPairs(3_000));
      } finally {
        await seeding.close();
      }
    });

    afterEach(async () => {
      repos.splice(0);
      for (const each of adapters.splice(0)) {
        // Every connection a test checked out must be back by the time it ends.
        await eventually(() => checkedOut(each.poolStats()) === 0);
        await each.close();
      }
    });

    afterAll(async () => {
      const drop = handle === undefined ? undefined : profile.dropCopies?.(handle.db);
      if (drop !== undefined) await handle?.db.exec(drop);
      await handle?.drop();
    });

    describe("all", () => {
      test("a schema class reads every row, as instances of the class with their getters", async () => {
        const users = await repo().all(from(User, "u").orderBy(({ u }) => u.id));
        expect(users).toHaveLength(4);
        users.forEach((user, i) => {
          expectUser(user, USERS[i] as (typeof USERS)[number]);
        });
        expect(users[1]?.displayName).toBe("grace@example.com");
        expect((await repo().all(User)).map((user) => user.id).sort()).toEqual([1, 2, 3, 4]);
      });

      test("every row is marked loaded from its table, sharing one frozen marker", async () => {
        const users = await repo().all(User);
        const marker = (users[0] as unknown as { [ROW]: unknown })[ROW];
        expect(marker).toEqual({ state: "loaded", source: "users", schema: undefined });
        expect(Object.isFrozen(marker)).toBe(true);
        for (const user of users) {
          expect(isRow(user)).toBe(true);
          expect(stateOf(user)).toBe("loaded");
          expect((user as unknown as { [ROW]: unknown })[ROW]).toBe(marker);
        }
        // The marker is not an enumerable key.
        expect(Object.keys(users[0] as object)).not.toContain(ROW);
      });

      test("each call returns a fresh array of fresh rows", async () => {
        const r = repo();
        const q = from(User, "u").where({ id: 1 });
        const a = await r.all(q);
        a.push(a[0] as User);
        (a[0] as { name: string | null }).name = "changed";
        const b = await r.all(q);
        expect(b).toHaveLength(1);
        expect(b[0]?.name).toBe("Ada");
        expect(b[0]).not.toBe(a[0]);
      });

      test("a query with no matching row returns an empty array", async () => {
        expect(await repo().all(from(User, "u").where({ email: "nobody@example.com" }))).toEqual([]);
      });

      test("where, orderBy, limit and offset", async () => {
        const r = repo();
        const q = from(User, "u").orderBy(({ u }) => u.createdAt.desc());
        expect((await r.all(q.limit(2))).map((user) => user.id)).toEqual([4, 3]);
        expect((await r.all(q.limit(2).offset(1))).map((user) => user.id)).toEqual([3, 2]);
        expect((await r.all(q.offset(3))).map((user) => user.id)).toEqual([1]);
        expect(
          (
            await r.all(
              from(User, "u")
                .where(({ u }) => u.age.gte(18))
                .orderBy(({ u }) => u.age),
            )
          ).map((user) => user.id),
        ).toEqual([1, 2]);
        const nullsFirst = from(User, "u").orderBy(({ u }) => u.age.asc().nullsFirst());
        if (!adapter().capabilities.nullsOrder) {
          // NULLS FIRST is refused when the query is compiled (capability nullsOrder).
          await expect(r.all(nullsFirst)).rejects.toThrow(QueryError);
          return;
        }
        expect((await r.all(nullsFirst)).map((user) => user.id)).toEqual([3, 4, 1, 2]);
      });

      test("like with an escaped % or _ matches the character itself", async () => {
        const text = (value: string) => val(value, t.string());
        const [row] = await repo().all(
          from(User, "u")
            .where({ id: 1 })
            .select(() => ({
              percent: text("100%").like("100\\%"),
              notPercent: text("1000").like("100\\%"),
              underscore: text("1_3").like("1\\_3"),
              notUnderscore: text("123").like("1\\_3"),
              wildcard: text("1000").like("100%"),
            })),
        );
        expect(row).toEqual({
          percent: true,
          notPercent: false,
          underscore: true,
          notUnderscore: false,
          wildcard: true,
        });
      });

      test("distinct", async () => {
        const roles = await repo().all(
          from(User, "u")
            .distinct()
            .select(({ u }) => u.role)
            .orderBy(({ u }) => u.role),
        );
        expect(roles).toEqual(["admin", "member"]);
      });

      test("a database error passes through normalised", async () => {
        const r = repo();
        const error = await rejection(r.raw(fragment`select * from no_such_table`));
        expect(error).toBeInstanceOf(DatabaseError);
      });
    });

    describe("select shapes", () => {
      test("one expression is the value itself", async () => {
        const emails = await repo().all(
          from(User, "u")
            .select(({ u }) => u.email)
            .orderBy(({ u }) => u.id),
        );
        expect(emails).toEqual(USERS.map((user) => user.email));
      });

      test("an object, with its keys in order, nulls passed through", async () => {
        const rows = await repo().all(
          from(User, "u")
            .select(({ u }) => ({ name: u.name, id: u.id, createdAt: u.createdAt }))
            .orderBy(({ u }) => u.id)
            .limit(2),
        );
        expect(rows).toEqual([
          { name: "Ada", id: 1, createdAt: USERS[0]?.createdAt },
          { name: null, id: 2, createdAt: USERS[1]?.createdAt },
        ]);
        expect(Object.keys(rows[0] as object)).toEqual(["name", "id", "createdAt"]);
        expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
      });

      test("a tuple, a nested object, a constant and an aggregate", async () => {
        const rows = await repo().all(
          from(User, "u")
            .where({ id: 1 })
            .select(({ u }) => ({
              pair: [u.id, u.email],
              nested: { role: u.role, settings: u.settings },
              kind: "person",
              count: val(2, t.integer()),
            })),
        );
        expect(rows).toEqual([
          {
            pair: [1, "ada@example.com"],
            nested: {
              role: "admin",
              settings: expect.objectContaining({ theme: "dark", emailNotifications: false }),
            },
            kind: "person",
            count: 2,
          },
        ]);
      });

      test("a whole binding inside an object is a row of its schema", async () => {
        const rows = await repo().all(
          from(Post, "p")
            .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
            .where(({ p }) => p.id.eq(12))
            .select(({ p, u }) => ({ post: p, author: u, title: p.title })),
        );
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.post).toBeInstanceOf(Post);
        expect(fieldsOf(row?.post)).toEqual(POSTS[2]);
        expectUser(row?.author, USERS[1] as (typeof USERS)[number]);
        expect(row?.title).toBe("Compilers, briefly");
      });

      test("an untyped string selects as text, a typed value as its type", async () => {
        const [row] = await repo().all(
          from(User, "u")
            .where({ id: 1 })
            .select(() => ({
              text: val("x"),
              number: val(7, t.integer()),
              when: val(USERS[0]?.createdAt as Date, t.timestamp()),
            })),
        );
        expect(row).toEqual({ text: "x", number: 7, when: USERS[0]?.createdAt });
      });

      test("aggregates in a grouped select", async () => {
        const rows = await repo().all(
          from(User, "u")
            .leftJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id))
            .groupBy(({ u }) => u.id)
            .orderBy(({ u }) => u.id)
            .select(({ u, p }) => ({
              id: u.id,
              posts: count(p.id),
              views: sum(p.views),
              avg: avg(p.views),
              last: max(p.createdAt),
            })),
        );
        expect(rows).toEqual([
          { id: 1, posts: 2, views: 120, avg: 60, last: POSTS[1]?.createdAt },
          { id: 2, posts: 1, views: 45, avg: 45, last: POSTS[2]?.createdAt },
          { id: 3, posts: 0, views: null, avg: null, last: null },
          { id: 4, posts: 0, views: null, avg: null, last: null },
        ]);
      });
    });

    describe("joins and null handling", () => {
      test("an inner join keeps matching rows only", async () => {
        const rows = await repo().all(
          from(User, "u")
            .join(Post, "p", ({ u, p }) => p.authorId.eq(u.id))
            .orderBy(({ p }) => p.id)
            .select(({ u, p }) => [u.id, p.id]),
        );
        expect(rows).toEqual([
          [1, 10],
          [1, 11],
          [2, 12],
        ]);
      });

      test("a left join gives null for a missing row and for its columns", async () => {
        const rows = await repo().all(
          from(User, "u")
            .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
            .orderBy(({ u }) => u.id)
            .select(({ u, pr }) => ({ id: u.id, profile: pr, bio: pr.bio })),
        );
        expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4]);
        expect(rows[0]?.profile).toBeInstanceOf(Profile);
        expect(fieldsOf(rows[0]?.profile)).toEqual(PROFILES[0]);
        expect(rows[0]?.bio).toBe("Analyst");
        for (const row of rows.slice(1)) {
          expect(row.profile).toBeNull();
          expect(row.bio).toBeNull();
        }
      });

      test("a left-joined row whose own columns are null is still a row when its key is not", async () => {
        const rows = await repo().all(
          from(Post, "p")
            .leftJoin(Comment, "c", ({ p, c }) => c.postId.eq(p.id))
            .where(({ p }) => p.id.eq(12))
            .select(({ c }) => c),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toBeInstanceOf(Comment);
        expect(rows[0]?.authorId).toBeNull();
      });

      test("a right join makes the root nullable", async () => {
        const rows = await repo().all(
          from(Profile, "pr")
            .rightJoin(User, "u", ({ pr, u }) => pr.userId.eq(u.id))
            .orderBy(({ u }) => u.id)
            .select(({ pr, u }) => ({ profile: pr, user: u.id })),
        );
        expect(rows.map((row) => [row.user, row.profile === null])).toEqual([
          [1, false],
          [2, true],
          [3, true],
          [4, true],
        ]);
      });

      test("a full join makes both sides nullable", async (context) => {
        if (!adapter().capabilities.fullJoin) return context.skip("capability fullJoin is false");
        // The order is the database's own: NULLS LAST where the database can say so (where
        // NULL sorts by default differs: last on Postgres, first on SQLite and MySQL).
        const joined = from(Post, "p").fullJoin(Comment, "c", ({ p, c }) =>
          c.postId.eq(p.id).and(c.authorId.eq(2)),
        );
        const ordered = adapter().capabilities.nullsOrder
          ? joined.orderBy(({ p, c }) => [p.id.asc().nullsLast(), c.id.asc().nullsLast()])
          : joined.orderBy(({ p, c }) => [p.id.isNull(), p.id, c.id.isNull(), c.id]);
        const rows = await repo().all(ordered.select(({ p, c }) => ({ post: p.id, comment: c })));
        const pairs = rows.map((row) => [row.post, row.comment?.id ?? null] as const);
        expect(pairs).toEqual([
          [10, 100],
          [11, null],
          [12, null],
          [null, 101],
          [null, 102],
        ]);
      });

      test("a cross join pairs every row", async () => {
        const rows = await repo().all(
          from(Org, "o")
            .crossJoin(Org, "o2")
            .select(({ o, o2 }) => [o.name, o2.name]),
        );
        expect(rows).toHaveLength(4);
      });

      test("joinAssoc follows an association", async () => {
        const rows = await repo().all(
          from(User, "u")
            .joinAssoc("u", "posts", "p")
            .where(({ p }) => p.published)
            .orderBy(({ p }) => p.id)
            .select(({ u, p }) => ({ email: u.email, title: p.title })),
        );
        expect(rows).toEqual([
          { email: "ada@example.com", title: "Notes on the engine" },
          { email: "grace@example.com", title: "Compilers, briefly" },
        ]);
      });
    });

    describe("logical types read back through real columns", () => {
      const cases = ROUND_TRIP_CASES.filter((each) => profile.columnType(each.type) !== undefined);
      test.for(cases.map((each, index) => ({ ...each, index })))(
        "$label",
        async ({ type, values, index, requires }, { skip }) => {
          const table = `rt_${index}`;
          if (requires !== undefined && !adapter().capabilities[requires]) {
            return skip(`capability ${requires} is false`);
          }
          const columnType = profile.columnType(type) as string;
          await db.exec(`create table ${table} (id integer primary key, value ${columnType})`);
          class Sample extends Schema(table, {
            id: t.integer().primaryKey(),
            value: t.type(type).nullable(),
          }) {}
          const r = repo();
          await insertRows(
            adapters[adapters.length - 1] as DatabaseAdapter,
            profile,
            Sample,
            values.map((value, i) => ({ id: i + 1, value })),
          );
          const rows = await r.all(from(Sample, "s").orderBy(({ s }) => s.id));
          const selected = await r.all(
            from(Sample, "s")
              .orderBy(({ s }) => s.id)
              .select(({ s }) => s.value),
          );
          expect(rows).toHaveLength(values.length);
          values.forEach((value, i) => {
            const read = (rows[i] as { value: unknown }).value;
            const alone = selected[i];
            if (value === null) {
              expect(read).toBeNull();
              expect(alone).toBeNull();
            } else {
              expect(type.equal(read, value), `${String(read)} read for ${String(value)}`).toBe(true);
              expect(type.equal(alone, value)).toBe(true);
            }
          });
        },
      );

      test("an embedded schema's column reads back as its object", async () => {
        const ada = await repo().getOrThrow(User, 1);
        expect(ada.settings).toBeInstanceOf(UserSettings);
        expect(ada.settings).toMatchObject({ theme: "dark", emailNotifications: false });
      });
    });

    describe("one, oneOrThrow and first over 0, 1 and many rows", () => {
      const none = from(User, "u").where({ email: "nobody@example.com" });
      const exactly = from(User, "u").where({ email: "ada@example.com" });
      const several = from(User, "u").where({ role: "member" });

      test("one", async () => {
        const r = repo();
        expect(await r.one(none)).toBeNull();
        expectUser(await r.one(exactly), USERS[0] as (typeof USERS)[number]);
        const error = await rejection(r.one(several));
        expect(error).toBeInstanceOf(MultipleResultsError);
        expect((error as MultipleResultsError).count).toBe(3);
        expect((error as MultipleResultsError).query).toBe(several.toString());
      });

      test("one adds no limit", async () => {
        const r = repo();
        const events: RepoQueryEvent[] = [];
        r.on("query", (event) => events.push(event));
        await r.one(exactly);
        expect(events[0]?.sql).not.toContain("limit");
      });

      test("oneOrThrow", async () => {
        const r = repo();
        const error = await rejection(r.oneOrThrow(none));
        expect(error).toBeInstanceOf(NoResultsError);
        expect((error as NoResultsError).query).toBe(none.toString());
        expect((await r.oneOrThrow(exactly)).email).toBe("ada@example.com");
        expect(await rejection(r.oneOrThrow(several))).toBeInstanceOf(MultipleResultsError);
      });

      test("first never returns more than the query's own limit allows", async () => {
        const r = repo();
        const ordered = from(User, "u").orderBy(({ u }) => u.id);
        expect(await r.first(ordered.limit(0))).toBeNull();
        expect((await r.first(ordered.limit(5)))?.id).toBe(1);
        expect((await r.first(ordered.limit(5).offset(2)))?.id).toBe(3);
        expect((await r.first(ordered))?.id).toBe(1);
        const paged = ordered.limit(param("size", t.integer()));
        if (!adapter().capabilities.limitExpressions) {
          // The limit of first() is then an expression, refused when compiled (capability limitExpressions).
          await expect(r.first(paged, { size: 0 })).rejects.toThrow(QueryError);
          return;
        }
        expect(await r.first(paged, { size: 0 })).toBeNull();
        expect((await r.first(paged, { size: 3 }))?.id).toBe(1);
      });

      test("first takes the large limits all takes", async () => {
        const r = repo();
        const ordered = from(User, "u").orderBy(({ u }) => u.id);
        const huge = ordered.limit(Number.MAX_SAFE_INTEGER);
        expect(await r.all(huge)).toHaveLength(4);
        expect((await r.first(huge))?.id).toBe(1);
        const big = ordered.limit(param("size", t.bigint({ mode: "number" })));
        if (!adapter().capabilities.limitExpressions) {
          // As above: a named limit makes the limit of first() an expression.
          await expect(r.first(big, { size: 0 })).rejects.toThrow(QueryError);
          return;
        }
        expect((await r.first(big, { size: 5_000_000_000 }))?.id).toBe(1);
        expect(await r.first(big, { size: 0 })).toBeNull();
      });

      test("first", async () => {
        const r = repo();
        expect(await r.first(none)).toBeNull();
        expect((await r.first(exactly))?.id).toBe(1);
        expect((await r.first(several.orderBy(({ u }) => u.id.desc())))?.id).toBe(4);
        // Its own limit is replaced; its offset is kept.
        expect(
          (
            await r.first(
              several
                .orderBy(({ u }) => u.id)
                .limit(3)
                .offset(1),
            )
          )?.id,
        ).toBe(3);
      });
    });

    describe("get and getBy", () => {
      test("get by a scalar key", async () => {
        const r = repo();
        expectUser(await r.get(User, 2), USERS[1] as (typeof USERS)[number]);
        expect(await r.get(User, 999)).toBeNull();
        expect((await r.getOrThrow(User, 3)).email).toBe("linus@example.com");
        expect(await rejection(r.getOrThrow(User, 999))).toBeInstanceOf(NoResultsError);
      });

      test("get by a uuid key", async () => {
        const org = await repo().get(Org, ORG_B);
        expect(org).toBeInstanceOf(Org);
        expect(org?.name).toBe("Compilers Inc");
      });

      test("get by a composite key", async () => {
        const r = repo();
        const membership = await r.get(Membership, { orgId: ORG_A, userId: 2 });
        expect(fieldsOf(membership)).toEqual({ orgId: ORG_A, userId: 2, role: "member" });
        expect(await r.get(Membership, { orgId: ORG_B, userId: 1 })).toBeNull();
      });

      test("get refuses a missing id and a wrong id shape before running anything", async () => {
        const r = repo();
        const events: RepoQueryEvent[] = [];
        r.on("query", (event) => events.push(event));
        await expect(r.get(User, undefined as never)).rejects.toThrow(QueryError);
        await expect(r.get(User, null as never)).rejects.toThrow(/missing value/);
        await expect(r.get(Membership, { orgId: ORG_A } as never)).rejects.toThrow(QueryError);
        await expect(r.get(User, { id: 1 } as never)).rejects.toThrow(QueryError);
        await expect(r.get(Note, "x" as never)).rejects.toThrow(/no primary key/);
        await expect(r.get(User, [1, 2] as never)).rejects.toThrow(/given an array/);
        expect(events).toEqual([]);
      });

      test("getBy is strict, like one", async () => {
        const r = repo();
        expect((await r.getBy(User, { email: "grace@example.com" }))?.id).toBe(2);
        expect(await r.getBy(User, { email: "nobody@example.com" })).toBeNull();
        expect(await rejection(r.getBy(User, { role: "member" }))).toBeInstanceOf(MultipleResultsError);
        expect(
          (
            await r.getBy(
              from(User, "u").where(({ u }) => u.age.gte(18)),
              { role: "member" },
            )
          )?.id,
        ).toBe(2);
        expect(await rejection(r.getByOrThrow(User, { email: "nobody@example.com" }))).toBeInstanceOf(
          NoResultsError,
        );
        expect((await r.getByOrThrow(Membership, { orgId: ORG_B })).role).toBe("admin");
      });

      test("getBy with null matches a null column", async () => {
        expect((await repo().getBy(User, { age: null }))?.id).toBe(3);
      });
    });

    describe("exists, count and aggregate", () => {
      test("exists", async () => {
        const r = repo();
        expect(await r.exists(User)).toBe(true);
        expect(await r.exists(from(User, "u").where({ email: "nobody@example.com" }))).toBe(false);
        expect(
          await r.exists(
            from(User, "u")
              .orderBy(({ u }) => u.email)
              .select(({ u }) => u.email),
          ),
        ).toBe(true);
        // A limit of its own is honoured: the query is wrapped, not given another limit.
        expect(await r.exists(from(User, "u").limit(0))).toBe(false);
        expect(await r.exists(from(User, "u").offset(3))).toBe(true);
        expect(await r.exists(from(User, "u").offset(4))).toBe(false);
      });

      test("exists keeps distinct when an offset depends on it", async () => {
        const r = repo();
        // Four users, two distinct roles.
        const roles = from(User, "u")
          .distinct()
          .select(({ u }) => u.role);
        expect(await r.exists(roles.offset(1))).toBe(true);
        expect(await r.exists(roles.offset(2))).toBe(false);
        const firstPerRole = from(User, "u")
          .distinct(({ u }) => [u.role])
          .orderBy(({ u }) => [u.role, u.id]);
        if (!adapter().capabilities.distinctOn) {
          // DISTINCT ON is refused when the query is compiled (capability distinctOn).
          await expect(r.exists(firstPerRole.offset(1))).rejects.toThrow(QueryError);
          return;
        }
        expect(await r.exists(firstPerRole.offset(1))).toBe(true);
        expect(await r.exists(firstPerRole.offset(2))).toBe(false);
      });

      test("exists over a select that aggregates is true even over no rows", async () => {
        const nobody = from(User, "u").where({ email: "nobody@example.com" });
        expect(await repo().exists(nobody.select(() => ({ n: count() })))).toBe(true);
        expect(await repo().exists(nobody)).toBe(false);
      });

      test("count", async () => {
        const r = repo();
        expect(await r.count(User)).toBe(4);
        expect(await r.count(from(Post, "p").where({ published: true }))).toBe(2);
        expect(await r.count(from(Post, "p").where({ title: "none" }))).toBe(0);
        // The select and the order do not matter.
        expect(
          await r.count(
            from(User, "u")
              .orderBy(({ u }) => u.email)
              .select(({ u }) => u.email),
          ),
        ).toBe(4);
      });

      test("count of a query with a limit, an offset, distinct or groupBy counts its rows", async () => {
        const r = repo();
        expect(await r.count(from(User, "u").limit(2))).toBe(2);
        expect(await r.count(from(User, "u").offset(3))).toBe(1);
        expect(
          await r.count(
            from(User, "u")
              .distinct()
              .select(({ u }) => u.role),
          ),
        ).toBe(2);
        expect(
          await r.count(
            from(Post, "p")
              .groupBy(({ p }) => p.authorId)
              .select(({ p }) => ({ authorId: p.authorId, n: count() })),
          ),
        ).toBe(2);
      });

      test("aggregate over a field", async () => {
        const r = repo();
        expect(await r.aggregate(Post, "sum", "views")).toBe(165);
        expect(await r.aggregate(Post, "avg", "views")).toBe(55);
        expect(await r.aggregate(Post, "min", "views")).toBe(0);
        expect(await r.aggregate(Post, "max", "createdAt")).toEqual(POSTS[1]?.createdAt);
        expect(await r.aggregate(User, "count", "age")).toBe(3);
        expect(await r.aggregate(from(Post, "p").where({ published: true }), "sum", "views")).toBe(165);
        expect(
          await r.aggregate(
            from(Post, "p")
              .orderBy(({ p }) => p.views.desc())
              .limit(2),
            "sum",
            "views",
          ),
        ).toBe(165);
        expect(
          await r.aggregate(
            from(Post, "p")
              .orderBy(({ p }) => p.views)
              .limit(2),
            "sum",
            "views",
          ),
        ).toBe(45);
      });

      test("a locked query is counted through a subquery", async () => {
        const r = repo();
        expect(await r.count(from(User, "u").lock("update"))).toBe(4);
        expect(await r.aggregate(from(Post, "p").lock("share"), "sum", "views")).toBe(165);
      });

      test("a wrapped aggregate reads the field's column, not a key that merely has its name", async () => {
        const r = repo();
        const limited = from(Post, "p")
          .orderBy(({ p }) => p.id)
          .limit(3);
        expect(
          await r.aggregate(
            limited.select(({ p }) => ({ views: p.views })),
            "sum",
            "views",
          ),
        ).toBe(165);
        await expect(
          r.aggregate(
            limited.select(({ p }) => ({ views: p.id })),
            "sum",
            "views",
          ),
        ).rejects.toThrow(QueryError);
        await expect(
          r.aggregate(
            from(Post, "p")
              .groupBy(({ p }) => p.authorId)
              .select(() => ({ views: count() })),
            "max",
            "views",
          ),
        ).rejects.toThrow(QueryError);
      });

      test("a count over a select that aggregates counts its one row", async () => {
        expect(await repo().count(from(User, "u").select(() => ({ n: count() })))).toBe(1);
      });

      test("aggregates over an empty set: count is 0, the others null", async () => {
        const r = repo();
        const empty = from(Post, "p").where({ title: "none" });
        expect(await r.aggregate(empty, "count")).toBe(0);
        expect(await r.aggregate(empty, "count", "views")).toBe(0);
        expect(await r.aggregate(empty, "sum", "views")).toBeNull();
        expect(await r.aggregate(empty, "avg", "views")).toBeNull();
        expect(await r.aggregate(empty, "min", "views")).toBeNull();
        expect(await r.aggregate(empty, "max", "publishedAt")).toBeNull();
        expect(await r.aggregate(empty.limit(5), "sum", "views")).toBeNull();
      });
    });

    describe("preloads", () => {
      // The getting-started guide shows this query (the preload conformance suite covers
      // preloads in full).
      test("a query that preloads returns rows with their associations", async () => {
        const users = await repo().all(
          from(User, "u")
            .preload("posts")
            .orderBy(({ u }) => u.id),
        );
        expect(users[0]?.posts.map((post) => post.id)).toEqual([10, 11]);
      });
    });

    describe("named parameters", () => {
      const adults = from(User, "u")
        .where(({ u }) => u.age.gte(param("minAge", t.integer())))
        .orderBy(({ u }) => u.id);

      test("are passed as the second argument, options third", async () => {
        const r = repo();
        expect((await r.all(adults, { minAge: 18 })).map((user) => user.id)).toEqual([1, 2]);
        expect((await r.all(adults, { minAge: 50 }, { timeoutMs: 5_000 })).map((user) => user.id)).toEqual([
          2,
        ]);
        expect((await r.one(adults, { minAge: 80 }))?.id).toBe(2);
        expect((await r.first(adults, { minAge: 0 }))?.id).toBe(1);
        expect(await r.count(adults, { minAge: 18 })).toBe(2);
        expect(await r.exists(adults, { minAge: 100 })).toBe(false);
        expect(await r.aggregate(adults, "max", "age", { minAge: 0 })).toBe(85);
      });

      test("a missing named parameter is an error that names it", async () => {
        await expect(repo().all(adults, {} as never)).rejects.toThrow(/minAge/);
      });
    });

    describe("stream", () => {
      test("streams 50,000 rows in batches and decodes them", async () => {
        const r = repo();
        let n = 0;
        let last = 0;
        for await (const row of r.stream(
          from(StreamRow, "s").orderBy(({ s }) => s.id),
          { batchSize: 2_000 },
        )) {
          expect(row).toBeInstanceOf(StreamRow);
          last = row.id;
          n++;
        }
        expect(n).toBe(50_000);
        expect(last).toBe(50_000);
      });

      test("leaving the loop early closes the cursor and returns the connection", async () => {
        const a = adapter({ poolMax: 1 });
        const r = repo({ adapter: a });
        const seen: number[] = [];
        for await (const row of r.stream(
          from(StreamRow, "s").orderBy(({ s }) => s.id),
          { batchSize: 100 },
        )) {
          seen.push(row.id);
          if (seen.length === 250) break;
        }
        expect(seen[249]).toBe(250);
        expect(checkedOut(a.poolStats())).toBe(0);
        // The only connection is free again.
        expect(await r.count(StreamRow)).toBe(50_000);
      });

      test("a stream works without a transaction and with select shapes", async () => {
        const labels: string[] = [];
        for await (const label of repo().stream(
          from(StreamRow, "s")
            .where(({ s }) => s.id.lte(3))
            .orderBy(({ s }) => s.id)
            .select(({ s }) => s.label),
        )) {
          labels.push(label);
        }
        expect(labels).toEqual(["row 1", "row 2", "row 3"]);
      });

      test("a stream refuses preloads", async () => {
        const iterate = async (): Promise<void> => {
          for await (const _ of repo().stream(from(User, "u").preload("posts"))) {
            // never reached
          }
        };
        await expect(iterate()).rejects.toThrow(/cannot preload/);
      });
    });

    describe("reload", () => {
      test("a fresh copy, and null for a row that is gone", async () => {
        const r = repo();
        const users = await r.all(from(User, "u").orderBy(({ u }) => u.id));
        const fresh = await r.reload(users[0] as User);
        expect(fresh).not.toBe(users[0]);
        expectUser(fresh, USERS[0] as (typeof USERS)[number]);
        const reordered = await r.reload([users[2] as User, users[0] as User]);
        expect(reordered.map((user) => user?.id)).toEqual([3, 1]);
      });

      test("rows that were deleted come back null, in place", async () => {
        const r = repo();
        await db.exec("insert into tags (id, name) values (900, 'gone'), (901, 'kept')");
        const tags = await r.all(
          from(Tag, "g")
            .where(({ g }) => g.id.in([900, 901]))
            .orderBy(({ g }) => g.id),
        );
        await db.exec("delete from tags where id = 900");
        const fresh = await r.reload(tags);
        expect(fresh.map((tag) => (tag as { id: number } | null)?.id ?? null)).toEqual([null, 901]);
        expect(await r.reload(tags[0] as object)).toBeNull();
        expect(await rejection(r.reloadOrThrow(tags))).toBeInstanceOf(NoResultsError);
      });

      test("thousands of rows with a composite key, in place, with gone rows null", async () => {
        const r = repo();
        const pairs = await r.all(from(Pair, "p").orderBy(({ p }) => p.a));
        expect(pairs).toHaveLength(3_000);
        await db.exec("delete from pairs where a in (10, 2000)");
        const reversed = [...pairs].reverse();
        const fresh = await r.reload(reversed);
        expect(fresh).toHaveLength(3_000);
        expect(fresh.filter((each) => each === null)).toHaveLength(2);
        fresh.forEach((each, i) => {
          const given = reversed[i] as Pair;
          if (given.a === 10 || given.a === 2000) expect(each).toBeNull();
          else expect(each).toEqual(given);
        });
      });

      describe("keys compared by content", () => {
        class Blob extends Schema("rt_blob_keys", { id: t.binary().primaryKey(), n: t.integer() }) {}
        class Path extends Schema("rt_path_keys", {
          path: t.array(t.string()).primaryKey(),
          n: t.integer(),
        }) {}
        class Tagged extends Schema("rt_tagged_keys", {
          a: t.integer().primaryKey(),
          tags: t.array(t.string()).primaryKey(),
          n: t.integer(),
        }) {}

        async function create(
          schema: AnySchema,
          rows: readonly Readonly<Record<string, unknown>>[],
        ): Promise<void> {
          const schemaMeta = meta(schema);
          const q = profile.quoteIdentifier;
          const columns = schemaMeta.persisted.map(
            (field) => `${q(field.column)} ${profile.columnType(field.type) as string} not null`,
          );
          const key = schemaMeta.primaryKey.map((field) => q(field.column)).join(", ");
          await db.exec(
            `create table ${q(schemaMeta.source as string)} (${columns.join(", ")}, primary key (${key}))`,
          );
          await insertRows(adapter(), profile, schema, rows);
        }

        /** A key value with private state: nothing but its own conversions can read it. */
        class Code {
          readonly #value: string;
          constructor(value: string) {
            this.#value = value;
          }
          get value(): string {
            return this.#value;
          }
        }
        const codeType = defineType<Code, string>({
          name: "code",
          db: { kind: "text" },
          cast: (input) => (input instanceof Code ? { success: true, data: input } : { success: false }),
          fromDb: (stored) => new Code(stored),
          toDb: (code) => code.value,
          equal: (a, b) => a.value === b.value,
        });
        class Coded extends Schema("rt_coded_keys", { id: t.type(codeType).primaryKey(), n: t.integer() }) {}
        class Priced extends Schema("rt_priced_keys", { id: t.decimal().primaryKey(), n: t.integer() }) {}
        class Labelled extends Schema("rt_labelled_keys", {
          a: t.string().primaryKey(),
          b: t.string().primaryKey(),
          n: t.integer(),
        }) {}

        test("a key of a custom type with private state", async () => {
          await create(Coded, [
            { id: new Code("100"), n: 1 },
            { id: new Code("200"), n: 2 },
            { id: new Code("300"), n: 3 },
          ]);
          const r = repo();
          const coded = await r.all(from(Coded, "c").orderBy(({ c }) => c.n));
          expect((await r.reloadOrThrow(coded)).map((each) => each.n)).toEqual([1, 2, 3]);
          expect((await r.reload([...coded].reverse())).map((each) => each?.id.value)).toEqual([
            "300",
            "200",
            "100",
          ]);
          expect((await r.get(Coded, new Code("200")))?.n).toBe(2);
        });

        test("a decimal key whose scale changed is still the same key", async (context) => {
          if (!adapter().capabilities.exactDecimals) return context.skip("capability exactDecimals is false");
          await create(Priced, [{ id: "1.0", n: 1 }]);
          const r = repo();
          const [priced] = await r.all(Priced);
          expect(priced?.id).toBe("1.0");
          await db.exec("update rt_priced_keys set id = 1.00");
          const fresh = await r.reloadOrThrow(priced as Priced);
          expect(fresh.id).toBe("1.00");
          expect((await r.get(Priced, "1.000"))?.n).toBe(1);
        });

        test("composite text keys that would run together", async () => {
          await create(Labelled, [
            { a: "as:", b: "b", n: 1 },
            { a: "a", b: "s:b", n: 2 },
            { a: "a,b", b: "", n: 3 },
            { a: "a", b: ",b", n: 4 },
          ]);
          const r = repo();
          const labelled = await r.all(from(Labelled, "l").orderBy(({ l }) => l.n));
          expect((await r.reloadOrThrow(labelled)).map((each) => each.n)).toEqual([1, 2, 3, 4]);
          await db.exec("delete from rt_labelled_keys where n in (1, 3)");
          expect((await r.reload(labelled)).map((each) => each?.n ?? null)).toEqual([null, 2, null, 4]);
        });

        test("a timestamp key with microseconds is not found: a Date holds milliseconds (known limit)", async (context) => {
          const column = profile.microsecondTimestamp;
          if (column === undefined) return context.skip("no microsecond timestamps");
          class Moment extends Schema("rt_moment_keys", { at: t.timestamp().primaryKey(), n: t.integer() }) {}
          await db.exec(`create table rt_moment_keys (at ${column} primary key, n integer not null)`);
          await db.exec(
            "insert into rt_moment_keys values ('2026-01-01 00:00:00.123456+00:00', 1), ('2026-01-01 00:00:00.5+00:00', 2)",
          );
          const r = repo();
          const moments = await r.all(from(Moment, "m").orderBy(({ m }) => m.n));
          expect((await r.reload(moments)).map((each) => each?.n ?? null)).toEqual([null, 2]);
        });

        test("tables named like the list of keys", async () => {
          class K extends Schema("k", { id: t.integer().primaryKey(), k0: t.integer() }) {}
          class Keys extends Schema("keys", { position: t.integer().primaryKey(), n: t.integer() }) {}
          await create(K, [
            { id: 1, k0: 10 },
            { id: 2, k0: 20 },
          ]);
          await create(Keys, [{ position: 7, n: 1 }]);
          const r = repo();
          const ks = await r.all(from(K, "x").orderBy(({ x }) => x.id));
          expect((await r.reloadOrThrow([...ks].reverse())).map((each) => each.k0)).toEqual([20, 10]);
          const [keys] = await r.all(Keys);
          expect((await r.reloadOrThrow(keys as Keys)).position).toBe(7);
        });

        test("a binary key", async (context) => {
          if (profile.columnType(meta(Blob).primaryKey[0]?.type as never) === undefined)
            return context.skip("no binary column");
          await create(Blob, [
            { id: Uint8Array.from([1, 2, 3]), n: 1 },
            { id: Uint8Array.from([0, 255]), n: 2 },
          ]);
          const r = repo();
          const blobs = await r.all(from(Blob, "b").orderBy(({ b }) => b.n));
          expect((await r.reloadOrThrow(blobs)).map((each) => each.n)).toEqual([1, 2]);
          expect((await r.get(Blob, Uint8Array.from([0, 255])))?.n).toBe(2);
          await db.exec("delete from rt_blob_keys where n = 1");
          expect((await r.reload(blobs)).map((each) => each?.n ?? null)).toEqual([null, 2]);
        });

        test("an array key", async (context) => {
          if (profile.columnType(meta(Path).primaryKey[0]?.type as never) === undefined)
            return context.skip("no array column");
          if (!adapter().capabilities.arrays) return context.skip("capability arrays is false");
          await create(Path, [
            { path: ["a", "b"], n: 1 },
            { path: ["a,b"], n: 2 },
            { path: [], n: 3 },
          ]);
          const r = repo();
          const paths = await r.all(from(Path, "p").orderBy(({ p }) => p.n));
          expect((await r.reloadOrThrow(paths)).map((each) => each.n)).toEqual([1, 2, 3]);
          expect((await r.get(Path, ["a,b"]))?.n).toBe(2);
          expect((await r.get(Path, ["a", "b"]))?.n).toBe(1);
          await db.exec("delete from rt_path_keys where n = 1");
          expect((await r.reload(paths)).map((each) => each?.n ?? null)).toEqual([null, 2, 3]);
        });

        test("a composite key with an array field, values that would collide as text", async (context) => {
          if (profile.columnType(meta(Tagged).fieldsByName.get("tags")?.type as never) === undefined) {
            return context.skip("no array column");
          }
          if (!adapter().capabilities.arrays) return context.skip("capability arrays is false");
          await create(Tagged, [
            { a: 1, tags: ["a,b"], n: 1 },
            { a: 1, tags: ["a", "b"], n: 2 },
            { a: 2, tags: ["x"], n: 3 },
          ]);
          const r = repo();
          const tagged = await r.all(from(Tagged, "g").orderBy(({ g }) => g.n));
          expect((await r.reloadOrThrow(tagged)).map((each) => each.n)).toEqual([1, 2, 3]);
          expect((await r.get(Tagged, { a: 1, tags: ["a", "b"] }))?.n).toBe(2);
          await db.exec("delete from rt_tagged_keys where n = 2");
          expect((await r.reload(tagged)).map((each) => each?.n ?? null)).toEqual([1, null, 3]);
          await expect(r.reloadOrThrow(tagged)).rejects.toThrow(NoResultsError);
        });
      });

      test("rows with a composite key", async () => {
        const r = repo();
        const memberships = await r.all(Membership);
        const fresh = await r.reloadOrThrow(memberships);
        expect(fresh.map(fieldsOf)).toEqual(memberships.map(fieldsOf));
      });
    });

    describe("database schemas", () => {
      const copy = profile.copyTableInto;

      test("rows read from a schema are stamped with it, and reload reads them there", async (context) => {
        if (copy === undefined) return context.skip("the database has no database schemas");
        await db.exec(copy("tenant_a", "users", db));
        const seeding = adapter();
        await insertRows(
          seeding,
          profile,
          User,
          [{ ...USERS[0], email: "tenant@example.com" }],
          "tenant_a.users",
        );
        const r = repo({ schema: "tenant_a" });
        const [user] = await r.all(User);
        expect(user?.email).toBe("tenant@example.com");
        expect((user as unknown as { [ROW]: unknown })[ROW]).toEqual({
          state: "loaded",
          source: "users",
          schema: "tenant_a",
        });
        // A repo with another default still reloads it from tenant_a.
        const other = repo();
        expect((await other.reload(user as User))?.email).toBe("tenant@example.com");
      });

      test("the query's own schema wins over the call's, which wins over the repo's", async (context) => {
        if (copy === undefined) return context.skip("the database has no database schemas");
        await db.exec(copy("tenant_b", "users", db));
        const seeding = adapter();
        await insertRows(
          seeding,
          profile,
          User,
          [
            { ...USERS[0], id: 1, email: "b1@example.com" },
            { ...USERS[0], id: 2, email: "b2@example.com" },
          ],
          "tenant_b.users",
        );
        const r = repo({ schema: "tenant_b" });
        expect(await r.count(User)).toBe(2);
        expect(await r.count(User, { schema: profile.defaultSchema(db) })).toBe(4);
        expect(await r.count(from(User, "u").schema(profile.defaultSchema(db)), { schema: "tenant_b" })).toBe(
          4,
        );
        expect(await r.count(from(User, "u").schema("tenant_b"))).toBe(2);
      });
    });

    describe("telemetry", () => {
      test("query events carry the operation, the table, the context and the decoding time", async () => {
        const r = repo();
        const events: RepoQueryEvent[] = [];
        r.on("query", (event) => events.push(event));
        await r.all(User, { context: { requestId: "req-1" } });
        await r.count(from(Post, "p"));
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          operation: "all",
          source: "users",
          context: { requestId: "req-1" },
          rowCount: 4,
          params: undefined,
          error: undefined,
        });
        expect(events[0]?.decodeMs).toBeGreaterThanOrEqual(0);
        expect(events[1]).toMatchObject({ operation: "aggregate", source: "posts", context: undefined });
      });

      test("parameters are reported only with log: { params: true }, redacted values hidden", async () => {
        const plain = repo();
        const plainEvents: RepoQueryEvent[] = [];
        plain.on("query", (event) => plainEvents.push(event));
        await plain.all(from(User, "u").where({ passwordHash: "hash-of-ada" }));
        expect(plainEvents[0]?.params).toBeUndefined();

        const written: string[] = [];
        const spy = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
          written.push(String(text));
          return true;
        });
        try {
          const logging = repo({ log: { params: true } });
          const events: RepoQueryEvent[] = [];
          logging.on("query", (event) => events.push(event));
          await logging.all(
            from(User, "u")
              .where({ passwordHash: "hash-of-ada" })
              .where(({ u }) => u.age.gte(30)),
          );
          expect(events[0]?.params).toEqual(["**redacted**", 30]);
        } finally {
          spy.mockRestore();
        }
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(
          /^egon all users .* 1 row: select .* -- params: \["\*\*redacted\*\*", 30\]\n$/,
        );
        expect(written[0]).not.toContain("hash-of-ada");
      });
    });

    describe("cancellation", () => {
      test("timeoutMs and signal reject with timeout and aborted", async (context) => {
        if (!adapter().capabilities.cancel) return context.skip("capability cancel is false");
        const r = repo();
        const timedOut = await rejection(r.raw(profile.sleep(5), { timeoutMs: 100 }));
        expect(timedOut).toBeInstanceOf(DatabaseError);
        expect((timedOut as DatabaseError).code).toBe("timeout");
        const controller = new AbortController();
        const pending = r.raw(profile.sleep(5), { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const aborted = await rejection(pending);
        expect((aborted as DatabaseError).code).toBe("aborted");
      });
    });

    describe("toSql, explain and raw", () => {
      test("toSql gives the SQL and the parameters as sent", () => {
        const { sql, params } = repo().toSql(from(User, "u").where(({ u }) => u.age.gte(18)));
        expect(sql).toContain("from");
        expect(params).toEqual([18]);
      });

      test("explain returns the plan as text, or the structured plan", async () => {
        const r = repo();
        const text = await r.explain(from(User, "u").where({ id: 1 }));
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        if (!adapter().capabilities.explainOptions) {
          // The options are refused when the statement is compiled (capability explainOptions).
          await expect(r.explain(from(User, "u"), { format: "json" })).rejects.toThrow(QueryError);
          await expect(r.explain(from(User, "u"), { analyze: true })).rejects.toThrow(QueryError);
          return;
        }
        const json = await r.explain(from(User, "u"), { format: "json" });
        expect(typeof json).toBe("object");
        const analyzed = await r.explain(from(User, "u").where({ id: 1 }), { analyze: true });
        expect(analyzed).toBeTruthy();
      });

      test("raw runs a fragment with bound values and returns the driver's rows", async () => {
        const r = repo();
        const result = await r.raw(
          fragment`select count(*) as n from users where age >= ${val(18, t.integer())}`,
        );
        expect(result.rowCount).toBe(1);
        expect(Number(result.rows[0]?.n)).toBe(2);
      });

      test("raw refuses a string at run time", async () => {
        await expect(repo().raw("select 1" as unknown as Expr<unknown>)).rejects.toThrow(QueryError);
      });
    });

    describe("concurrency and the pool", () => {
      test("concurrent reads on a small pool all complete", async () => {
        const a = adapter({ poolMax: 2 });
        const r = repo({ adapter: a });
        const results = await Promise.all(Array.from({ length: 30 }, (_, i) => r.get(User, (i % 4) + 1)));
        expect(results.map((user) => user?.id)).toEqual(Array.from({ length: 30 }, (_, i) => (i % 4) + 1));
        expect(a.poolStats().size).toBeLessThanOrEqual(2);
      });

      test("ping, poolStats and planCacheStats pass through", async () => {
        const r = repo();
        await r.ping();
        expect(r.poolStats().size).toBeGreaterThanOrEqual(1);
        const before = r.planCacheStats();
        await r.all(from(User, "u").where({ id: 1 }));
        await r.all(from(User, "u").where({ id: 2 }));
        const after = r.planCacheStats();
        expect(after.misses - before.misses).toBe(1);
        expect(after.hits - before.hits).toBe(1);
        expect(after.collisions).toBe(0);
      });

      test("close closes the adapter", async () => {
        const a = profile.makeAdapter(db, { poolMax: 1 });
        const r = createRepo({ adapter: a });
        await r.ping();
        await r.close();
        expect(await rejection(r.all(User))).toBeInstanceOf(DatabaseError);
      });
    });

    describe("codegen off", () => {
      test("rows are the same without generated decoders", async () => {
        const generated = repo();
        const interpreted = repo({ codegen: false });
        const q = from(User, "u")
          .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
          .orderBy(({ u }) => u.id)
          .select(({ u, pr }) => ({ user: u, profile: pr, bio: coalesce(pr.bio, val("none")) }));
        expect(await interpreted.all(q)).toEqual(await generated.all(q));
      });
    });
  });
}
