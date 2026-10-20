// The adapter conformance suite, run against MySQL (tier 2: EGON_TEST_TIER2=1), in a time
// zone with daylight saving so that a conversion depending on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { describe } from "vitest";
import { runAdapterConformance } from "../../core/test/conformance/adapter/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_PROFILE } from "./profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runAdapterConformance(MYSQL_PROFILE);
});
