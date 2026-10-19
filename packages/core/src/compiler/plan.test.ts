import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OutputPlan, OutputPreload } from "../contracts/adapter.js";
import { from } from "../index.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { mergeProvenance, resolveTableSchema } from "./plan.js";
import { bareQuery, frag, rebuild, selectBinding } from "./sql-fixtures.js";

type Row = Extract<OutputPlan, { kind: "row" }>;

function row(schema: string | undefined, preloads: readonly OutputPreload[] = [], nullable = false): Row {
  return { kind: "row", meta: meta(Post), aliases: ["c0"], key: ["c0"], schema, nullable, preloads };
}

describe("resolveTableSchema", () => {
  test("the source's own, else the schema's declared one, else the query's", () => {
    const declares = { ...meta(User), schema: "declared" };
    expect(resolveTableSchema("source", declares, "query")).toBe("source");
    expect(resolveTableSchema(undefined, declares, "query")).toBe("declared");
    expect(resolveTableSchema(undefined, meta(User), "query")).toBe("query");
    expect(resolveTableSchema(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("mergeProvenance", () => {
  test("a missing side leaves the main output as it is", () => {
    const main = row("a");
    expect(mergeProvenance(main, undefined)).toBe(main);
    expect(mergeProvenance(undefined, main)).toBeUndefined();
  });

  test("rows that agree keep the schema; rows that differ take the declared one", () => {
    const main = row("a");
    expect(mergeProvenance(main, row("a"))).toBe(main);
    expect(mergeProvenance(main, row("b"))).toEqual({ ...main, schema: meta(Post).schema });
  });

  test("a nullable branch makes the merged row nullable", () => {
    expect((mergeProvenance(row("a"), row("b", [], true)) as Row).nullable).toBe(true);
  });

  test("a branch of another structure leaves the main output", () => {
    const main = row("a");
    expect(mergeProvenance(main, { kind: "value", alias: "c0", type: undefined })).toBe(main);
    expect(mergeProvenance(main, { ...row("b"), meta: meta(User) })).toBe(main);
    const object: OutputPlan = { kind: "object", keys: ["a"], values: [main] };
    expect(mergeProvenance(object, { kind: "tuple", items: [] })).toBe(object);
    expect(mergeProvenance(object, { kind: "object", keys: [], values: [] })).toBe(object);
    const tuple: OutputPlan = { kind: "tuple", items: [main] };
    expect(mergeProvenance(tuple, object)).toBe(tuple);
    expect(mergeProvenance(tuple, { kind: "tuple", items: [] })).toBe(tuple);
    const value: OutputPlan = { kind: "constant", index: 0 };
    expect(mergeProvenance(value, { kind: "constant", index: 0 })).toBe(value);
  });

  test("objects and tuples merge leaf by leaf", () => {
    expect(
      mergeProvenance(
        { kind: "object", keys: ["p"], values: [row("a")] },
        { kind: "object", keys: ["p"], values: [row("b")] },
      ),
    ).toEqual({ kind: "object", keys: ["p"], values: [row(undefined)] });
    expect(
      mergeProvenance(
        { kind: "tuple", items: [row("a"), row("x")] },
        { kind: "tuple", items: [row("b"), row("x")] },
      ),
    ).toEqual({
      kind: "tuple",
      items: [row(undefined), row("x")],
    });
  });

  test("join preloads merge too; separate-query preloads stay as they are", () => {
    const separate: OutputPreload = { assoc: "author", cardinality: "one", row: undefined };
    const joined = (schema: string): OutputPreload => ({
      assoc: "comments",
      cardinality: "many",
      row: row(schema),
    });
    const main = row("a", [separate, joined("a")]);
    expect(mergeProvenance(main, row("a", [separate, joined("a")]))).toBe(main);
    const merged = mergeProvenance(main, row("a", [separate, joined("b")])) as Row;
    expect(merged.schema).toBe("a");
    expect(merged.preloads[0]).toBe(separate);
    expect(merged.preloads[1]?.row).toEqual(row(undefined));
    // Lists of preloads that differ in length are left as they are.
    expect(mergeProvenance(main, row("a", [separate]))).toBe(main);
  });
});

describe("planning a source before it is written", () => {
  test("a subquery source with a CTE and a set operation of its own is planned like it is written", () => {
    const inner = rebuild(from(Post, "p").schema("archive").ast, {
      ctes: [
        {
          kind: "cte",
          name: "raw",
          query: frag`select 1`,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
        {
          kind: "cte",
          name: "recent",
          query: from(Post, "q").ast,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
      combinations: [
        {
          kind: "combination",
          op: "union",
          all: true,
          query: rebuild(bareQuery({ kind: "cteSource", name: "recent", meta: meta(Post), alias: "r" }), {
            select: selectBinding("r", meta(Post)),
          }),
        },
      ],
    });
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: inner, alias: "s" }), {
      select: selectBinding("s", meta(Post)),
    });
    const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
    expect(plan.sql).toContain('with "raw" as (select 1), "recent" as (select "q"."id" as "id"');
    // The branch reads "archive" too (the CTE inherits the query's schema), so the rows have one origin.
    expect((plan.output as Row).schema).toBe("archive");
  });
});
