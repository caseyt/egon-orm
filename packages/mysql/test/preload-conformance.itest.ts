// The preload conformance suite, run against MySQL (tier 2: EGON_TEST_TIER2=1), in a time
// zone with daylight saving (as the other suites are) so that a conversion depending on the
// process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { describe } from "vitest";
import { runPreloadConformance } from "../../core/test/conformance/preload/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_PRELOAD_PROFILE } from "./preload-profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runPreloadConformance(MYSQL_PRELOAD_PROFILE);
});
