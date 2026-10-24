// The soak test (step 21, robustness). Opt-in: not part of `pnpm test:integration` or CI on
// pull requests. Run it with `pnpm test:soak` (2 minutes by default) or, for the release
// gate, `EGON_SOAK_MINUTES=30 pnpm test:soak`. The report is written to
// `EGON_SOAK_REPORT` (default: soak-report.json in the working directory) and the summary to
// standard output. `EGON_SOAK_PAUSE_MS="min,max"` sets the pause after each operation (a
// lower one is a heavier load; the default keeps it moderate on a shared database server).
//
// It passes when, after a mixed workload with random pg_terminate_backend kills through a
// pool of 5: no connection is still checked out, close() returns, no backend of the workload
// is left on the server, nothing failed in a way a killed connection does not explain, no
// rejection went unhandled, the transfers kept their total, and the heap did not grow.

import { writeFile } from "node:fs/promises";
import { stdout } from "node:process";
import { createTestDatabase } from "@egon-orm/test-support";
import { expect, test } from "vitest";
import { runSoak, SOAK_DDL, SOAK_TOTAL } from "./workload.js";

const minutes = Number(process.env.EGON_SOAK_MINUTES ?? "2");
const durationMs = Math.round(minutes * 60_000);
/** The pause after each operation, in milliseconds: `EGON_SOAK_PAUSE_MS="min,max"` (default 20,100). */
const [pauseMin = 20, pauseMax = 100] = (process.env.EGON_SOAK_PAUSE_MS ?? "20,100").split(",").map(Number);
/** Heap growth allowed between the start (after warm-up) and the end of the run. */
const HEAP_GROWTH_LIMIT_MB = 16;

test(`a ${minutes}-minute mixed workload with random backend kills leaks nothing`, {
  timeout: durationMs + 120_000,
}, async () => {
  const handle = await createTestDatabase("postgres", { label: "soak", fixtures: ["blog"] });
  try {
    await handle.db.exec(SOAK_DDL);
    const report = await runSoak({
      db: handle.db,
      durationMs,
      workers: 6,
      poolMax: 5,
      pauseMs: [pauseMin, pauseMax],
      killEveryMs: [500, 3_000],
      sampleEveryMs: Math.max(5_000, Math.min(30_000, durationMs / 40)),
      progress: (line) => stdout.write(`${line}\n`),
    });
    const path = process.env.EGON_SOAK_REPORT ?? "soak-report.json";
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    const { heap, ...summary } = report;
    stdout.write(`${JSON.stringify({ ...summary, heapSamples: heap.length }, null, 2)}\n`);

    expect(report.unexpectedFailures).toEqual([]);
    expect(report.stuckWorkers).toBe(0);
    expect(report.unhandledRejections).toBe(0);
    expect(report.uncaughtExceptions).toBe(0);
    expect(report.kills).toBeGreaterThan(0);
    expect(report.maxBackends).toBeLessThanOrEqual(5);
    expect(report.finalPool.waiting).toBe(0);
    expect(report.finalPool.size - report.finalPool.idle).toBe(0);
    expect(report.closedCleanly).toBe(true);
    expect(report.backendsAfterClose).toBe(0);
    expect(report.accountTotal).toBe(SOAK_TOTAL);
    expect(report.heapGrowthMb).toBeLessThan(HEAP_GROWTH_LIMIT_MB);
  } finally {
    await handle.drop();
  }
});
