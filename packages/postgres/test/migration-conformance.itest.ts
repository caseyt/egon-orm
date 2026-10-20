// The migration conformance suite (step 18), run against Postgres.
import { runMigrationConformance } from "../../core/test/conformance/migration/index.js";
import { POSTGRES_MIGRATION_PROFILE } from "./migration-profile.js";

runMigrationConformance(POSTGRES_MIGRATION_PROFILE);
