// Setup file of the unit and integration projects (vitest.config.ts): thrown errors carry
// their full message, so that a test can match the advice a message gives (ADR 0007).
// The default, short messages are tested where they are made: packages/core/src/errors.test.ts
// and packages/core/src/messages/index.test.ts turn this off for themselves.
import { useFullErrorMessages } from "../../src/errors.js";
import { messages } from "../../src/messages/catalog.js";

useFullErrorMessages(messages);
