// @run
// The checked sources of the code blocks in guide/getting-started.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile. The regions stand for three files of the reader's project:
// schemas.ts, repo.ts and setup.ts.
// #region imports
import { postgres } from "@egon-orm/postgres";
import { belongsTo, cast, count, createRepo, from, hasMany, Schema, t, timestamps } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";
// #endregion imports

// #region schemas
// schemas.ts
export class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"])
      .validateRequired(["email"])
      .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  published: t.boolean().default(false),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}
// #endregion schemas

// #region repo
// repo.ts
export const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL }),
});
// #endregion repo

export async function setUp(): Promise<void> {
  // #region tables
  // setup.ts: create the two tables
  const createTables = defineMigration({
    change(m) {
      m.createTable("users", (t) => {
        t.id(); //                         "id" bigserial primary key
        t.text("email").notNull().unique(); // users_email_key, which uniqueConstraint("email") expects
        t.text("name");
        t.timestamps(); //                 created_at, updated_at
      });
      m.createTable("posts", (t) => {
        t.id();
        t.references("author_id", "users").notNull();
        t.text("title").notNull();
        t.boolean("published").notNull().default(false);
        t.timestamps();
      });
    },
  });

  const adapter = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter,
    migrations: [{ version: 20261020090000, name: "create_tables", migration: createTables }],
  }).up();
  await adapter.close();
  // #endregion tables
}

export async function firstSteps(): Promise<void> {
  // #region insert
  const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));

  if (!result.success) {
    console.log(result.error.errorMessages()); // { email: ["has already been taken"] }
    return;
  }
  const ada = result.data; // User: id, createdAt and updatedAt are filled in
  // #endregion insert

  // #region query
  const found = await repo.getBy(User, { email: "ada@example.com" }); // User | null
  found?.email; // => "ada@example.com"

  const counts = await repo.all(
    from(User, "u")
      .leftJoinAssoc("u", "posts", "p")
      .groupBy(({ u }) => u.id)
      .select(({ u, p }) => ({ email: u.email, posts: count(p.id) })),
  ); // { email: string; posts: number }[]
  counts[0]; // => { email: "ada@example.com", posts: 0 }

  const withPosts = await repo.all(from(User, "u").preload("posts"));
  // A Post[]: the type knows the posts were preloaded.
  withPosts[0]?.posts; // => []
  // #endregion query

  // #region update
  const renamed = await repo.updateOrThrow(User.changeset(ada, { name: "Ada" }));
  renamed.name; // => "Ada"
  await repo.deleteOrThrow(renamed);
  // #endregion update

  // #region close
  await repo.close(); // waits for running queries, then closes the pool
  // #endregion close
}

export async function run(): Promise<void> {
  await setUp();
  await firstSteps();
}
