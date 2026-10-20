import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mysql, VERSION } from "./index.js";

test("VERSION matches the version in package.json", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg).toMatchObject({ version: VERSION });
});

describe("mysql()", () => {
  test("makes an adapter without connecting", async () => {
    const adapter = mysql({ host: "127.0.0.1", port: 1, planCacheSize: 10 });
    expect(adapter.dialect).toBe("mysql");
    expect(adapter.capabilities.returning).toBe(false);
    await adapter.close();
    const defaults = mysql();
    expect(defaults.dialect).toBe("mysql");
    await defaults.close();
  });

  test("checks its options when it is created", () => {
    expect(() => mysql({ port: -1 })).toThrow(TypeError);
  });
});
