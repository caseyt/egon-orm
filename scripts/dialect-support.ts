// Writes docs/site/reference/dialect-support.md from the capability tables of the dialect
// packages, so that the page cannot drift from what the adapters say they support.
//
//   pnpm docs:dialects          rewrites the page
//   pnpm docs:dialects --check  fails when the committed page differs (run by pnpm lint)
//
// Each row names a capability; its cells come from the tables. The prose of a row (what
// the feature is, what to do without it) is written here, and a note about one dialect
// states the value it explains, so a capability that changes cannot keep a stale note.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Capabilities, Dialect } from "egon-orm";
import { type DdlFeatures, migrationDialectOf } from "../packages/core/src/migration/dialect.js";
import { MYSQL_CAPABILITIES } from "../packages/mysql/src/dialect.js";
import { POSTGRES_CAPABILITIES } from "../packages/postgres/src/dialect.js";
import { SQLITE_CAPABILITIES } from "../packages/sqlite/src/dialect.js";

type Flag = { [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never }[keyof Capabilities];

const DIALECTS: readonly {
  readonly name: Dialect;
  readonly title: string;
  readonly capabilities: Capabilities;
}[] = [
  { name: "postgres", title: "Postgres", capabilities: POSTGRES_CAPABILITIES },
  { name: "sqlite", title: "SQLite", capabilities: SQLITE_CAPABILITIES },
  { name: "mysql", title: "MySQL 8", capabilities: MYSQL_CAPABILITIES },
];

/** What a dialect's cell says, when it is not a plain yes or no: the value it explains, and the text. */
interface Note {
  readonly when: boolean;
  readonly text: string;
}

interface Row {
  readonly capability: Flag;
  readonly feature: string;
  /** Shown under the table for the dialects without it. */
  readonly without?: string;
  readonly notes?: Readonly<Partial<Record<Dialect, Note>>>;
}

interface Section {
  readonly title: string;
  readonly intro?: string;
  readonly rows: readonly Row[];
}

const SECTIONS: readonly Section[] = [
  {
    title: "Queries",
    rows: [
      {
        capability: "fullJoin",
        feature: "`fullJoin`",
        without: "Write a `union` of a `leftJoin` and a `rightJoin`.",
      },
      {
        capability: "lateralJoin",
        feature: "`LATERAL` joins (query trees only; no builder method yet)",
      },
      {
        capability: "distinctOn",
        feature: "`distinct(callback)` (`DISTINCT ON`)",
        without: "Rank the rows with `rowNumber().over(...)` in a subquery and keep rank 1.",
      },
      {
        capability: "ilike",
        feature: "`ilike`",
        notes: {
          sqlite: { when: false, text: "as `LIKE`: case-insensitive for ASCII letters only" },
          mysql: { when: false, text: "as `LIKE`: the column's collation decides" },
        },
      },
      {
        capability: "nullsOrder",
        feature: "`nullsFirst()` / `nullsLast()`",
        without: "Order by `x.isNull()` first, then by the column.",
      },
      {
        capability: "arrays",
        feature: "Array columns and array operators",
        without:
          "Arrays are stored as JSON text (an array of the elements) and read back as arrays; the array operators and `in(arrayExpression)` are refused. Use `t.json()` and JSON functions to query inside them.",
      },
      {
        capability: "arrayParams",
        feature: "`in(list)` as one array parameter",
        notes: {
          sqlite: { when: false, text: "expanded to `in (?, ?, …)`" },
          mysql: { when: false, text: "expanded to `in (?, ?, …)`" },
        },
      },
      {
        capability: "jsonb",
        feature: "`jsonb` and its containment operators",
        notes: {
          sqlite: { when: false, text: "no; JSON is text, read with the JSON functions" },
          mysql: { when: false, text: "no; `json` columns, read with the JSON functions" },
        },
      },
      {
        capability: "aggregateFilter",
        feature: "`filter(...)` on an aggregate (`FILTER (WHERE …)`)",
        without: "Aggregate a `caseWhen(...)` that is null for the rows to leave out.",
      },
      { capability: "cteMaterialized", feature: "`withCte(..., { materialized })`" },
      {
        capability: "writingCtes",
        feature: "A CTE that writes (`updateAll` / `deleteAll` in `withCte`)",
        without: "Run the write first, in the same transaction.",
      },
      { capability: "intersectExceptAll", feature: "`intersectAll` / `exceptAll`" },
      {
        capability: "limitExpressions",
        feature: "`limit` / `offset` from an expression (not only a value or parameter)",
        without: "Compute the number first and pass it as a value.",
      },
      {
        capability: "explainOptions",
        feature: "`repo.explain` options (`analyze`, `format`, …)",
        notes: {
          mysql: { when: true, text: 'yes, except `analyze` with `format: "json"`' },
        },
      },
    ],
  },
  {
    title: "Writes",
    rows: [
      {
        capability: "returning",
        feature: "Rows returned from a write; `.returning(...)` on bulk writes",
        notes: {
          mysql: {
            when: false,
            text: "no: `insert` and `update` read the row back by its key; bulk writes return counts",
          },
        },
      },
      { capability: "onConflict", feature: "`onConflict` (upserts)" },
      {
        capability: "conflictTarget",
        feature: "`onConflict.target`",
        notes: {
          mysql: {
            when: false,
            text: "no: any unique key conflicts (`ON DUPLICATE KEY UPDATE`); leave `target` out",
          },
        },
      },
      { capability: "conflictConstraint", feature: "`onConflict.target: { constraint }`" },
      { capability: "insertDefaultValues", feature: "Inserting a row of defaults only" },
      {
        capability: "defaultInValues",
        feature: "`insertAll` rows with different fields (`DEFAULT` in `VALUES`)",
        without: "Give every row the same fields, or insert the rows in groups that share them.",
      },
      {
        capability: "updateJoin",
        feature: "Joins in `updateAll` / `deleteAll`",
        without: "Filter with `where(... in(subquery))` instead of a join.",
      },
    ],
  },
  {
    title: "Transactions and connections",
    rows: [
      { capability: "savepoints", feature: "Nested transactions (savepoints)" },
      {
        capability: "readOnlyTransactions",
        feature: "`transaction(..., { readOnly: true })`",
      },
      {
        capability: "deferrableTransactions",
        feature: "`deferrable: true` (serializable, read-only)",
      },
      {
        capability: "serializationFailures",
        feature: "Serializable transactions fail with a serialization error",
        notes: {
          mysql: {
            when: false,
            text: 'no: a conflict surfaces as a deadlock (`code: "deadlock"`), also retryable',
          },
        },
      },
      {
        capability: "ddlTransactions",
        feature: "DDL inside a transaction (migrations roll back as a whole)",
        notes: {
          mysql: {
            when: false,
            text: "no: each DDL statement commits; a migration that fails midway is left half-applied",
          },
        },
      },
      {
        capability: "multipleConnections",
        feature: "More than one connection",
        notes: {
          sqlite: {
            when: false,
            text: "no: one handle, used by one caller at a time; transactions run one after the other",
          },
        },
      },
      {
        capability: "cancel",
        feature: "Cancelling a running statement (`timeoutMs`, `signal`)",
        notes: {
          sqlite: {
            when: false,
            text: "no: a statement runs to its end; `timeoutMs` and `signal` bound the wait for the handle",
          },
        },
      },
      { capability: "stream", feature: "`repo.stream`" },
    ],
  },
  {
    title: "Values and errors",
    rows: [
      {
        capability: "nonFiniteFloats",
        feature: "`NaN` and infinities in float columns",
        without: "Writing one throws `CastError`; store it as null or as text.",
      },
      {
        capability: "exactDecimals",
        feature: "`t.decimal()` reads back as written and compares by value (`1.0` = `1.00`)",
        notes: {
          sqlite: { when: false, text: "no: stored as the text given, compared as text" },
          mysql: { when: false, text: "no: the column's scale is fixed (`1.0` reads back as `1.00`)" },
        },
      },
      {
        capability: "foreignKeyNames",
        feature: "Foreign-key violations name the constraint and the table",
        notes: {
          sqlite: { when: false, text: 'no: `ConstraintError` has `type: "foreignKey"` and no name' },
        },
      },
      {
        capability: "longIdentifiers",
        feature: "Identifiers longer than 64 bytes",
        notes: {
          postgres: { when: true, text: "yes, shortened to 63 bytes" },
          mysql: { when: false, text: "no: refused; name a long constraint yourself with `{ name }`" },
        },
      },
    ],
  },
];

/** Capabilities that are lists or numbers, shown in a table of their own. */
const LISTS = `## Locks, isolation levels and limits

| | ${DIALECTS.map((d) => d.title).join(" | ")} |
|---|${DIALECTS.map(() => "---").join("|")}|
| Row locks (\`lock(...)\`) | ${DIALECTS.map((d) => (d.capabilities.lockModes.length === 0 ? "accepted and not written (one writer at a time)" : d.capabilities.lockModes.map((m) => `\`${m}\``).join(", "))).join(" | ")} |
| Isolation levels | ${DIALECTS.map((d) => (d.capabilities.isolationLevels.length === 0 ? "none: one writer at a time, and asking for a level is refused" : d.capabilities.isolationLevels.join(", "))).join(" | ")} |
| Parameters per statement | ${DIALECTS.map((d) => d.capabilities.maxParams.toLocaleString("en-US")).join(" | ")} |

\`insertAll\` splits its rows into statements under the parameter limit. A statement that
needs more parameters than the limit (a very long \`in\` list, say) is refused with
\`QueryError\` before it is sent.
`;

function cell(row: Row, dialect: (typeof DIALECTS)[number]): string {
  const value = dialect.capabilities[row.capability];
  const note = row.notes?.[dialect.name];
  if (note !== undefined) {
    if (note.when !== value) {
      throw new Error(
        `The note on ${row.capability} for ${dialect.name} explains ${note.when}, but the capability is ${value}. Update the note in scripts/dialect-support.ts.`,
      );
    }
    return note.text;
  }
  return value ? "yes" : "no";
}

/** The text of the page. */
export function renderDialectSupport(): string {
  const flags = new Set<string>(
    Object.keys(POSTGRES_CAPABILITIES).filter(
      (key) => typeof POSTGRES_CAPABILITIES[key as Flag] === "boolean",
    ),
  );
  const listed = SECTIONS.flatMap((section) => section.rows.map((row) => row.capability));
  for (const flag of flags) {
    if (!listed.includes(flag as Flag))
      throw new Error(`The capability ${flag} has no row in scripts/dialect-support.ts.`);
  }
  let text = `<!-- Generated by scripts/dialect-support.ts from the capability tables of the dialect packages. Do not edit: run pnpm docs:dialects. -->

# Dialect support

Postgres, SQLite and MySQL 8 run the same schemas, changesets, queries and repo calls. This
page lists where they differ. It is generated from each adapter's capability table
(\`adapter.capabilities\`), so it says what the adapters do.

A query or write that needs a feature the database lacks throws \`QueryError\`, naming the
feature and the database, when it is compiled: nothing is sent, and nothing is emulated
behind your back. The conformance suites run on every database; a case that needs a
capability the database lacks is skipped, and the skip names the capability.
`;
  for (const section of SECTIONS) {
    text += `\n## ${section.title}\n\n| Feature | Capability | ${DIALECTS.map((d) => d.title).join(" | ")} |\n|---|---|${DIALECTS.map(() => "---").join("|")}|\n`;
    for (const row of section.rows) {
      text += `| ${row.feature} | \`${row.capability}\` | ${DIALECTS.map((d) => cell(row, d)).join(" | ")} |\n`;
    }
    const workarounds = section.rows.filter(
      (row) => row.without !== undefined && DIALECTS.some((d) => !d.capabilities[row.capability]),
    );
    if (workarounds.length > 0) {
      text += "\nWithout the feature:\n\n";
      for (const row of workarounds) {
        const missing = DIALECTS.filter((d) => !d.capabilities[row.capability]).map((d) => d.title);
        text += `- ${row.feature} (${missing.join(", ")}): ${row.without}\n`;
      }
    }
  }
  text += `\n${LISTS}`;
  text += migrations();
  text += `
## Constraint names

SQLite reports a unique violation by its columns, not by an index name. The adapter turns
that into the default constraint name (\`users_email_key\`, or \`users_pkey\` for the primary
key), so \`uniqueConstraint("email")\` matches; a custom \`name\` cannot be matched there,
except for a unique index on an expression, which SQLite reports by its name.

MySQL names the primary key \`PRIMARY\`; the adapter reports it as \`<table>_pkey\`. A unique
index created without a name is named after its first column (\`email\`), not
\`users_email_key\`: the migrations of this library always name it, and for one created
otherwise, pass its name to \`uniqueConstraint(…, { name })\`.
`;
  return text;
}

/** The DDL features of the migration tables, as the runner and the migration builder use them. */
const DDL_ROWS: readonly { readonly feature: keyof DdlFlags; readonly label: string }[] = [
  { feature: "schemas", label: "Tables in a database schema (`createSchema`, `schema` option)" },
  { feature: "extensions", label: "`createExtension`" },
  { feature: "concurrentIndexes", label: "`concurrently` index builds and drops" },
  { feature: "partialIndexes", label: "Partial indexes (`where`)" },
  { feature: "includeColumns", label: "Covering indexes (`include`)" },
  { feature: "exclusionConstraints", label: "Exclusion constraints" },
  { feature: "dropCascade", label: "`cascade` on drops" },
];

type DdlFlags = { [K in keyof DdlFeatures as DdlFeatures[K] extends boolean ? K : never]: boolean };

function migrations(): string {
  const tables = DIALECTS.map((d) => migrationDialectOf(d.name));
  let text = `\n## Migrations\n\nFrom the migration table of each dialect (\`features\`). A migration that uses a feature\nthe database lacks throws \`MigrationError\` before anything runs.\n\n| Feature | Feature flag | ${DIALECTS.map((d) => d.title).join(" | ")} |\n|---|---|${DIALECTS.map(() => "---").join("|")}|\n`;
  for (const row of DDL_ROWS) {
    text += `| ${row.label} | \`${row.feature}\` | ${tables.map((table) => (table.features[row.feature] ? "yes" : "no")).join(" | ")} |\n`;
  }
  text += `| DDL inside a transaction | \`ddlTransactions\` (capability) | ${DIALECTS.map((d) => (d.capabilities.ddlTransactions ? "yes" : "no")).join(" | ")} |\n`;
  text += `| The runner's lock | \`lock\` | ${tables.map((table) => (table.lock.kind === "session" ? "a lock of the session" : "a write transaction for the whole run")).join(" | ")} |\n`;
  return text;
}

const page = fileURLToPath(new URL("../docs/site/reference/dialect-support.md", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = renderDialectSupport();
  if (process.argv.includes("--check")) {
    if (readFileSync(page, "utf8") !== text) {
      process.stderr.write(
        "docs/site/reference/dialect-support.md is out of date with the capability tables. Run pnpm docs:dialects.\n",
      );
      process.exit(1);
    }
    process.stdout.write("ok: docs/site/reference/dialect-support.md matches the capability tables\n");
  } else {
    writeFileSync(page, text);
    process.stdout.write("wrote docs/site/reference/dialect-support.md\n");
  }
}
