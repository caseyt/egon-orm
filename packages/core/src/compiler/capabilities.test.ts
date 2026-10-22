// Every capability is either checked when a statement is compiled (a dialect without it
// refuses the statement with a QueryError naming the feature and the dialect, before
// anything reaches the database) or describes behaviour that the conformance suites gate on
// (a skipped conformance case names the capability it needs). A capability added to the
// contract must be put in one of the two lists below.
import { Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { beginStatements } from "../adapter/adapter.js";
import type { Capabilities } from "../contracts/adapter.js";
import { QueryError } from "../errors.js";
import { from, t } from "../index.js";
import { binaryNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { ADVANCED_QUERIES } from "./advanced/advanced-queries.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect, sqliteDialect } from "./dialect.js";
import { ALL_CASES } from "./sql-cases.js";
import { rebuild, run, typeOf, value } from "./sql-fixtures.js";

const INTEGER = typeOf(t.integer());

type Flag = { [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never }[keyof Capabilities];

/** Compiles something that needs the capability; throws the dialect's refusal. */
type Probe = (dialect: SqlDialect) => void;

/** A case of the snapshot matrices, compiled. */
function matrixCase(area: string, name: string): Probe {
  const cases = ALL_CASES.find(([each]) => each === area)?.[1];
  const found = cases?.find((each) => each.name === name);
  if (found === undefined) throw new Error(`No case "${name}" in the ${area} matrix.`);
  return (dialect) => {
    const result = run(createCompiler(dialect), found);
    if ("error" in result) throw new QueryError("query.unsupportedFeature", result.error);
  };
}

/** A query of the step 09 matrix, compiled. */
function advancedQuery(name: string): Probe {
  const found = ADVANCED_QUERIES.find((each) => each.name === name);
  if (found === undefined) throw new Error(`No query "${name}" in the step 09 matrix.`);
  return (dialect) => {
    createCompiler(dialect).compile(found.query.ast, found.operation, undefined);
  };
}

/** The capabilities a statement needs at compile time, and a statement that needs each. */
const COMPILE_TIME: Readonly<Partial<Record<Flag, Probe>>> = {
  returning: matrixCase("bulk", "updateAll returning whole rows"),
  onConflict: matrixCase("writes", "insert or do nothing"),
  conflictTarget: matrixCase("writes", "insert or update every column on a field conflict"),
  conflictConstraint: matrixCase("writes", "insert or update named fields on a named constraint"),
  lateralJoin: matrixCase("joins", "an inner lateral join"),
  fullJoin: matrixCase("joins", "full join"),
  distinctOn: matrixCase("select", "distinct on"),
  arrays: matrixCase("where", "in an array expression"),
  nullsOrder: matrixCase("clauses", "order by with directions and nulls"),
  updateJoin: advancedQuery("an update with a join becomes UPDATE … FROM"),
  cteMaterialized: matrixCase("nested", "a CTE, materialized and not"),
  writingCtes: matrixCase("nested", "a CTE that deletes and returns rows"),
  intersectExceptAll: matrixCase("nested", "an intersect after a union applies to the union"),
  insertDefaultValues: (dialect) => {
    const insert = { source: { kind: "values", rows: 1 }, returning: [], onConflict: undefined } as const;
    createCompiler(dialect).compileInsert(meta(Tag), [], insert, undefined);
  },
  defaultInValues: matrixCase("writes", "insert two rows of defaults"),
  aggregateFilter: matrixCase("aggregates", "an aggregate with a filter"),
  explainOptions: (dialect) => {
    createCompiler(dialect).compileExplain(from(User, "u").ast, "all", undefined, { analyze: true });
  },
  limitExpressions: (dialect) => {
    const ast = rebuild(from(User, "u").ast, {
      limit: binaryNode("add", value(1, INTEGER), value(2, INTEGER)),
    });
    createCompiler(dialect).compile(ast, "all", undefined);
  },
  readOnlyTransactions: (dialect) => {
    beginStatements(dialect.name, { readOnly: true }, dialect.capabilities);
  },
  deferrableTransactions: (dialect) => {
    // Where read-only transactions exist, a deferrable one is also serializable and read-only.
    const options = dialect.capabilities.readOnlyTransactions
      ? ({ isolation: "serializable", readOnly: true, deferrable: true } as const)
      : { deferrable: true };
    beginStatements(dialect.name, options, dialect.capabilities);
  },
};

/**
 * The capabilities that describe how the database behaves rather than what SQL it takes.
 * Each is honoured by the adapter or by a fallback, and the conformance suites skip the
 * cases that depend on it by name.
 */
const BEHAVIOUR: readonly Flag[] = [
  "ilike", // lowered to LIKE (the dialect table's ilikeAsLike)
  "arrayParams", // lists are expanded to one placeholder per element
  "jsonb", // contains / containedBy / overlaps need it or arrays
  "cancel",
  "multipleConnections",
  "serializationFailures",
  "nonFiniteFloats",
  "exactDecimals",
  "foreignKeyNames",
  "longIdentifiers",
  "savepoints",
  "ddlTransactions",
  "stream",
];

/** Lists that are not flags: tested where they are used (locks, isolation levels, the parameter limit). */
const NOT_FLAGS: readonly (keyof Capabilities)[] = ["lockModes", "isolationLevels", "maxParams"];

test("every capability is in exactly one list", () => {
  const listed = [...Object.keys(COMPILE_TIME), ...BEHAVIOUR, ...NOT_FLAGS].sort();
  expect(listed).toEqual(Object.keys(postgresDialect.capabilities).sort());
});

describe.each([postgresDialect, mysqlDialect, sqliteDialect])("$name", (dialect) => {
  for (const [flag, probe] of Object.entries(COMPILE_TIME) as [Flag, Probe][]) {
    if (dialect.capabilities[flag]) {
      test(`${flag}: a statement that needs it compiles`, () => {
        expect(() => probe(dialect)).not.toThrow();
      });
    } else {
      test(`${flag}: a statement that needs it is refused, naming the dialect`, () => {
        expect(() => probe(dialect)).toThrow(QueryError);
        expect(() => probe(dialect)).toThrow(new RegExp(`\\b${dialect.name}\\b`));
      });
    }
  }
});
