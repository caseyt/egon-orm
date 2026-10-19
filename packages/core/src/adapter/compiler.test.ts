import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { Capabilities } from "../contracts/adapter.js";
import type { FragmentNode, QueryAst } from "../contracts/query.js";
import type { SchemaMeta } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { from } from "../index.js";
import { createStatementCompiler, type StatementCompilerOptions } from "./compiler.js";

const options: StatementCompilerOptions = {
  dialect: "postgres",
  capabilities: POSTGRES_CAPABILITIES,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  planCacheSize: 10,
  codecs: { typeOverrides: () => undefined },
};

describe("createStatementCompiler", () => {
  test("compiles with the compiler's SQL table for the dialect", () => {
    const compiler = createStatementCompiler(options);
    const ast = from(User, "u").select(({ u }) => u.id).ast;
    const plan = compiler.compile(ast, "all", undefined);
    expect(plan.sql).toBe('select "u"."id" as "c0" from "users" as "u"');
    expect(compiler.compile(ast, "all", undefined)).toBe(plan);
  });

  test("checks features against the adapter's capabilities, the single source", () => {
    const capabilities: Capabilities = {
      ...POSTGRES_CAPABILITIES,
      fullJoin: false,
      lockModes: ["FOR UPDATE"],
    };
    const compiler = createStatementCompiler({ ...options, capabilities });
    const full = from(User, "u").fullJoin(User, "v", ({ u, v }) => u.id.eq(v.id)).ast;
    expect(() => compiler.compile(full, "all", undefined)).toThrow("FULL JOIN is not supported by postgres.");
    expect(compiler.compile(from(User, "u").lock("update").ast, "all", undefined).sql).toMatch(
      / for update$/,
    );
    expect(() => compiler.compile(from(User, "u").lock("share").ast, "all", undefined)).toThrow(
      'The lock clause "FOR SHARE" is not one postgres accepts as a string',
    );
  });

  test("refuses capabilities whose lock clauses the SQL table cannot write", () => {
    const capabilities: Capabilities = { ...POSTGRES_CAPABILITIES, lockModes: ["FOR UPDATE OF NOTHING"] };
    expect(() => createStatementCompiler({ ...options, capabilities })).toThrow(
      'The capabilities of postgres accept the lock clause "FOR UPDATE OF NOTHING", which its SQL dialect table cannot write.',
    );
  });

  test("refuses a quoteIdentifier that quotes otherwise than the SQL table", () => {
    expect(() => createStatementCompiler({ ...options, quoteIdentifier: (name) => `\`${name}\`` })).toThrow(
      "The adapter's quoteIdentifier does not quote as the postgres SQL dialect table does.",
    );
  });

  const ast = {} as QueryAst;
  const meta = {} as SchemaMeta;
  const stub = createStatementCompiler({ ...options, dialect: "mysql" });

  test.each([
    ["compile", () => stub.compile(ast, "all", undefined)],
    ["compileExplain", () => stub.compileExplain(ast, "all", undefined, {})],
    ["compileFragment", () => stub.compileFragment({} as FragmentNode)],
    [
      "compileInsert",
      () =>
        stub.compileInsert(
          meta,
          [],
          { source: { kind: "values", rows: 1 }, returning: [], onConflict: undefined },
          undefined,
        ),
    ],
    ["compileUpdate", () => stub.compileUpdate(meta, [], [], [], undefined)],
    ["compileDelete", () => stub.compileDelete(meta, [], [], undefined)],
  ])("%s throws QueryError for a dialect without a SQL table yet", (method, call) => {
    expect(call).toThrow(QueryError);
    expect(call).toThrow(`adapter.${method}() cannot compile for mysql`);
  });
});
