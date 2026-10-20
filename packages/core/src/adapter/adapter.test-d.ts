import { describe, expectTypeOf, test } from "vitest";
import type {
  Adapter,
  AdapterDefinition,
  AdapterEvents,
  Connection,
  DatabaseAdapter,
  PoolEvent,
  PoolStats,
  QueryEvent,
  RawResult,
} from "../index.js";
import { createAdapter } from "../index.js";

declare const definition: AdapterDefinition;
const adapter = createAdapter(definition);

describe("createAdapter", () => {
  test("returns a DatabaseAdapter, which is an Adapter", () => {
    expectTypeOf(adapter).toEqualTypeOf<DatabaseAdapter>();
    expectTypeOf(adapter).toExtend<Adapter>();
    expectTypeOf(adapter).not.toBeAny();
  });

  test("takes a definition and nothing else", () => {
    // @ts-expect-error a definition is required
    createAdapter();
    // @ts-expect-error the dialect must be one Egon knows
    createAdapter({ ...definition, dialect: "oracle" });
    // @ts-expect-error driver fixes are keyed by column kind; a custom type has none
    createAdapter({ ...definition, driverCodecs: { custom: { fromDb: (value: unknown) => value } } });
    // A database without array columns stores an array as one value, with a fix of its own.
    createAdapter({ ...definition, driverCodecs: { array: { toDb: (value: unknown) => JSON.stringify(value) } } });
  });
});

describe("execution", () => {
  test("execute resolves to a RawResult, streams yield rows", async () => {
    expectTypeOf(adapter.execute("select 1", [])).resolves.toEqualTypeOf<RawResult>();
    expectTypeOf(adapter.stream("select 1", [])).toEqualTypeOf<AsyncIterable<Record<string, unknown>>>();
    expectTypeOf(adapter.acquire()).resolves.toEqualTypeOf<Connection>();
  });

  test("options are checked", () => {
    // @ts-expect-error timeoutMs is a number
    adapter.execute("select 1", [], { timeoutMs: "5" });
    // @ts-expect-error signal is an AbortSignal
    adapter.execute("select 1", [], { signal: true });
    // @ts-expect-error batchSize belongs to streams
    adapter.execute("select 1", [], { batchSize: 5 });
    adapter.stream("select 1", [], { batchSize: 5, timeoutMs: 100 });
  });

  test("begin takes the isolation levels by name only", async () => {
    const connection = await adapter.acquire();
    await connection.begin({ isolation: "serializable", readOnly: true, deferrable: true });
    // @ts-expect-error not an isolation level
    await connection.begin({ isolation: "snapshot" });
  });
});

describe("health and events", () => {
  test("ping and poolStats", () => {
    expectTypeOf(adapter.ping()).resolves.toBeVoid();
    expectTypeOf(adapter.poolStats()).toEqualTypeOf<PoolStats>();
    expectTypeOf<PoolStats>().toEqualTypeOf<PoolEvent>();
  });

  test("a listener receives the payload of its event", () => {
    adapter.on("query", (event) => {
      expectTypeOf(event).toEqualTypeOf<QueryEvent>();
    });
    adapter.on("poolExhausted", (event) => {
      expectTypeOf(event).toEqualTypeOf<AdapterEvents["poolExhausted"]>();
    });
    expectTypeOf(adapter.on("connect", () => undefined)).toEqualTypeOf<() => void>();
  });

  test("only a query listener takes options", () => {
    adapter.on("query", () => undefined, { params: true });
    // @ts-expect-error pool events take no options
    adapter.on("connect", () => undefined, { params: true });
    // @ts-expect-error unknown event
    adapter.on("queries", () => undefined);
    // @ts-expect-error the listener of "connect" gets a PoolEvent, not a QueryEvent
    adapter.on("connect", (event: QueryEvent) => event);
  });
});
