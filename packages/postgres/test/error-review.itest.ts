// Every error class, triggered the way an application would trigger it, against Postgres.
// For each one: the short message (the default) starts with the error's identifier, names
// what failed and the offending name, and links the identifier's entry on the errors pages;
// that entry exists; and the full text (`explain`, from `egon-orm/messages`) adds the
// catalog's advice, which says what to do.
import { readFileSync } from "node:fs";
import { Post, User, withDatabase } from "@egon-orm/test-support";
import {
  CastError,
  ConstraintError,
  cast,
  change,
  createRepo,
  DatabaseError,
  type EgonError,
  fragment,
  from,
  InvalidChangesetError,
  isEgonError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  type Repo,
  RollbackError,
  Schema,
  SchemaDefinitionError,
  StaleEntryError,
  t,
  useFullErrorMessages,
} from "egon-orm";
import { explain, messages } from "egon-orm/messages";
import { MigrationError, parseMigrationFileName } from "egon-orm/migration";
import { afterAll, beforeAll, expect, test } from "vitest";
import { postgres } from "../src/index.js";

// The test setup turns the full messages on for every test; this file checks the default.
beforeAll(() => useFullErrorMessages(null));
afterAll(() => useFullErrorMessages(messages));

const DOCS = "https://egon-orm.github.io/egon-orm/reference/errors/";
const PAGES = new URL("../../../docs/site/reference/errors/", import.meta.url);

/** What a thrown error must say, and where its entry is. */
function review(error: unknown, expected: { readonly id: string; readonly names: readonly string[] }): void {
  expect(isEgonError(error)).toBe(true);
  const egon = error as EgonError;
  expect(egon.id).toBe(expected.id);
  // The short message: `<id>: <what failed, naming it>. See <link>`, with no advice.
  expect(egon.message.startsWith(`${egon.id}: `)).toBe(true);
  for (const name of expected.names) expect(egon.message).toContain(name);
  const dot = egon.id.indexOf(".");
  const page = dot < 0 ? "general" : egon.id.slice(0, dot);
  const anchor = egon.id.replace(".", "-").toLowerCase();
  expect(egon.message).toContain(`See ${DOCS}${page}#${anchor}`);
  // The entry is on that page, under that anchor.
  expect(readFileSync(new URL(`${page}.md`, PAGES), "utf8")).toContain(`{#${anchor}}`);
  // The full text adds the catalog's advice to the same short sentence.
  const advice = (messages as Readonly<Record<string, string>>)[egon.id];
  expect(advice).toBeTypeOf("string");
  const full = explain(egon);
  expect(full.length).toBeGreaterThan(egon.message.length);
  expect(full).toContain(`${DOCS}${page}#${anchor}`);
  // The advice up to its first placeholder appears as written.
  const literal = (advice ?? "").split("{{")[0] ?? "";
  expect(full).toContain(literal.slice(0, 40));
}

async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

async function withBlog(fn: (repo: Repo) => Promise<void>): Promise<void> {
  await withDatabase("postgres", { label: "errors", fixtures: ["blog"] }, async (db) => {
    const repo = createRepo({ adapter: postgres({ connectionString: db.url, pool: { max: 2 } }) });
    try {
      await fn(repo);
    } finally {
      await repo.close();
    }
  });
}

test("NoResultsError names the query that returned nothing", () =>
  withBlog(async (repo) => {
    const error = await thrown(() => repo.oneOrThrow(from(User, "u").where({ email: "nobody@example.com" })));
    expect(error).toBeInstanceOf(NoResultsError);
    review(error, { id: "noResults", names: ["users"] });
  }));

test("MultipleResultsError gives the count and the query", () =>
  withBlog(async (repo) => {
    await repo.insertOrThrow(change(User, { email: "a@example.com" }));
    await repo.insertOrThrow(change(User, { email: "b@example.com" }));
    const error = await thrown(() => repo.one(from(User, "u")));
    expect(error).toBeInstanceOf(MultipleResultsError);
    review(error, { id: "multipleResults", names: ["2", "users"] });
  }));

test("InvalidChangesetError lists the fields in error, without their values", () =>
  withBlog(async (repo) => {
    const error = await thrown(() =>
      repo.insertOrThrow(cast(User, { email: "" }, ["email"]).validateRequired(["email"])),
    );
    expect(error).toBeInstanceOf(InvalidChangesetError);
    review(error, { id: "invalidChangeset", names: ["insert", "email", "can't be blank"] });
  }));

test("StaleEntryError says the update matched no row, and names the schema", () =>
  withBlog(async (repo) => {
    const user = await repo.insertOrThrow(change(User, { email: "a@example.com" }));
    await repo.deleteOrThrow(user);
    const error = await thrown(() => repo.updateOrThrow(change(user, { name: "Gone" })));
    expect(error).toBeInstanceOf(StaleEntryError);
    review(error, { id: "staleEntry", names: ["update", "User"] });
  }));

test("ConstraintError names the constraint that no changeset declared", () =>
  withBlog(async (repo) => {
    await repo.insertOrThrow(change(User, { email: "a@example.com" }));
    const error = await thrown(() => repo.insertOrThrow(change(User, { email: "a@example.com" })));
    expect(error).toBeInstanceOf(ConstraintError);
    review(error, { id: "constraint.undeclared", names: ["users_email_key"] });
  }));

test("DatabaseError carries the database's own error, and names it", () =>
  withBlog(async (repo) => {
    const error = await thrown(() => repo.raw(fragment`select * from no_such_table`));
    expect(error).toBeInstanceOf(DatabaseError);
    review(error, { id: "database.rejected", names: ["no_such_table"] });
  }));

test("RollbackError says the transaction was rolled back on purpose", () =>
  withBlog(async (repo) => {
    const error = await thrown(() => repo.transactionOrThrow((tx) => tx.rollback("changed my mind")));
    expect(error).toBeInstanceOf(RollbackError);
    expect((error as RollbackError).reason).toBe("changed my mind");
    review(error, { id: "rollback.called", names: ["tx.rollback(reason)"] });
  }));

test("NotLoadedError names the schema and the association that was not preloaded", () =>
  withBlog(async (repo) => {
    const user = await repo.insertOrThrow(change(User, { email: "a@example.com" }));
    const post = await repo.insertOrThrow(change(Post, { authorId: user.id, title: "t" }));
    const error = await thrown(() =>
      cast(post, { comments: [] }, ["title"]).castAssoc("comments", {
        with: (comment, params) => cast(comment, params, ["body"]),
      }),
    );
    expect(error).toBeInstanceOf(NotLoadedError);
    review(error, { id: "notLoaded", names: ["Post", "comments"] });
  }));

test("QueryError names the clause and the alias it refused", async () => {
  const error = await thrown(() => from(User, "u").joinAssoc("u", "posts", "u" as never));
  expect(error).toBeInstanceOf(QueryError);
  review(error, { id: "query.aliasTaken", names: ['"u"'] });
});

test("CastError names the type and the value's kind it could not convert", () =>
  withBlog(async (repo) => {
    class LooseUser extends Schema("users", { id: t.integer().primaryKey(), email: t.string() }) {}
    await repo.insertOrThrow(change(User, { email: "a@example.com" }));
    // users.id is a bigint, which pg reads as text; a t.integer() field refuses it.
    const error = await thrown(() => repo.all(from(LooseUser, "u")));
    expect(error).toBeInstanceOf(CastError);
    const egon = error as EgonError;
    review(error, { id: egon.id, names: ["id"] });
    expect(egon.id.startsWith("cast.")).toBe(true);
  }));

test("SchemaDefinitionError names the schema and the field it refused", async () => {
  const error = await thrown(() => {
    class Broken extends Schema("broken", {
      id: t.integer().primaryKey(),
      status: t.string().default(null as never),
    }) {}
    return Broken;
  });
  expect(error).toBeInstanceOf(SchemaDefinitionError);
  const egon = error as EgonError;
  review(error, { id: egon.id, names: ["status"] });
});

test("MigrationError names the migration file it refused", async () => {
  const error = await thrown(() => parseMigrationFileName("2026_create_users.ts"));
  expect(error).toBeInstanceOf(MigrationError);
  review(error, { id: "migration.fileName", names: ["2026_create_users.ts", "14-digit"] });
});
