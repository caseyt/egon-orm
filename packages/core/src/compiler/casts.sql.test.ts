import { describe, expect, test } from "vitest";
import { createCompiler } from "./compiler.js";
import { CAST_CASES } from "./sql-cases.js";
import { DIALECTS, run } from "./sql-fixtures.js";

describe.each(DIALECTS)("bound values typed by an operand or a column on $name", (dialect) => {
  for (const sqlCase of CAST_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});
