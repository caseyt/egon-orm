// The transaction conformance suite (transactions, Batch, the sandbox), run against SQLite.
import { runTransactionConformance } from "../../core/test/conformance/transaction/index.js";
import { SQLITE_TRANSACTION_PROFILE } from "./transaction-profile.js";

runTransactionConformance(SQLITE_TRANSACTION_PROFILE);
