// A stream whose session the server terminates mid-stream (step 21, robustness; found by the
// soak test). The read fails, and the cursor must then be given up: pg-cursor's close()
// waits for a readyForQuery that an ended connection never sends, which used to leave the
// stream (and its pooled connection) waiting forever, until every connection of the pool
// was held by a stream that would never finish.

import { withDatabase } from "@egon-orm/test-support";
import { createRepo, DatabaseError, from, Schema, t } from "egon-orm";
import { expect, test } from "vitest";
import { postgres } from "../src/index.js";

class Item extends Schema("items", { id: t.integer().primaryKey() }) {}

test("a stream whose session is terminated fails, returns its connection, and the pool goes on", () =>
  withDatabase("postgres", { label: "streamkill" }, async (db) => {
    await db.exec(
      "CREATE TABLE items (id integer PRIMARY KEY); INSERT INTO items SELECT generate_series(1, 50);",
    );
    const applicationName = `egon-stream-kill-${process.pid}`;
    const repo = createRepo({
      adapter: postgres({
        host: db.settings.host,
        port: db.settings.port,
        user: db.settings.user,
        password: db.settings.password,
        database: db.name,
        applicationName,
        pool: { max: 1 },
      }),
    });
    try {
      for (let round = 0; round < 3; round++) {
        const seen: number[] = [];
        const streaming = (async () => {
          for await (const item of repo.stream(
            from(Item, "i").orderBy(({ i }) => i.id),
            { batchSize: 1 },
          )) {
            seen.push(item.id);
            if (seen.length === 1) {
              await db.query(
                "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1",
                [applicationName],
              );
            }
          }
        })();
        const error = await streaming.then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe("connection");
        // The one connection of the pool came back: the next statement runs.
        expect(await repo.count(from(Item, "i"))).toBe(50);
      }
      const stats = repo.poolStats();
      expect(stats.size - stats.idle).toBe(0);
    } finally {
      await repo.close();
    }
  }));
