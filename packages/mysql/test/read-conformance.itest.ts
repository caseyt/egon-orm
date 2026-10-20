// The read conformance suite, run against MySQL (tier 2: EGON_TEST_TIER2=1), in a time
// zone with daylight saving (as the adapter suite is) so that a conversion depending on
// the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { describe } from "vitest";
import { runReadConformance } from "../../core/test/conformance/read/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_READ_PROFILE } from "./read-profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runReadConformance(MYSQL_READ_PROFILE);
});
