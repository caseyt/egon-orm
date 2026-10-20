// The write conformance suite, run against SQLite, in a time zone with daylight saving (as
// the other suites are) so that a conversion depending on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { runWriteConformance } from "../../core/test/conformance/write/index.js";
import { SQLITE_WRITE_PROFILE } from "./write-profile.js";

runWriteConformance(SQLITE_WRITE_PROFILE);
