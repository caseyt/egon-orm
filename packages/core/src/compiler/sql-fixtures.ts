// Test fixtures for the compiler: the case type shared by the SQL snapshot tests
// (`*.sql.test.ts`) and the execution test (`sql.itest.ts`), helpers that build query ASTs
// by hand for the node kinds the query builder cannot produce yet (step 09), and two
// schemas besides the blog's. Imported by tests only.
import type { CompiledQuery, Dialect } from "../contracts/adapter.js";
import type {
  ExprNode,
  FragmentNode,
  QueryAst,
  QueryOperation,
  SelectShape,
  SourceNode,
  TableSourceNode,
} from "../contracts/query.js";
import type { SchemaMeta } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { collectParams, columnNode, fragmentNode, paramNode, shapeOf } from "../query/ast.js";
import { typeArgument } from "../query/expr.js";
import { meta, Schema, t } from "../schema/index.js";
import type { NamedValues } from "./bind.js";
import { bindParams } from "./bind.js";
import type { Compiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect, sqliteDialect } from "./dialect.js";

/** The dialects whose expected output the matrices hold. */
export const DIALECTS: readonly SqlDialect[] = [postgresDialect, mysqlDialect, sqliteDialect];

/** A table whose schema declares its own database schema, `audit`. */
export class AuditLog extends Schema(
  "audit_logs",
  {
    id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
    action: t.string(),
    userId: t.bigint({ mode: "number" }).nullable(),
  },
  { schema: "audit" },
) {}

/** A table without a primary key. */
export class Event extends Schema(
  "events",
  {
    name: t.string(),
    payload: t.json<Record<string, unknown>>().nullable(),
  },
  { primaryKey: false },
) {}

/** The DDL the execution test adds to the blog fixture for the two schemas above and the database schemas the cases use. */
export const EXTRA_DDL = `
CREATE SCHEMA audit;
CREATE TABLE audit.audit_logs (id bigserial PRIMARY KEY, action text NOT NULL, user_id bigint);
CREATE TABLE events (name text NOT NULL, payload jsonb);
CREATE SCHEMA tenant_1;
CREATE TABLE tenant_1.users (LIKE public.users INCLUDING ALL);
CREATE TABLE tenant_1.posts (LIKE public.posts INCLUDING ALL);
CREATE SCHEMA archive;
CREATE TABLE archive.users (LIKE public.users INCLUDING ALL);
CREATE TABLE archive.posts (LIKE public.posts INCLUDING ALL);
`;

/** What one dialect is expected to produce for a case: the SQL and the bound parameters. */
export interface ExpectedSql {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** What a dialect that lacks a feature the case needs gives instead: the `QueryError`'s message. */
export interface ExpectedError {
  readonly error: string;
}

/** A dialect's expected output for a case: its statement, or the error refusing it. */
export type Expected = ExpectedSql | ExpectedError;

/**
 * One statement of a snapshot matrix: how to compile it, the parameter array it was
 * compiled over, the named values to bind, and the expected output per dialect. The
 * Postgres output is written next to the case; the MySQL and SQLite output is in the
 * keyed tables of `sql-cases.mysql.ts` and `sql-cases.sqlite.ts`, by area and case name.
 */
export interface SqlCase {
  readonly name: string;
  readonly compile: (compiler: Compiler) => CompiledQuery;
  readonly params: readonly unknown[];
  readonly named: NamedValues | undefined;
  readonly expected: Readonly<Partial<Record<Dialect, Expected>>>;
}

/** The expected output of one dialect, by area and case name. */
export type DialectTable = Readonly<Record<string, Readonly<Record<string, Expected>>>>;

/**
 * The cases of one area with the expected output of the other dialects added, from their
 * keyed tables (`tables[dialect][area][case name]`). The snapshot tests check that every
 * case has an expectation for every dialect.
 *
 * @throws Error when two cases share a name, or a table names a case the area does not
 * have: the tables cannot drift from the cases.
 */
export function withDialects(
  area: string,
  cases: readonly SqlCase[],
  tables: Readonly<Partial<Record<Dialect, DialectTable>>>,
): readonly SqlCase[] {
  const names = new Set(cases.map((each) => each.name));
  if (names.size !== cases.length) throw new Error(`The ${area} matrix has two cases of one name.`);
  for (const [dialect, byArea] of Object.entries(tables)) {
    for (const name of Object.keys(byArea?.[area] ?? {})) {
      if (!names.has(name)) {
        throw new Error(`The ${dialect} table names "${name}", which the ${area} matrix has not.`);
      }
    }
  }
  return cases.map((each) => {
    const expected: Partial<Record<Dialect, Expected>> = { ...each.expected };
    for (const [dialect, byArea] of Object.entries(tables) as [Dialect, DialectTable | undefined][]) {
      const found = byArea?.[area]?.[each.name];
      if (found !== undefined) expected[dialect] = found;
    }
    return { ...each, expected };
  });
}

/** Options of {@link queryCase}. */
export interface QueryCaseOptions {
  readonly operation?: QueryOperation;
  readonly schema?: string;
  readonly named?: NamedValues;
}

/** A case that compiles a query AST. */
export function queryCase(
  name: string,
  ast: QueryAst | { readonly ast: QueryAst },
  postgres: ExpectedSql,
  options: QueryCaseOptions = {},
): SqlCase {
  const tree = "kind" in ast ? ast : ast.ast;
  return {
    name,
    compile: (compiler) => compiler.compile(tree, options.operation ?? "all", options.schema),
    params: tree.params,
    named: options.named,
    expected: { postgres },
  };
}

/** A case that compiles something other than a query (a row-level write, a fragment, an explain). */
export function statementCase(
  name: string,
  compile: (compiler: Compiler) => CompiledQuery,
  params: readonly unknown[],
  postgres: ExpectedSql,
  named?: NamedValues,
): SqlCase {
  return { name, compile, params, named, expected: { postgres } };
}

/**
 * Compiles a case and binds its parameters: what the snapshot tests compare. A dialect
 * that refuses the case gives its `QueryError`'s message.
 */
export function run(compiler: Compiler, sqlCase: SqlCase): Expected {
  let plan: CompiledQuery;
  try {
    plan = sqlCase.compile(compiler);
  } catch (error) {
    if (error instanceof QueryError) return { error: error.message };
    throw error;
  }
  return { sql: plan.sql, params: bindParams(plan.slots, sqlCase.params, sqlCase.named) };
}

/** The type a field builder names. */
export function typeOf(builder: unknown): AnyFieldType {
  return typeArgument(builder, "typeOf");
}

/**
 * A query AST with `patch` applied and its derived properties (`params`, `listLengths`,
 * `shape`) computed again, as the builder of step 09 will produce them.
 */
export function rebuild(base: QueryAst, patch: Partial<QueryAst>): QueryAst {
  const draft: QueryAst = { ...base, ...patch, params: [], listLengths: [], shape: 0 };
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(draft, params, lists);
  return { ...draft, params, listLengths: lists, shape: shapeOf(draft) };
}

/** A bare query over `from`, with every clause empty. */
export function bareQuery(from: SourceNode): QueryAst {
  return rebuild(
    {
      kind: "query",
      from,
      joins: [],
      wheres: [],
      select: undefined,
      distinct: undefined,
      groupBys: [],
      havings: [],
      orderBys: [],
      limit: undefined,
      offset: undefined,
      lock: undefined,
      combinations: [],
      ctes: [],
      windows: [],
      preloads: [],
      updates: [],
      schema: undefined,
      hints: [],
      params: [],
      listLengths: [],
      shape: 0,
    },
    {},
  );
}

/** `"table" AS "alias"` for a schema (or a schemaless table). */
export function tableSource(
  source: string,
  alias: string,
  schemaMeta: SchemaMeta | undefined,
  schema?: string,
): TableSourceNode {
  return { kind: "table", source, meta: schemaMeta, schema, alias };
}

/** The table source of a schema class. */
export function tableOf(
  schemaClass: Parameters<typeof meta>[0],
  alias: string,
  schema?: string,
): TableSourceNode {
  const m = meta(schemaClass);
  return tableSource(m.source as string, alias, m, schema);
}

/** A column node of `binding`. */
export function col(binding: string, column: string, field = column): ExprNode {
  return columnNode(binding, field, column);
}

/** An untyped parameter. */
export function value(v: unknown, type?: AnyFieldType): ExprNode {
  return paramNode(v, type, false);
}

/** A fragment node from a template, its interpolations given as nodes. */
export function frag(strings: TemplateStringsArray, ...args: ExprNode[]): FragmentNode {
  return fragmentNode(strings, args);
}

/** A select of named expressions: `{ key: expr, … }`. */
export function selectObject(entries: Readonly<Record<string, ExprNode>>): QueryAst["select"] {
  const keys = Object.keys(entries);
  const values: SelectShape[] = keys.map((key) => ({
    kind: "expr",
    expr: entries[key] as ExprNode,
    type: undefined,
  }));
  return { kind: "select", shape: { kind: "object", keys, values }, constants: [] };
}

/** A select of one expression. */
export function selectOne(expr: ExprNode, type?: AnyFieldType): QueryAst["select"] {
  return { kind: "select", shape: { kind: "expr", expr, type }, constants: [] };
}

/** A select of a whole binding. */
export function selectBinding(binding: string, schemaMeta: SchemaMeta): QueryAst["select"] {
  return { kind: "select", shape: { kind: "binding", binding, meta: schemaMeta }, constants: [] };
}
