import { describe, expectTypeOf, test } from "vitest";
import type { Adapter, CompiledQuery } from "../contracts/adapter.js";
import type { QueryAst } from "../contracts/query.js";
import {
  bindParams,
  type Compiler,
  createCompiler,
  type PlanCacheStats,
  postgresDialect,
  type SqlDialect,
  toSql,
} from "./index.js";

type CompileMethods =
  | "compile"
  | "compileExplain"
  | "compileFragment"
  | "compileInsert"
  | "compileUpdate"
  | "compileDelete";

describe("the compiler matches the adapter contract", () => {
  test("its compile methods are the Adapter's", () => {
    expectTypeOf<Compiler>().toExtend<Pick<Adapter, CompileMethods>>();
    expectTypeOf<Compiler["compile"]>().toEqualTypeOf<Adapter["compile"]>();
    expectTypeOf<Compiler["compileInsert"]>().toEqualTypeOf<Adapter["compileInsert"]>();
  });

  test("an adapter can delegate to it", () => {
    const compiler = createCompiler(postgresDialect, { planCacheSize: 10 });
    const methods: Pick<Adapter, CompileMethods> = compiler;
    expectTypeOf(methods.compile).returns.toEqualTypeOf<CompiledQuery>();
    expectTypeOf(compiler.stats()).toEqualTypeOf<PlanCacheStats>();
  });

  test("operations are the query operations only", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = {} as QueryAst;
    compiler.compile(ast, "updateAll", "tenant_1");
    // @ts-expect-error: not a query operation
    compiler.compile(ast, "insert", undefined);
    // @ts-expect-error: the schema argument is required (undefined for none)
    compiler.compile(ast, "all");
  });

  test("options are checked", () => {
    // @ts-expect-error: planCacheSize is a number
    createCompiler(postgresDialect, { planCacheSize: "big" });
    // @ts-expect-error: unknown option
    createCompiler(postgresDialect, { cache: 10 });
  });
});

describe("binding", () => {
  test("bindParams returns the driver's parameter array, never any", () => {
    const values = bindParams([], [], { a: 1 });
    expectTypeOf(values).toEqualTypeOf<unknown[]>();
    expectTypeOf(values).not.toBeAny();
    expectTypeOf(toSql({} as CompiledQuery, []).sql).toEqualTypeOf<string>();
  });

  test("named values are an object", () => {
    // @ts-expect-error: named values are an object, not an array
    bindParams([], [], [1]);
  });
});

describe("dialect tables", () => {
  test("a dialect must name every table operator", () => {
    const { operators, ...rest } = postgresDialect;
    const { gte: _gte, ...fewer } = operators;
    // @ts-expect-error: gte is missing
    const broken: SqlDialect = { ...rest, operators: fewer };
    expectTypeOf(broken).not.toBeAny();
  });

  test("placeholders are numbered or positional", () => {
    // @ts-expect-error: not a placeholder style
    const broken: SqlDialect = { ...postgresDialect, placeholder: "named" };
    expectTypeOf(broken.placeholder).toEqualTypeOf<"numbered" | "positional">();
  });
});
