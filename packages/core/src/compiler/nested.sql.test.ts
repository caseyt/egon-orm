import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OutputPlan } from "../contracts/adapter.js";
import type { QueryAst } from "../contracts/query.js";
import { from } from "../index.js";
import { binaryNode, existsNode, literalNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { NESTED_CASES } from "./sql-cases.js";
import {
  bareQuery,
  col,
  DIALECTS,
  frag,
  rebuild,
  run,
  selectBinding,
  selectObject,
  selectOne,
  tableSource,
  value,
} from "./sql-fixtures.js";

describe.each(DIALECTS)("subqueries, sources, CTEs and set operations on $name", (dialect) => {
  for (const sqlCase of NESTED_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

function compile(ast: QueryAst) {
  return createCompiler(postgresDialect).compile(ast, "all", undefined);
}

describe("nested queries", () => {
  test("a subquery source is read through the subquery's own output columns", () => {
    const inner = from(Post, "p").select(({ p }) => ({ author: p.authorId, n: p.views }));
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: inner.ast, alias: "s" }), {
      select: selectObject({ author: col("s", "author"), n: col("s", "n") }),
    });
    expect(compile(ast).sql).toBe(
      'select "s"."author" as "c0", "s"."n" as "c1" from (select "p"."author_id" as "author", "p"."views" as "n" from "posts" as "p") as "s"',
    );
  });

  test("a subquery source's values that are not top-level keys get positional names", () => {
    const inner = from(Post, "p").select(({ p }) => [p.id, { nested: p.title }]);
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: inner.ast, alias: "s" }), {
      select: selectObject({ id: col("s", "c0"), title: col("s", "c1") }),
    });
    expect(compile(ast).sql).toContain(
      '(select "p"."id" as "c0", "p"."title" as "c1" from "posts" as "p") as "s"',
    );
  });

  test("a whole binding over a subquery that does not return whole rows is refused", () => {
    const inner = from(Post, "p").select(({ p }) => ({ id: p.id }));
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: inner.ast, alias: "s" }), {
      select: selectBinding("s", meta(Post)),
    });
    expect(() => compile(ast)).toThrow(
      'The select returns "s" as rows of Post, but that binding yields no schema\'s rows.',
    );
  });

  test("a CTE declared with one schema whose body selects another is refused", () => {
    const ast = rebuild(bareQuery({ kind: "cteSource", name: "c", meta: meta(User), alias: "x" }), {
      ctes: [
        {
          kind: "cte",
          name: "c",
          query: from(Post, "p").ast,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
    });
    expect(() => compile(ast)).toThrow(
      'The source "x" is declared with the schema User, but the CTE "c" selects rows of Post.',
    );
  });

  test("a source that names no CTE is refused", () => {
    const ast = rebuild(bareQuery({ kind: "cteSource", name: "missing", meta: undefined, alias: "m" }), {
      select: selectOne(literalNode(1)),
    });
    expect(() => compile(ast)).toThrow(
      'The source "m" reads the CTE "missing", which the query does not define.',
    );
  });

  test("a CTE cannot see itself unless it is recursive", () => {
    const self = rebuild(bareQuery({ kind: "cteSource", name: "loop", meta: undefined, alias: "l" }), {
      select: selectOne(literalNode(1)),
    });
    const ast = rebuild(bareQuery({ kind: "cteSource", name: "loop", meta: undefined, alias: "l" }), {
      ctes: [
        {
          kind: "cte",
          name: "loop",
          query: self,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
      select: selectOne(literalNode(1)),
    });
    expect(() => compile(ast)).toThrow('reads the CTE "loop", which the query does not define');
  });

  test("two CTEs with one name are refused", () => {
    const body = from(Post, "p").ast;
    const ast = rebuild(from(User, "u").ast, {
      ctes: [
        { kind: "cte", name: "c", query: body, operation: "all", recursive: false, materialized: undefined },
        { kind: "cte", name: "c", query: body, operation: "all", recursive: false, materialized: undefined },
      ],
    });
    expect(() => compile(ast)).toThrow('The CTE name "c" is used twice in one query.');
  });

  test("a CTE without a name is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      ctes: [
        {
          kind: "cte",
          name: "",
          query: from(Post, "p").ast,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
    });
    expect(() => compile(ast)).toThrow("A CTE has no name.");
  });

  test("a fragment CTE body can only be read", () => {
    const ast = rebuild(from(User, "u").ast, {
      ctes: [
        {
          kind: "cte",
          name: "f",
          query: frag`select 1`,
          operation: "deleteAll",
          recursive: false,
          materialized: undefined,
        },
      ],
    });
    expect(() => compile(ast)).toThrow('The CTE "f" has a fragment body, which can only be read.');
  });

  test("a CTE is planned the same when a subquery source reads from it", () => {
    // The subquery source is planned before it is written; its CTE must be found then too.
    const inner = rebuild(bareQuery({ kind: "cteSource", name: "c", meta: meta(Post), alias: "cs" }), {
      ctes: [
        {
          kind: "cte",
          name: "c",
          query: from(Post, "p").ast,
          operation: "all",
          recursive: true,
          materialized: undefined,
        },
      ],
      select: selectBinding("cs", meta(Post)),
    });
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: inner, alias: "s" }), {
      select: selectBinding("s", meta(Post)),
    });
    const output = compile(ast).output as Extract<OutputPlan, { kind: "row" }>;
    expect(output.meta).toBe(meta(Post));
    expect(compile(ast).sql).toContain('select "s"."id" as "c0"');
  });

  test("an EXISTS subquery without a select selects 1", () => {
    const ast = rebuild(from(User, "u").select(({ u }) => u.id).ast, {
      wheres: [
        { kind: "bool", op: "and", expr: existsNode(bareQuery(tableSource("posts_tags", "pt", undefined))) },
      ],
    });
    expect(compile(ast).sql).toBe(
      'select "u"."id" as "c0" from "users" as "u" where exists (select 1 from "posts_tags" as "pt")',
    );
  });

  test("a query over a schemaless source with no select is refused", () => {
    expect(() => compile(bareQuery(tableSource("posts_tags", "pt", undefined)))).toThrow(
      'The query has no select, and its root binding "pt" has no schema to read rows of. Add a select.',
    );
  });

  test("an empty values source and a ragged row are refused", () => {
    const empty = rebuild(bareQuery({ kind: "values", columns: ["a"], rows: [], alias: "v" }), {
      select: selectOne(col("v", "a")),
    });
    expect(() => compile(empty)).toThrow('The values source "v" has no rows.');
    const ragged = rebuild(
      bareQuery({ kind: "values", columns: ["a", "b"], rows: [[value(1)]], alias: "v" }),
      {
        select: selectOne(col("v", "a")),
      },
    );
    expect(() => compile(ragged)).toThrow(
      'Row 0 of the values source "v" does not have one value per column.',
    );
  });

  test("a fragment source may leave out its column list", () => {
    const ast = rebuild(
      bareQuery({ kind: "fragmentSource", fragment: frag`unnest(array[1, 2])`, columns: [], alias: "n" }),
      {
        select: selectOne(col("n", "n")),
      },
    );
    expect(compile(ast).sql).toBe('select "n"."n" as "c0" from unnest(array[1, 2]) as "n"');
  });

  test("an unknown source kind is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      joins: [
        { kind: "join", type: "inner", source: { kind: "lake", alias: "l" } as never, on: literalNode(true) },
      ],
    });
    expect(() => compile(ast)).toThrow('Unknown source kind "lake".');
  });

  test("a scalar subquery can refer to the enclosing query's bindings", () => {
    const inner = rebuild(from(Post, "p").ast, {
      wheres: [{ kind: "bool", op: "and", expr: binaryNode("eq", col("p", "author_id"), col("u", "id")) }],
      select: selectOne(col("p", "title")),
      limit: value(1),
    });
    const ast = rebuild(from(User, "u").ast, {
      select: selectObject({ title: { kind: "subquery", query: inner } }),
    });
    expect(compile(ast).sql).toBe(
      'select (select "p"."title" as "c0" from "posts" as "p" where "p"."author_id" = "u"."id" limit $1) as "c0" from "users" as "u"',
    );
  });
});
