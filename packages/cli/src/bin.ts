#!/usr/bin/env node
// The `egon` executable.
import { useFullErrorMessages } from "egon-orm";
import { messages } from "egon-orm/messages";
import { run } from "./cli.js";

// A development tool: its errors carry what to do about them (owner decision, 2026-10-22).
useFullErrorMessages(messages);

process.exitCode = await run(process.argv.slice(2));
