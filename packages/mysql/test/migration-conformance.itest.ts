// The migration conformance suite, run against MySQL (tier 2: EGON_TEST_TIER2=1).
import { describe } from "vitest";
import { runMigrationConformance } from "../../core/test/conformance/migration/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_MIGRATION_PROFILE } from "./migration-profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runMigrationConformance(MYSQL_MIGRATION_PROFILE);
});
