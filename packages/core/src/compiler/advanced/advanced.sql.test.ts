// SQL snapshots of the step 09 features on every dialect, and the plan-cache behaviour of
// queries that nest others.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { Dialect } from "../../contracts/adapter.js";
import { QueryError, shortMessageOf } from "../../errors.js";
import { from } from "../../index.js";
import { collectParams, shapeOf } from "../../query/ast.js";
import { bindParams } from "../bind.js";
import { createCompiler } from "../compiler.js";
import { postgresDialect } from "../dialect.js";
import { DIALECTS, type Expected, rebuild } from "../sql-fixtures.js";
import { MYSQL, POSTGRES, SQLITE } from "./advanced-cases.js";
import { ADVANCED_QUERIES } from "./advanced-queries.js";

const EXPECTED: Readonly<Record<Dialect, Readonly<Record<string, Expected>>>> = {
  postgres: POSTGRES,
  mysql: MYSQL,
  sqlite: SQLITE,
};

describe.each(DIALECTS)("step 09 statements on $name", (dialect) => {
  for (const entry of ADVANCED_QUERIES) {
    test(entry.name, () => {
      let actual: Expected;
      try {
        const plan = createCompiler(dialect).compile(entry.query.ast, entry.operation, undefined);
        actual = { sql: plan.sql, params: bindParams(plan.slots, entry.query.ast.params, entry.named) };
      } catch (error) {
        if (!(error instanceof QueryError)) throw error;
        actual = { error: shortMessageOf(error) };
      }
      expect(actual).toEqual(EXPECTED[dialect.name][entry.name]);
    });
  }

  test("every query has an expected output, and every expected output a query", () => {
    expect(Object.keys(EXPECTED[dialect.name]).sort()).toEqual(
      ADVANCED_QUERIES.map((entry) => entry.name).sort(),
    );
  });
});

describe("the builder keeps every built query's derived properties canonical", () => {
  for (const entry of ADVANCED_QUERIES) {
    test(entry.name, () => {
      const ast = entry.query.ast;
      const params: unknown[] = [];
      const lists: number[] = [];
      collectParams(ast, params, lists);
      expect(ast.params).toEqual(params);
      expect(ast.listLengths).toEqual(lists);
      expect(ast.shape).toBe(shapeOf(ast));
    });
  }
});

test("a query with no select over a CTE of nested objects is refused: it has no columns to return", () => {
  const nested = from(Post, "p").select(({ p }) => ({ a: { id: p.id } }));
  // withCte takes any query; cte(name, query) would refuse this one, so the reference is typed by a schema-less source.
  const q = from(User, "u").withCte("n", nested);
  const ast = rebuild(q.ast, { from: { kind: "cteSource", name: "n", meta: undefined, alias: "n" } });
  expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(
    /has no schema to read rows of/,
  );
});

test('exclude("withCte") removes every CTE and its parameters', () => {
  const q = from(User, "u")
    .withCte(
      "recent",
      from(Post, "p").where(({ p }) => p.views.gt(3)),
    )
    .where(({ u }) => u.age.gt(1));
  const without = q.exclude("withCte");
  expect(without.ast.ctes).toEqual([]);
  expect(without.ast.params).toEqual([1]);
  expect(without.ast.shape).toBe(shapeOf(without.ast));
});

test("the whole matrix compiled twice into one compiler hits the cache and never collides", () => {
  const compiler = createCompiler(postgresDialect);
  const first = ADVANCED_QUERIES.map((entry) =>
    compiler.compile(entry.query.ast, entry.operation, undefined),
  );
  const second = ADVANCED_QUERIES.map((entry) =>
    compiler.compile(entry.query.ast, entry.operation, undefined),
  );
  expect(second).toEqual(first);
  for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
  expect(compiler.stats().collisions).toBe(0);
});
