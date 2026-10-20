// The migration conformance suite, run against SQLite.
import { runMigrationConformance } from "../../core/test/conformance/migration/index.js";
import { SQLITE_MIGRATION_PROFILE } from "./migration-profile.js";

runMigrationConformance(SQLITE_MIGRATION_PROFILE);
