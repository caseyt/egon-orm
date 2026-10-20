// Every statement of the SQL snapshot matrices, executed on MySQL (tier 2: EGON_TEST_TIER2=1).
import { describe } from "vitest";
import { runCompilerConformance } from "../../core/test/conformance/compiler/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_COMPILER_PROFILE } from "./compiler-profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runCompilerConformance(MYSQL_COMPILER_PROFILE);
});
