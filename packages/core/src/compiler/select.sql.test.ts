import { Post, Profile, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OutputPlan } from "../contracts/adapter.js";
import { from, param, t, val } from "../index.js";
import { selectedAsNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { SELECT_CASES } from "./sql-cases.js";
import { col, DIALECTS, Event, rebuild, run, selectObject } from "./sql-fixtures.js";

describe.each(DIALECTS)("select lists on $name", (dialect) => {
  for (const sqlCase of SELECT_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

/** The output plan with each schema's metadata shown by name, for readable comparisons. */
function outputOf(ast: Parameters<ReturnType<typeof createCompiler>["compile"]>[0]): unknown {
  const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
  return JSON.parse(
    JSON.stringify(plan.output, (key, value: unknown) => {
      if (key === "meta") return (value as { name: string }).name;
      if (key === "type") return value === undefined ? "none" : (value as { name: string }).name;
      return value;
    }),
  );
}

describe("the output plan", () => {
  test("a query without a select returns whole root rows, keyed by the primary key", () => {
    expect(outputOf(from(User, "u").ast)).toEqual({
      kind: "row",
      meta: "User",
      aliases: ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"],
      key: ["c0"],
      schema: undefined,
      nullable: false,
      preloads: [],
    });
  });

  test("aliases follow the persisted fields, which leave out virtual ones", () => {
    const plan = createCompiler(postgresDialect).compile(from(User, "u").ast, "all", undefined);
    const row = plan.output as Extract<OutputPlan, { kind: "row" }>;
    expect(row.meta).toBe(meta(User));
    expect(row.aliases.length).toBe(meta(User).persisted.length);
    expect(meta(User).persisted.map((field) => field.name)).not.toContain("password");
  });

  test("a schema without a primary key has an empty key", () => {
    expect(outputOf(from(Event, "e").ast)).toMatchObject({ kind: "row", key: [], aliases: ["c0", "c1"] });
  });

  test("an object select mirrors the callback's shape, with constants that are not columns", () => {
    const q = from(User, "u").select(({ u }) => ({ id: u.id, kind: "user", pair: [u.email, 2] }));
    expect(outputOf(q.ast)).toEqual({
      kind: "object",
      keys: ["id", "kind", "pair"],
      values: [
        { kind: "value", alias: "c0", type: "bigint(number)" },
        { kind: "constant", index: 0 },
        {
          kind: "tuple",
          items: [
            { kind: "value", alias: "c1", type: "string" },
            { kind: "constant", index: 1 },
          ],
        },
      ],
    });
  });

  test("a selected value keeps its type for loading; an untyped one has none", () => {
    const q = from(User, "u").select(() => ({ a: val("x"), b: val(1, t.integer()) }));
    expect(outputOf(q.ast)).toMatchObject({
      values: [
        { alias: "c0", type: "none" },
        { alias: "c1", type: "integer" },
      ],
    });
  });

  test("a whole left-joined binding is a nullable row leaf", () => {
    const q = from(User, "u")
      .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
      .select(({ u, pr }) => ({ user: u, profile: pr }));
    expect(outputOf(q.ast)).toMatchObject({
      kind: "object",
      values: [
        { kind: "row", meta: "User", nullable: false, key: ["c0"] },
        { kind: "row", meta: "Profile", nullable: true, aliases: ["c10", "c11", "c12", "c13"], key: ["c10"] },
      ],
    });
  });

  test("preloads are listed on the root row; a join preload has a row of its own", () => {
    const q = from(User, "u").joinAssoc("u", "posts", "p").preload({ posts: "p", profile: true });
    const output = outputOf(q.ast) as { preloads: unknown[] };
    expect(output.preloads).toEqual([
      {
        assoc: "posts",
        cardinality: "many",
        row: {
          kind: "row",
          meta: "Post",
          aliases: ["c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17", "c18", "c19"],
          key: ["c10"],
          schema: undefined,
          nullable: false,
          preloads: [],
        },
      },
      { assoc: "profile", cardinality: "one" },
    ]);
  });

  test("a nested join preload sits on the child row", () => {
    const q = from(User, "u")
      .leftJoinAssoc("u", "posts", "p")
      .leftJoinAssoc("p", "comments", "c")
      .preload({ posts: { $from: "p", comments: "c" } });
    const output = outputOf(q.ast) as { preloads: { row: { nullable: boolean; preloads: unknown[] } }[] };
    expect(output.preloads[0]?.row.nullable).toBe(true);
    expect(output.preloads[0]?.row.preloads).toMatchObject([
      { assoc: "comments", cardinality: "many", row: { meta: "Comment", nullable: true } },
    ]);
  });

  test("a preload on a query that does not return its root rows is refused", () => {
    const ast = rebuild(from(User, "u").preload("posts").ast, {
      select: selectObject({ id: col("u", "id") }),
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      /must return the whole rows of its root binding/,
    );
  });

  test("a preload of an unknown association is refused", () => {
    const base = from(User, "u").preload("posts").ast;
    const ast = rebuild(base, {
      preloads: [{ kind: "preload", assoc: "nope", from: undefined, query: undefined, nested: [] }],
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      'User has no association "nope" to preload.',
    );
  });

  test("a whole binding of another schema than its source is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: { kind: "select", shape: { kind: "binding", binding: "u", meta: meta(Post) }, constants: [] },
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      'The select returns "u" as rows of Post, but that binding yields rows of User.',
    );
  });

  test("a whole binding the query does not have is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: { kind: "select", shape: { kind: "binding", binding: "x", meta: meta(User) }, constants: [] },
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      'The select returns the whole binding "x", which the query does not have.',
    );
  });

  test("two output columns with one name are refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: selectObject({
        a: selectedAsNode("c1", col("u", "id")),
        b: col("u", "email"),
      }),
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      'The select list has two output columns named "c1".',
    );
  });

  test("a reference to a selected name cannot be selected itself", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: selectObject({ a: selectedAsNode("total", undefined) }),
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      /selectedAs\("total"\) without an expression/,
    );
  });

  test("an object select with mismatched keys and values is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: { kind: "select", shape: { kind: "object", keys: ["a", "b"], values: [] }, constants: [] },
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      "A select object has a different number of keys and values.",
    );
  });

  test("an unknown select shape is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: { kind: "select", shape: { kind: "nope" } as never, constants: [] },
    });
    expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
      'Unknown select shape "nope".',
    );
  });

  test("a named parameter in a select list is cast to its type", () => {
    const q = from(User, "u").select(() => param("since", t.timestamp()));
    expect(createCompiler(postgresDialect).compile(q.ast, "all", undefined).sql).toBe(
      'select cast($1 as timestamptz) as "c0" from "users" as "u"',
    );
  });
});
