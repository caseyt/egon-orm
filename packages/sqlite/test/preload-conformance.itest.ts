// The preload conformance suite, run against SQLite, in a time zone with daylight saving
// (as the other suites are) so that a conversion depending on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { runPreloadConformance } from "../../core/test/conformance/preload/index.js";
import { SQLITE_PRELOAD_PROFILE } from "./preload-profile.js";

runPreloadConformance(SQLITE_PRELOAD_PROFILE);
