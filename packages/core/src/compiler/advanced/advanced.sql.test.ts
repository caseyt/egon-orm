// SQL snapshots of the step 09 features on every dialect with expected output (Postgres;
// step 17 adds the others), and the plan-cache behaviour of queries that nest others.
import { describe, expect, test } from "vitest";
import { collectParams, shapeOf } from "../../query/ast.js";
import { bindParams } from "../bind.js";
import { createCompiler } from "../compiler.js";
import { postgresDialect } from "../dialect.js";
import { POSTGRES } from "./advanced-cases.js";
import { ADVANCED_QUERIES } from "./advanced-queries.js";

describe("step 09 statements on postgres", () => {
  for (const entry of ADVANCED_QUERIES) {
    test(entry.name, () => {
      const plan = createCompiler(postgresDialect).compile(entry.query.ast, entry.operation, undefined);
      const params = bindParams(plan.slots, entry.query.ast.params, entry.named);
      expect({ sql: plan.sql, params }).toEqual(POSTGRES[entry.name]);
    });
  }

  test("every query has an expected output, and every expected output a query", () => {
    expect(Object.keys(POSTGRES).sort()).toEqual(ADVANCED_QUERIES.map((entry) => entry.name).sort());
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

test("the whole matrix compiled twice into one compiler hits the cache and never collides", () => {
  const compiler = createCompiler(postgresDialect);
  const first = ADVANCED_QUERIES.map((entry) => compiler.compile(entry.query.ast, entry.operation, undefined));
  const second = ADVANCED_QUERIES.map((entry) => compiler.compile(entry.query.ast, entry.operation, undefined));
  expect(second).toEqual(first);
  for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
  expect(compiler.stats().collisions).toBe(0);
});
