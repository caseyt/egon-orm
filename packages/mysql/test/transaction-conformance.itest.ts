// The transaction conformance suite (transactions, Batch, the sandbox), run against MySQL
// (tier 2: EGON_TEST_TIER2=1).
import { describe } from "vitest";
import { runTransactionConformance } from "../../core/test/conformance/transaction/index.js";
import { tier2Enabled } from "../../core/test/support/index.js";
import { MYSQL_TRANSACTION_PROFILE } from "./transaction-profile.js";

describe.runIf(tier2Enabled())("mysql", () => {
  runTransactionConformance(MYSQL_TRANSACTION_PROFILE);
});
