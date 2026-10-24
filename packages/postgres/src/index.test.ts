import { readFileSync } from "node:fs";
import { DatabaseError, QueryError } from "egon-orm";
import pg from "pg";
import { describe, expect, test } from "vitest";
import * as api from "./index.js";
import { postgres, VERSION } from "./index.js";

test("VERSION matches the version in package.json", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg).toMatchObject({ version: VERSION });
});

test("the package exports exactly these values", () => {
  // Adding a public export is a decision: update this list in the same change.
  expect(Object.keys(api).sort()).toEqual(["VERSION", "postgres"]);
});

describe("postgres", () => {
  test("is a Postgres adapter that connects on first use only", async () => {
    const adapter = postgres({ host: "127.0.0.1", port: 1, pool: { max: 2 } });
    expect(adapter.dialect).toBe("postgres");
    expect(adapter.capabilities.returning).toBe(true);
    expect(adapter.poolStats()).toEqual({ size: 0, idle: 0, waiting: 0 });
    await adapter.close();
  });

  test("normalises driver errors", () => {
    const adapter = postgres();
    const error = adapter.normalizeError(
      Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" }),
    );
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "deadlock", retryable: true });
  });

  test("checks its options when it is called", () => {
    expect(() => postgres({ hots: "db" } as never)).toThrow(TypeError);
    expect(() => postgres({ planCacheSize: 0 })).toThrow(/planCacheSize must be a positive whole number/);
    expect(() => postgres({ pool: new pg.Pool(), host: "db" })).toThrow(
      /cannot be combined with an existing pool/,
    );
  });

  test("runs statements through the pool it is given", async () => {
    const queries: unknown[] = [];
    const client = {
      query: async (config: unknown) => {
        queries.push(config);
        return { rows: [{ one: 1 }], rowCount: 1 };
      },
      release: () => undefined,
      getTransactionStatus: () => "I",
      on: () => undefined,
      off: () => undefined,
    };
    const pool = Object.assign(new pg.Pool(), { connect: async () => client });
    const adapter = postgres({ pool: pool as unknown as pg.Pool });
    await expect(adapter.execute("select 1 as one", [])).resolves.toEqual({
      rows: [{ one: 1 }],
      rowCount: 1,
      insertId: undefined,
    });
    expect(queries).toHaveLength(1);
    await adapter.close();
    await pool.end();
  });

  test("passes planCacheSize to the adapter", () => {
    expect(() => postgres({ planCacheSize: 10 })).not.toThrow();
  });

  test("cannot compile queries while this build has no SQL compiler", () => {
    expect(() => postgres().compileFragment({} as never)).toThrow(QueryError);
  });
});
