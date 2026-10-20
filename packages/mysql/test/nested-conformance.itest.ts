// The nested-write conformance suite, run against MySQL (tier 2: EGON_TEST_TIER2=1), in a
// time zone with daylight saving (as the other suites are) so that a conversion depending
// on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { describe } from "vitest";
import { runNestedConformance } from "../../core/test/conformance/nested/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_NESTED_PROFILE } from "./nested-profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runNestedConformance(MYSQL_NESTED_PROFILE);
});
