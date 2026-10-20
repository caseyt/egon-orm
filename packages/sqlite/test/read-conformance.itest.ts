// The read conformance suite, run against SQLite, in a time zone with daylight saving (as
// the adapter suite is) so that a conversion depending on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { runReadConformance } from "../../core/test/conformance/read/index.js";
import { SQLITE_READ_PROFILE } from "./read-profile.js";

runReadConformance(SQLITE_READ_PROFILE);
