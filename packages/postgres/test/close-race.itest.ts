// close() and a server that ends the sessions straight after (step 21, robustness). pg-pool's
// end() resolves before its clients' sockets have closed, so a session the server
// terminates right after close() (a restart, pg_terminate_backend, DROP DATABASE ... WITH
// (FORCE)) is reported as an "error" event of the pool. Without a listener that event ends
// the process; the adapter used to remove its listener as soon as end() resolved.

import { withDatabase } from "@egon-orm/test-support";
import { expect, test } from "vitest";
import { postgres } from "../src/index.js";

test("sessions the server terminates right after close() do not end the process", () =>
  withDatabase("postgres", { label: "closerace" }, async (db) => {
    const errors: unknown[] = [];
    const onError = (error: unknown): void => {
      errors.push(error);
    };
    process.on("uncaughtException", onError);
    try {
      for (let round = 0; round < 15; round++) {
        const applicationName = `egon-close-race-${process.pid}-${round}`;
        const adapter = postgres({
          host: db.settings.host,
          port: db.settings.port,
          user: db.settings.user,
          password: db.settings.password,
          database: db.name,
          applicationName,
          pool: { max: 3 },
        });
        // Three idle connections in the pool.
        await Promise.all([1, 2, 3].map(() => adapter.execute("select pg_sleep(0.01)", [])));
        await adapter.close();
        await db.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1", [
          applicationName,
        ]);
      }
      // Let any late socket event arrive.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off("uncaughtException", onError);
    }
    expect(errors).toEqual([]);
  }));
