// The transaction conformance suite (transactions, Batch, the sandbox), run against Postgres.
import { runTransactionConformance } from "../../core/test/conformance/transaction/index.js";
import { POSTGRES_TRANSACTION_PROFILE } from "./transaction-profile.js";

runTransactionConformance(POSTGRES_TRANSACTION_PROFILE);
