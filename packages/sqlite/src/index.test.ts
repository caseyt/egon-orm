import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sqlite, VERSION } from "./index.js";

test("VERSION matches the version in package.json", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg).toMatchObject({ version: VERSION });
});

describe("sqlite()", () => {
  test('an in-memory database (":memory:") runs statements and transactions on the handle', async () => {
    const adapter = sqlite({ filename: ":memory:", planCacheSize: 10 });
    expect(adapter.dialect).toBe("sqlite");
    expect(adapter.capabilities.returning).toBe(true);
    try {
      await adapter.execute("create table t (id integer primary key, v text not null unique)", []);
      const connection = await adapter.acquire();
      try {
        await connection.begin();
        await connection.execute("insert into t (v) values (?)", ["a"]);
        await connection.rollback();
      } finally {
        await connection.release();
      }
      expect((await adapter.execute("select count(*) as n from t", [])).rows).toEqual([{ n: 0 }]);
      await adapter.execute("insert into t (v) values (?)", ["a"]);
      await expect(adapter.execute("insert into t (v) values (?)", ["a"])).rejects.toMatchObject({
        type: "unique",
        constraint: "t_v_key",
      });
    } finally {
      await adapter.close();
    }
  });

  test("checks its options when it is created", () => {
    expect(() => sqlite({ filename: "" })).toThrow(TypeError);
  });
});
