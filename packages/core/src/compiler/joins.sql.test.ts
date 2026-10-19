import { Post, Profile, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OutputPlan } from "../contracts/adapter.js";
import type { JoinNode } from "../contracts/query.js";
import { from } from "../index.js";
import { binaryNode, literalNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { JOIN_CASES } from "./sql-cases.js";
import { col, DIALECTS, rebuild, run, selectBinding, tableOf } from "./sql-fixtures.js";

describe.each(DIALECTS)("joins on $name", (dialect) => {
  for (const sqlCase of JOIN_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

type Row = Extract<OutputPlan, { kind: "row" }>;

function rows(ast: Parameters<ReturnType<typeof createCompiler>["compile"]>[0]): readonly Row[] {
  const output = createCompiler(postgresDialect).compile(ast, "all", undefined).output;
  return (output as Extract<OutputPlan, { kind: "tuple" }>).items as readonly Row[];
}

describe("which bindings a join makes nullable", () => {
  test("an inner join makes none nullable", () => {
    const q = from(User, "u")
      .join(Post, "p", ({ u, p }) => p.authorId.eq(u.id))
      .select(({ u, p }) => [u, p]);
    const [u, p] = rows(q.ast);
    expect([u?.nullable, p?.nullable]).toEqual([false, false]);
  });

  test("a left join makes the joined binding nullable", () => {
    const q = from(User, "u")
      .leftJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id))
      .select(({ u, p }) => [u, p]);
    const [u, p] = rows(q.ast);
    expect([u?.nullable, p?.nullable]).toEqual([false, true]);
  });

  test("a right join makes the bindings before it nullable", () => {
    const ast = rebuild(from(User, "u").ast, {
      joins: [{ kind: "join", type: "right", source: tableOf(Post, "p"), on: literalNode(true) }],
      select: {
        kind: "select",
        shape: {
          kind: "tuple",
          items: [
            { kind: "binding", binding: "u", meta: meta(User) },
            { kind: "binding", binding: "p", meta: meta(Post) },
          ],
        },
        constants: [],
      },
    });
    const [u, p] = rows(ast);
    expect([u?.nullable, p?.nullable]).toEqual([true, false]);
  });

  test("a full join makes both sides nullable", () => {
    const ast = rebuild(from(User, "u").ast, {
      joins: [{ kind: "join", type: "full", source: tableOf(Post, "p"), on: literalNode(true) }],
      select: {
        kind: "select",
        shape: {
          kind: "tuple",
          items: [
            { kind: "binding", binding: "u", meta: meta(User) },
            { kind: "binding", binding: "p", meta: meta(Post) },
          ],
        },
        constants: [],
      },
    });
    const [u, p] = rows(ast);
    expect([u?.nullable, p?.nullable]).toEqual([true, true]);
  });

  test("a binding before a later right join becomes nullable too", () => {
    const ast = rebuild(from(User, "u").ast, {
      joins: [
        { kind: "join", type: "left", source: tableOf(Profile, "pr"), on: literalNode(true) },
        { kind: "join", type: "right", source: tableOf(Post, "p"), on: literalNode(true) },
      ],
      select: {
        kind: "select",
        shape: {
          kind: "tuple",
          items: [
            { kind: "binding", binding: "u", meta: meta(User) },
            { kind: "binding", binding: "pr", meta: meta(Profile) },
            { kind: "binding", binding: "p", meta: meta(Post) },
          ],
        },
        constants: [],
      },
    });
    expect(rows(ast).map((row) => row.nullable)).toEqual([true, true, false]);
  });
});

describe("join errors", () => {
  const compile = (joins: readonly JoinNode[]) =>
    createCompiler(postgresDialect).compile(
      rebuild(from(User, "u").ast, { joins, select: selectBinding("u", meta(User)) }),
      "all",
      undefined,
    );

  test("an unknown join kind is refused", () => {
    expect(() =>
      compile([
        { kind: "join", type: "sideways" as never, source: tableOf(Post, "p"), on: literalNode(true) },
      ]),
    ).toThrow('Unknown join kind "sideways".');
  });

  test("a cross join with a condition is refused", () => {
    expect(() =>
      compile([{ kind: "join", type: "cross", source: tableOf(Post, "p"), on: literalNode(true) }]),
    ).toThrow("A cross join has no condition.");
  });

  test("a join without a condition joins on true", () => {
    const plan = compile([{ kind: "join", type: "inner", source: tableOf(Post, "p"), on: undefined }]);
    expect(plan.sql).toContain('inner join "posts" as "p" on true');
  });

  test("one alias for two sources is refused", () => {
    expect(() =>
      compile([
        {
          kind: "join",
          type: "inner",
          source: tableOf(Post, "u"),
          on: binaryNode("eq", col("u", "id"), col("u", "id")),
        },
      ]),
    ).toThrow('The alias "u" names two sources of one query; give each its own alias.');
  });

  test("a source without an alias is refused", () => {
    expect(() =>
      compile([{ kind: "join", type: "inner", source: tableOf(Post, ""), on: literalNode(true) }]),
    ).toThrow("A source has no alias.");
  });

  test("a column of a binding the query does not have is refused", () => {
    expect(() =>
      compile([
        {
          kind: "join",
          type: "inner",
          source: tableOf(Post, "p"),
          on: binaryNode("eq", col("x", "id"), col("p", "id")),
        },
      ]),
    ).toThrow('The column x.id refers to the binding "x", which the query does not have.');
  });
});
