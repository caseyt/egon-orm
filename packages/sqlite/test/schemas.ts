// Database schemas on SQLite for the tests: a schema is an attached database, a file next
// to the test database (so `drop()` removes it). The adapter attaches them when it opens its
// handle (`sqlite({ attach })`); the test helper's own handle attaches them when it first
// copies a table into one.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestDatabase } from "../../core/test/support/index.js";

const FIXTURE = readFileSync(
  new URL("../../core/test/support/fixtures/blog.sqlite.sql", import.meta.url),
  "utf8",
);

/** The schema names the conformance suites copy tables into, each used by one suite only. */
export const SUITE_SCHEMAS: readonly string[] = [
  "tenant_a",
  "tenant_b",
  "tenant_w",
  "tenant_u",
  "history",
  "auth",
  "tenant",
];

/** The file of the attached database `schema` of `db`. */
export function schemaFile(db: TestDatabase, schema: string): string {
  return join(dirname(db.settings.database), `${schema}.sqlite`);
}

/** `{ schema: file }` for `sqlite({ attach })`. */
export function attachments(db: TestDatabase, schemas: readonly string[]): Record<string, string> {
  return Object.fromEntries(schemas.map((schema) => [schema, schemaFile(db, schema)]));
}

/**
 * The `create table` statement of the blog table `table`, placed in `schema`, without its
 * foreign keys (as Postgres's `like … including all` and MySQL's `create table … like` copy
 * none: the parent table need not be in that schema).
 */
export function blogTable(table: string, schema: string): string {
  const match = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(FIXTURE);
  if (match === null) throw new Error(`The SQLite blog fixture has no table ${table}.`);
  const columns = (match[1] as string).replace(/\s+REFERENCES \w+ \(\w+\)( ON DELETE CASCADE)?/g, "");
  return `create table "${schema}"."${table}" (${columns})`;
}

/** Which schemas the helper handle of each test database has attached. */
const attached = new Map<string, Set<string>>();

/** DDL for the helper handle of `db`: attach `schema` once, then a fresh copy of `table` in it. */
export function copyTableInto(schema: string, table: string, db: TestDatabase): string {
  const done = attached.get(db.name) ?? new Set<string>();
  attached.set(db.name, done);
  const statements: string[] = [];
  if (!done.has(schema)) {
    done.add(schema);
    statements.push(`attach database '${schemaFile(db, schema).replaceAll("'", "''")}' as "${schema}"`);
  }
  statements.push(`drop table if exists "${schema}"."${table}"`, blogTable(table, schema));
  return statements.join("; ");
}
