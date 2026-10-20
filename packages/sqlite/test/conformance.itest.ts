// The adapter conformance suite, run against SQLite, in a time zone with daylight saving
// so that a conversion depending on the process's zone shows up.
process.env.TZ = "Europe/Amsterdam";

import { runAdapterConformance } from "../../core/test/conformance/adapter/index.js";
import { SQLITE_PROFILE } from "./profile.js";

runAdapterConformance(SQLITE_PROFILE);
