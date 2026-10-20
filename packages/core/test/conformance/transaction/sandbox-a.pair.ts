import { test } from "vitest";
import { sandboxPeer } from "./sandbox-pair.js";

test(
  "in its sandbox, writes the email sandbox-b.pair.ts writes, and sees only its own row",
  sandboxPeer("a"),
);
