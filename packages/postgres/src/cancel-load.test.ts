// node:net and node:tls are loaded when a cancel request is first sent, so the package
// loads on a runtime that lacks them, where only cancellation is unavailable.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CancelTarget } from "./cancel.js";

afterEach(() => {
  vi.doUnmock("node:net");
  vi.doUnmock("node:tls");
  vi.resetModules();
});

const target: CancelTarget = {
  host: "127.0.0.1",
  port: 1,
  serverName: "localhost",
  processId: 1,
  secretKey: 2,
  ssl: false,
  sslNegotiation: "postgres",
};

describe("loading the socket modules", () => {
  test("neither the package nor the cancel module imports node:net or node:tls when it loads", async () => {
    const loaded: string[] = [];
    vi.doMock("node:net", async (original) => {
      loaded.push("net");
      return original();
    });
    vi.doMock("node:tls", async (original) => {
      loaded.push("tls");
      return original();
    });
    const cancel = await import("./cancel.js");
    await import("./index.js");
    expect(loaded).toEqual([]);
    await cancel.loadSocketModules();
    expect(loaded.sort()).toEqual(["net", "tls"]);
  });

  test("where they are missing, a cancel request rejects with an explanation, and a later one tries again", async () => {
    let missing = true;
    vi.doMock("node:net", async (original) => {
      if (missing) throw new Error('No such module "node:net"');
      return original();
    });
    const cancel = await import("./cancel.js");
    const failure = await cancel.sendCancelRequest(target, 100).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Cancelling a statement needs node:net and node:tls, which this runtime does not provide (on Cloudflare Workers, enable the nodejs_compat flag).",
    );
    expect((failure as Error).cause).toBeInstanceOf(Error);
    missing = false;
    await expect(cancel.loadSocketModules()).resolves.toMatchObject({ connect: expect.any(Function) });
  });

  test("the modules are loaded once and shared by every request", async () => {
    const cancel = await import("./cancel.js");
    const first = cancel.loadSocketModules();
    expect(cancel.loadSocketModules()).toBe(first);
    await first;
  });
});
