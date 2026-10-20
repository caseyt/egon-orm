// The nested-write conformance suite, run against SQLite, in a time zone with daylight
// saving (as the other suites are) so that a conversion depending on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { runNestedConformance } from "../../core/test/conformance/nested/index.js";
import { SQLITE_NESTED_PROFILE } from "./nested-profile.js";

runNestedConformance(SQLITE_NESTED_PROFILE);
