// A prepared query runs through the repo (step 12) like any query, with its named
// parameters. The repo does not yet take the plan from `PreparedQuery.plan()` (a Request in
// status 09); this checks that what it does today works.
import { User } from "@egon-orm/test-support";
import { expect, test } from "vitest";
import { createAdapter } from "../../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../../adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../../compiler/dialect.js";
import type { PoolEvent, RawResult } from "../../contracts/adapter.js";
import { from, param, prepare, t } from "../../index.js";
import { createRepo } from "../../repo/repo.js";

/** A driver that records each statement and answers with `rows`. */
function fakeDriver(rows: readonly Record<string, unknown>[]) {
  const statements: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
  const driver: DriverWrapper = {
    init(): void {},
    async acquire(): Promise<DriverConnection> {
      return {
        async query(sql, params): Promise<RawResult> {
          statements.push({ sql, params });
          return { rows, rowCount: rows.length, insertId: undefined };
        },
        async cursor(): Promise<DriverCursor> {
          throw new Error("no cursor in this test");
        },
        async cancel(): Promise<void> {},
        inTransaction: () => false,
      };
    },
    async release(): Promise<void> {},
    async destroy(): Promise<void> {},
    stats(): PoolEvent {
      return { size: 1, idle: 1, waiting: 0 };
    },
    saturated: () => false,
  };
  return { driver, statements };
}

test("repo.all runs a prepared query with its named parameters, one statement per run", async () => {
  const { driver, statements } = fakeDriver([{ c0: "Ann" }]);
  const adapter = createAdapter({
    dialect: "postgres",
    capabilities: POSTGRES_CAPABILITIES,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: () => driver,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  const repo = createRepo({ adapter });
  const byEmail = prepare(
    from(User, "u")
      .where(({ u }) => u.email.eq(param("email", t.string())))
      .select(({ u }) => u.name),
  );
  expect(await repo.all(byEmail, { email: "ann@example.com" })).toEqual(["Ann"]);
  expect(await repo.all(byEmail, { email: "bo@example.com" })).toEqual(["Ann"]);
  expect(statements.map((statement) => statement.params)).toEqual([["ann@example.com"], ["bo@example.com"]]);
  expect(statements[0]?.sql).toBe(statements[1]?.sql);
  expect(statements[0]?.sql).toBe(byEmail.plan(adapter).sql);
  // The name is required: the repo refuses a run without it.
  await expect(repo.all(byEmail, {} as never)).rejects.toThrow(/email/);
});
