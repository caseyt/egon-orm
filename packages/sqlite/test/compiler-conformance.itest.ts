// Every statement of the SQL snapshot matrices, executed on SQLite.
import { runCompilerConformance } from "../../core/test/conformance/compiler/index.js";
import { SQLITE_COMPILER_PROFILE } from "./compiler-profile.js";

runCompilerConformance(SQLITE_COMPILER_PROFILE);
