/**
 * `egon gen migration`: the migration file template, and the `createTable` scaffold made
 * from schema classes (`--from-schema`).
 *
 * @module
 */
import { type AnySchema, type FieldMeta, meta, type SchemaMeta } from "egon-orm";

/** A migration name as the file name carries it: lower-case letters, digits and underscores. */
export const MIGRATION_NAME = /^[a-z0-9_]+$/;

/**
 * The version of a migration generated at `now`: its UTC time as `YYYYMMDDHHMMSS`.
 *
 * @example
 * ```ts
 * versionAt(new Date("2026-10-12T09:30:00Z")); // "20261012093000"
 * ```
 */
export function versionAt(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    pad(now.getUTCFullYear(), 4) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

/**
 * The source of an empty migration file.
 *
 * @example
 * ```ts
 * const source = migrationTemplate();
 * ```
 */
export function migrationTemplate(body = ""): string {
  return `import { defineMigration } from "egon-orm/migration";

export default defineMigration({
  change(m) {
${body}  },
});
`;
}

const json = (value: unknown): string => JSON.stringify(value);

/** `decimal(10,2)`, `timestamp(us)`: the parameters a built-in type keeps only in its name. */
const DECIMAL_NAME = /^decimal\((\d+),(\d+)\)$/;
const PRECISION_NAME = /^(?:timestamp|localTimestamp)\((s|us)\)$/;
const PRECISION_DIGITS: Readonly<Record<string, number>> = { s: 0, us: 6 };

/** The column builder call for a field: `t.text("email")`, without modifiers. */
function columnCall(table: string, field: FieldMeta, notes: string[]): string {
  const db = field.type.db;
  const column = json(field.column);
  switch (db.kind) {
    case "array":
      return `t.array(${column}, ${json(columnType(db.of))})`;
    case "custom":
      return `t.custom(${column}, ${json(db.sql)})`;
    case "decimal": {
      const match = DECIMAL_NAME.exec(field.type.name);
      return match === null
        ? `t.decimal(${column})`
        : `t.decimal(${column}, { precision: ${match[1]}, scale: ${match[2]} })`;
    }
    case "timestamp":
    case "timestamptz": {
      const match = PRECISION_NAME.exec(field.type.name);
      const precision = match === null ? undefined : PRECISION_DIGITS[match[1] as string];
      return precision === undefined
        ? `t.${db.kind}(${column})`
        : `t.${db.kind}(${column}, { precision: ${precision} })`;
    }
    default:
      if (field.type.name === "enum" && db.kind === "text") {
        notes.push(
          `${table}.${field.column} is an enum; to check its values in the database, use t.enumText(${column}, [/* its values */]).`,
        );
      }
      return `t.${db.kind}(${column})`;
  }
}

type DbTypeOf = FieldMeta["type"]["db"];

function columnType(db: DbTypeOf): unknown {
  if (db.kind === "array") return { kind: "array", of: columnType(db.of) };
  if (db.kind === "custom") return { kind: "custom", sql: db.sql };
  return db.kind;
}

/**
 * A default the migration can state as a constant, as the database stores it (the type's
 * `toDb`: a mapped enum's stored value, not its key); `undefined` when it cannot.
 */
function constantDefault(field: FieldMeta): string | undefined {
  const spec = field.default;
  if (spec?.kind !== "value") return undefined;
  let value: unknown;
  try {
    value = spec.value === null ? null : field.type.toDb(spec.value);
  } catch {
    return undefined;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return json(value);
    case "number":
      return Number.isFinite(value) ? String(value) : undefined;
    case "bigint":
      return `${value}n`;
    case "object":
      return value === null || Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype
        ? json(value)
        : undefined;
    default:
      return undefined;
  }
}

/** The `createTable` call for one schema class, indented for the body of `change`. */
function createTableFor(schemaMeta: SchemaMeta, notes: string[]): string {
  const table = schemaMeta.source as string;
  const lines: string[] = [];
  const references = new Map<string, { table: string; schema: string | undefined; column: string }>();
  for (const assoc of schemaMeta.assocs().values()) {
    if (assoc.kind !== "belongsTo" || assoc.ownerKey.length !== 1) continue;
    const target = meta(assoc.target());
    const related = target.fieldsByName.get(assoc.relatedKey[0] as string);
    if (target.source === null || related === undefined) continue;
    references.set(assoc.ownerKey[0] as string, {
      table: target.source,
      schema: target.schema,
      column: related.column,
    });
  }
  const keys = schemaMeta.primaryKey;
  for (const field of schemaMeta.persisted) {
    const fieldNotes: string[] = [];
    let call: string;
    const kind = field.type.db.kind;
    const reference = references.get(field.name);
    if (
      keys.length === 1 &&
      field.primaryKey &&
      field.dbGenerated &&
      (kind === "integer" || kind === "bigint")
    ) {
      const name = field.column === "id" && kind === "bigint" ? "" : json(field.column);
      call = `t.id(${name}${kind === "integer" ? ', { type: "integer" }' : ""})`;
    } else {
      if (reference !== undefined) {
        const options: string[] = [];
        if (kind !== "bigint") options.push(`type: ${json(columnType(field.type.db))}`);
        if (reference.column !== "id") options.push(`column: ${json(reference.column)}`);
        if (reference.schema !== undefined) options.push(`schema: ${json(reference.schema)}`);
        call = `t.references(${json(field.column)}, ${json(reference.table)}${options.length === 0 ? "" : `, { ${options.join(", ")} }`})`;
      } else {
        call = columnCall(table, field, notes);
      }
      if (!field.nullable) call += ".notNull()";
      const constant = constantDefault(field);
      if (constant !== undefined) call += `.default(${constant})`;
      else if (field.default !== undefined)
        fieldNotes.push("its default is set by the application, not written here");
      if (field.primaryKey) call += ".primaryKey()";
      if (field.autogenerate !== undefined) fieldNotes.push("the application generates its value");
      if (field.dbGenerated) fieldNotes.push("the database generates its value: give the column a default");
    }
    lines.push(`      ${call};${fieldNotes.length === 0 ? "" : ` // ${fieldNotes.join("; ")}`}`);
  }
  const options: string[] = [];
  if (schemaMeta.schema !== undefined) options.push(`schema: ${json(schemaMeta.schema)}`);
  if (keys.length === 0) options.push("primaryKey: false");
  const tail = options.length === 0 ? "" : `, { ${options.join(", ")} }`;
  return `    m.createTable(${json(table)}, (t) => {\n${lines.join("\n")}\n    }${tail});\n`;
}

/**
 * The body of `change` that creates the tables of `schemas`, and the notes for what a
 * schema does not say (unique indexes, enum values, defaults the application computes).
 * It is a one-time scaffold, not a diff.
 *
 * @example
 * ```ts
 * const { body, notes } = scaffoldFromSchemas([User]);
 * ```
 *
 * @throws TypeError when a schema is embedded (it has no table).
 */
export function scaffoldFromSchemas(schemas: readonly AnySchema[]): { body: string; notes: string[] } {
  const notes: string[] = [];
  const parts: string[] = [];
  for (const schema of schemas) {
    const schemaMeta = meta(schema);
    if (schemaMeta.source === null) {
      throw new TypeError(`${schemaMeta.name} is an embedded schema: it has no table to create.`);
    }
    parts.push(createTableFor(schemaMeta, notes));
    parts.push(
      `    // Unique indexes are not part of the schema: add m.createIndex(${json(schemaMeta.source)}, [/* columns */], { unique: true }) for each.\n`,
    );
  }
  const noteLines = notes.map((note) => `    // ${note}\n`).join("");
  return { body: parts.join("") + noteLines, notes };
}

/** The comment at the top of a scaffold. */
export function scaffoldHeader(file: string, names: readonly string[]): string {
  return `// Generated by \`egon gen migration --from-schema ${file}\` from ${names.join(", ")}.
// This is a one-time scaffold, not a diff: check it and edit it. Later schema changes need
// migrations of their own.
`;
}
