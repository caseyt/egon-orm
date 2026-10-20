import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sqlite, VERSION } from "./index.js";

test("VERSION matches the version in package.json", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg).toMatchObject({ version: VERSION });
});

describe("sqlite()", () => {
  test("makes an adapter without opening the file", async () => {
    const adapter = sqlite({ filename: "/no/such/directory/never-opened.db", planCacheSize: 10 });
    expect(adapter.dialect).toBe("sqlite");
    expect(adapter.capabilities.returning).toBe(true);
    await adapter.close();
  });

  test("checks its options when it is created", () => {
    expect(() => sqlite({ filename: "" })).toThrow(TypeError);
  });
});
