#!/usr/bin/env node
// The `egon` executable.
import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2));
