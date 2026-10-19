import { describe, expect, test } from "vitest";
import { createCompiler } from "./compiler.js";
import { AGGREGATE_CASES, WHERE_CASES } from "./sql-cases.js";
import { DIALECTS, run } from "./sql-fixtures.js";

describe.each(DIALECTS)("conditions and operators on $name", (dialect) => {
  for (const sqlCase of WHERE_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

describe.each(DIALECTS)("aggregates and windows on $name", (dialect) => {
  for (const sqlCase of AGGREGATE_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});
