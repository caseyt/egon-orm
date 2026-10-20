// A consumer project's own code, compiled against the packed and installed packages by
// check-types.mjs with `declaration: true` and `skipLibCheck: false`. Everything here is
// exported with an inferred type on purpose: emitting its declarations needs every type
// those inferred types mention to be reachable from a public entry point (TS2883 when
// one is not), and checking the libraries' own .d.ts finds what tsc rejects there.
import { mysql } from "@egon-orm/mysql";
import { postgres } from "@egon-orm/postgres";
import { sqlite } from "@egon-orm/sqlite";
import { castWith, toZod } from "@egon-orm/zod";
import {
  and,
  assoc,
  avg,
  belongsTo,
  buildAssoc,
  caseWhen,
  cast,
  change,
  coalesce,
  count,
  createBatch,
  createRepo,
  cte,
  defineType,
  dynamic,
  EmbeddedSchema,
  exists,
  failure,
  fragment,
  from,
  hasMany,
  hasOne,
  lit,
  manyToMany,
  max,
  not,
  or,
  outerRef,
  param,
  parameterized,
  prepare,
  rowNumber,
  Schema,
  scalar,
  selectedAs,
  subquery,
  success,
  sum,
  t,
  timestamps,
  tuple,
  val,
} from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";
import { createSandbox } from "egon-orm/testing";
import { z } from "zod";

export const Money = defineType<{ cents: number }, string>({
  name: "money",
  db: { kind: "text" },
  cast: (value) =>
    typeof value === "number"
      ? { success: true, data: { cents: value } }
      : { success: false, message: "is invalid" },
  fromDb: (value) => ({ cents: Number(value) }),
  toDb: (value) => String(value.cents),
});

export const currency = parameterized((options: { code: string }) =>
  defineType<string>({
    name: "currency",
    db: { kind: "text" },
    cast: (value) =>
      typeof value === "string" && value.startsWith(options.code)
        ? { success: true, data: value }
        : { success: false, message: "is invalid" },
  }),
);

export class Address extends EmbeddedSchema({
  street: t.string(),
  city: t.string().nullable(),
}) {
  static changeset(address: Address | typeof Address, params: unknown) {
    return cast(address, params, ["street", "city"]).validateRequired(["street"]);
  }
}

export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  level: t.enum({ low: 1, high: 2 }).default("low"),
  score: t.float().default(0),
  balance: t.decimal({ precision: 10, scale: 2 }).nullable(),
  big: t.bigint().nullable(),
  bigNumber: t.bigint({ mode: "number" }).nullable(),
  active: t.boolean().default(true),
  token: t.uuid().autogenerate(),
  avatar: t.binary().nullable(),
  birthday: t.date().nullable(),
  birthdayDate: t.date({ as: "date" }).nullable(),
  wakeUp: t.time().nullable(),
  seenAt: t.timestamp({ precision: "ms" }).nullable(),
  localSeenAt: t.localTimestamp().nullable(),
  settings: t.json<{ theme: string }>().nullable(),
  tags: t.array(t.string()).default([]),
  wallet: t.type(Money).nullable(),
  code: t.type(currency({ code: "EUR" })).nullable(),
  password: t.string().virtual(),
  passwordHash: t.string().redact().column("pw_hash"),
  address: t.embedOne(() => Address, { onReplace: "update" }).nullable(),
  addresses: t.embedMany(() => Address),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId", orderBy: ["createdAt"] });
  static profile = hasOne(() => Profile, { foreignKey: "userId" });
  static groups = manyToMany(() => Group, {
    joinThrough: "memberships",
    joinKeys: { owner: "user_id", target: "group_id" },
  });

  get displayName(): string {
    return this.name ?? this.email;
  }

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name", "age", "password"])
      .validateRequired(["email"])
      .validate(z.object({ email: z.string().email() }))
      .validateLength("password", { min: 12 })
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  views: t.integer().default(0),
  published: t.boolean().default(false),
  authorId: t.integer(),
  ...timestamps({ updatedAt: false }),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

export class Profile extends Schema("profiles", {
  id: t.uuid().primaryKey().autogenerate(),
  userId: t.integer(),
  bio: t.string().nullable(),
}) {
  static user = belongsTo(() => User);
}

export class Group extends Schema("groups", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
}) {}

export class Membership extends Schema(
  "memberships",
  { userId: t.integer().primaryKey(), groupId: t.integer().primaryKey() },
  { schema: "tenant" },
) {}

// Changesets.
export const newUser = User.changeset(User, { email: "ada@example.com" });
export const changed = change(Post, { title: "Hello", authorId: 1 });
export const schemaless = cast({ name: t.string(), age: t.integer() }, {}, ["name", "age"]);
export const errors = newUser.errorMessages();
export const zodCast = castWith(User, { email: "a@b.c" }, z.object({ email: z.string() }));
export const UserZ = toZod(User);
export const InsertUserZ = toZod(User, { mode: "insert", pick: ["email", "name"] });

// Queries.
export const adults = from(User, "u")
  .where(({ u }) => u.age.gte(18).and(u.role.eq("member")))
  .orderBy(({ u }) => u.createdAt.desc())
  .limit(10);
export const withPosts = from(User, "u")
  .joinAssoc("u", "posts", "p")
  .where(({ p }) => p.published)
  .groupBy(({ u }) => u.id)
  .select(({ u, p }) => ({
    id: u.id,
    email: u.email,
    posts: count(p.id),
    views: sum(p.views),
    mean: avg(p.views),
  }));
export const leftJoined = from(Post, "p")
  .leftJoin(User, "u", ({ p, u }) => p.authorId.eq(u.id))
  .select(({ p, u }) => ({
    title: p.title,
    author: u.email,
    bucket: caseWhen(p.views.gt(100), "hot").else("cold"),
    one: lit(1),
  }));
export const withParams = from(User, "u").where(({ u }) => u.email.eq(param("email", t.string())));
export const preloaded = from(User, "u").preload("posts", (q) =>
  q.orderBy(({ posts }) => posts.createdAt.desc()).limit(3),
);
export const preloadedNested = from(Post, "p").preload({ author: ["profile", "groups"] });
export const logic = from(User, "u").where(({ u }) =>
  or(and(u.age.isNull(), not(u.active)), u.name.like("A%"), u.email.in(["a@b.c"])),
);
export const fragments = from(User, "u").where(({ u }) =>
  and(u.active, fragment`lower(${u.email}) = ${"ada"}`.as<boolean>()),
);
export const subqueries = from(User, "u")
  .where(({ u }) => exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id))))
  .select(({ u }) => ({
    user: u,
    latest: scalar(
      from(Post, "p")
        .where(({ p }) => p.authorId.eq(outerRef("u", User).id))
        .select(({ p }) => max(p.createdAt)),
    ),
    label: coalesce(u.name, val("anonymous")),
    rank: rowNumber().over({ orderBy: [u.createdAt.desc()] }),
  }));
export const totals = from(Post, "p")
  .groupBy(({ p }) => p.authorId)
  .select(({ p }) => ({ authorId: p.authorId, total: selectedAs(sum(p.views), "total") }))
  .orderBy(() => selectedAs("total").desc());
export const page = from(Post, "p").where(({ p }) => tuple(p.createdAt, p.id).lt(tuple(new Date(0), 1)));
export const counts = from(subquery(withPosts), "c").where(({ c }) => c.posts.gt(5));
export const tree = from(cte("tree", Group), "g").withCte("tree", from(Group, "g"), { recursive: true });
export const filter = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));
export const filtered = from(User, "u").where(filter);
export const prepared = prepare(withParams);
export const bulk = from(Post, "p")
  .where(({ p }) => p.authorId.eq(1))
  .set(({ p }) => ({ views: p.views.add(1) }))
  .returning(({ p }) => ({ id: p.id }));
export const unioned = from(User, "u")
  .select(({ u }) => ({ email: u.email }))
  .union(from(Post, "p").select(({ p }) => ({ email: p.title })));
export const locked = from(User, "u").lock("update", { skipLocked: true });

// The repo, adapters, batches.
export const adapter = postgres({ connectionString: "postgres://localhost/unused", ssl: false });
export const otherAdapters = [
  sqlite({ filename: ":memory:" }),
  mysql({ connectionString: "mysql://localhost/x" }),
];
export const repo = createRepo({ adapter, log: { params: true } });
export const allAdults = () => repo.all(adults);
export const oneUser = () => repo.getOrThrow(User, 1);
export const firstWithPosts = () => repo.first(withPosts);
export const byEmail = () => repo.all(withParams, { email: "ada@example.com" });
export const inserted = () => repo.insert(newUser);
export const insertedOrThrow = () => repo.insertOrThrow(newUser);
export const upserted = () => repo.insert(newUser, { onConflict: "nothing" });
export const loadedPosts = (users: User[]) => repo.preload(User, users, "posts");
export const bulkResult = () => repo.updateAll(bulk);
export const counted = () => repo.count(adults);
export const raw = () => repo.raw(fragment`select 1 as one`);
export const signUp = createBatch()
  .insert("user", newUser)
  .insert("profile", ({ user }) => change(Profile, { userId: user.id }))
  .run("done", async () => success(true));
export const signedUp = () => repo.transaction(signUp);
export const inTransaction = () => repo.transaction(async (tx) => tx.getOrThrow(User, 1));
export const sandbox = () => createSandbox(repo);

// Migrations.
export const createUsers = defineMigration({
  change(m) {
    m.createTable("users", (table) => {
      table.id();
      table.text("email").notNull();
      table.integer("age");
      table.timestamps();
    });
    m.createIndex("users", ["email"], { unique: true });
  },
});
export const migrator = createMigrator({ adapter, directory: "./migrations" });
export const alterUsers = defineMigration({
  up(m) {
    m.alterTable("users", (table) => {
      table.text("nickname");
      table.modify("age", "bigint", { from: "integer" });
      table.rename("name", "full_name");
    });
  },
  down(m) {
    m.dropTable("users");
  },
});

// More of the surface: nested changesets, embeds, windows, association queries, writes.
export const withAddress = cast(User, { address: { street: "Main" } }, ["email"]).castEmbed("address", {
  with: Address.changeset,
});
export const withAuthor = change(Post, { title: "x", authorId: 1 }).putAssoc("author", { email: "a@b.c" });
export const built = (user: User) => buildAssoc(User, user, "posts", { title: "Hello" });
export const windowed = from(Post, "p")
  .windows({ w: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
  .select(({ p }) => ({ id: p.id, rank: rowNumber().over("w"), total: sum(p.views).over("w") }));
export const draftsOf = (user: User) =>
  assoc(User, user, "posts").where(({ posts }) => posts.published.eq(false));
export const joinPreloaded = from(User, "u").joinAssoc("u", "posts", "p").preload({ posts: "p" });
export const minViews = dynamic({ p: Post }, ({ p }) => p.views.gte(param("minViews", t.integer())));
export const byMinViews = from(Post, "p").where(minViews);
export const getBy = () => repo.getBy(User, { email: "ada@example.com" });
export const aggregate = () => repo.aggregate(Post, "max", "createdAt");
export const insertAll = () => repo.insertAll(Post, [{ title: "x", authorId: 1 }]);
export const deleted = () => repo.deleteAll(from(Post, "p").where({ published: false }));
export const upsert = () => repo.insertOrUpdateOrThrow(newUser);
export const loadedOne = () => repo.oneOrThrow(preloadedNested);
export const streamed = () => repo.stream(adults);
export const listener = () => repo.on("query", (event) => event.sql);
export const preparedRows = () => repo.all(prepared, { email: "x" });
export const moreSteps = createBatch()
  .one("author", from(User, "u").where({ email: "ada@example.com" }))
  .run("found", async (_tx, { author }) => (author === null ? failure("missing") : success(author)))
  .updateAll("published", ({ found }) =>
    from(Post, "p").where({ authorId: found.id }).set({ published: true }),
  )
  .put("source", "admin");
