// Type tests for the adapter contract. The fake adapter below is the proof that the
// interface can be implemented without any type from the SQL back end, and that the
// repo-side code of steps 12, 13 and 16 can be written against the interface alone.
import { describe, expectTypeOf, test } from "vitest";
import type {
  Adapter,
  AdapterEvents,
  BeginOptions,
  Capabilities,
  CompiledQuery,
  ConflictTarget,
  ConflictUpdate,
  Connection,
  Dialect,
  ExecuteOptions,
  Executor,
  InsertCell,
  InsertPlanOptions,
  InsertSource,
  IsolationLevel,
  OnConflict,
  OutputPlan,
  OutputPreload,
  ParamSlot,
  QueryEvent,
  RawResult,
  RowDecoder,
} from "./adapter.js";
import type { ExprNode, FragmentNode, ParamNode, QueryAst, QueryOperation, SelectNode } from "./query.js";
import type { FieldMeta, RowMeta, SchemaMeta } from "./schema.js";
import { ROW } from "./schema.js";
import type { AnyFieldType, Codec } from "./type.js";

declare const ast: QueryAst;
declare const meta: SchemaMeta;
declare const field: FieldMeta;
declare const fragment: FragmentNode;
declare const stringType: AnyFieldType;

const insertOne: InsertPlanOptions = {
  source: { kind: "values", rows: 1 },
  returning: [field],
  onConflict: undefined,
};

const capabilities: Capabilities = {
  returning: true,
  onConflict: true,
  conflictTarget: true,
  ilike: true,
  lateralJoin: true,
  fullJoin: true,
  distinctOn: true,
  arrays: true,
  arrayParams: true,
  jsonb: true,
  nullsOrder: true,
  updateJoin: true,
  cteMaterialized: true,
  writingCtes: true,
  intersectExceptAll: true,
  insertDefaultValues: true,
  defaultInValues: true,
  aggregateFilter: true,
  cancel: true,
  readOnlyTransactions: true,
  deferrableTransactions: true,
  multipleConnections: true,
  serializationFailures: true,
  nonFiniteFloats: true,
  exactDecimals: true,
  explainOptions: true,
  limitExpressions: true,
  foreignKeyNames: true,
  conflictConstraint: true,
  longIdentifiers: true,
  lockModes: ["FOR UPDATE", "FOR SHARE"],
  isolationLevels: ["read committed", "repeatable read", "serializable"],
  savepoints: true,
  ddlTransactions: true,
  stream: true,
  maxParams: 65_535,
};

const plan: CompiledQuery = {
  sql: "select 1",
  slots: [],
  output: undefined,
  schema: undefined,
  decoder: undefined,
};
const result: RawResult = { rows: [], rowCount: 0, insertId: undefined };

async function* noRows(): AsyncIterable<Record<string, unknown>> {}

const connection: Connection = {
  execute: async () => result,
  stream: noRows,
  begin: async () => {},
  commit: async () => {},
  rollback: async () => {},
  savepoint: async () => {},
  rollbackTo: async () => {},
  releaseSavepoint: async () => {},
  inTransaction: () => false,
  release: async () => {},
  destroy: async () => {},
};

/** An adapter written against the contract only. */
const fake: Adapter = {
  dialect: "postgres",
  capabilities,
  compile: () => plan,
  compileFragment: () => plan,
  compileExplain: () => plan,
  compileInsert: () => plan,
  compileUpdate: () => plan,
  compileDelete: () => plan,
  execute: async () => result,
  stream: noRows,
  acquire: async () => connection,
  normalizeError: (error) => error,
  typeOverrides: () => undefined,
  on: () => () => {},
  close: async () => {},
};

describe("Adapter", () => {
  test("compile methods are synchronous, take the effective schema and return a CompiledQuery", () => {
    expectTypeOf(fake.compile(ast, "all", undefined)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compile(ast, "updateAll", "tenant_1")).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileUpdate(meta, [field], [field], [], "tenant_1")).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileDelete(meta, [field], [], undefined)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileInsert(meta, [field], insertOne, undefined)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileFragment(fragment)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf<QueryOperation>().toEqualTypeOf<"all" | "updateAll" | "deleteAll">();
    // @ts-expect-error not a query operation
    fake.compile(ast, "insert", undefined);
    // @ts-expect-error the database schema must be stated, even as undefined
    fake.compile(ast, "all");
    // @ts-expect-error the database schema must be stated for row-level writes too
    fake.compileUpdate(meta, [field], [field], []);
    // @ts-expect-error the database schema must be stated for deletes too
    fake.compileDelete(meta, [field], []);
    // @ts-expect-error the options are required
    fake.compileInsert(meta, [field], undefined, undefined);
    // @ts-expect-error a fragment, not a string: raw SQL text cannot be compiled
    fake.compileFragment("select 1");
  });

  test("execute and stream return rows as plain records, never any", () => {
    expectTypeOf(fake.execute("select 1", [])).resolves.toEqualTypeOf<RawResult>();
    expectTypeOf(fake.stream("select 1", [], { batchSize: 100 })).toEqualTypeOf<
      AsyncIterable<Record<string, unknown>>
    >();
    expectTypeOf<RawResult["rows"][number]>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<RawResult["rows"][number][string]>().toBeUnknown();
    // @ts-expect-error parameters are an array
    fake.execute("select 1", { id: 1 });
    // @ts-expect-error batchSize is a stream option only
    fake.execute("select 1", [], { batchSize: 1 });
  });

  test("an Adapter and a Connection are both Executors, so repo code takes either", () => {
    expectTypeOf(fake).toExtend<Executor>();
    expectTypeOf(connection).toExtend<Executor>();
    async function count(db: Executor): Promise<number> {
      return (await db.execute("select 1", [])).rowCount;
    }
    void [count(fake), count(connection)];
    // An adapter is not a connection: it cannot begin a transaction.
    expectTypeOf(fake).not.toExtend<Connection>();
  });

  test("transactions go through a Connection, with typed options", () => {
    expectTypeOf(fake.acquire()).resolves.toEqualTypeOf<Connection>();
    expectTypeOf(connection.begin).parameter(0).toEqualTypeOf<BeginOptions | undefined>();
    expectTypeOf<IsolationLevel>().toEqualTypeOf<"read committed" | "repeatable read" | "serializable">();
    connection.begin({ isolation: "serializable", readOnly: true, deferrable: true });
    // @ts-expect-error not an isolation level
    connection.begin({ isolation: "snapshot" });
    // @ts-expect-error a savepoint needs a name
    connection.savepoint();
    // Step 16: a connection whose ROLLBACK failed is destroyed, not returned to the pool.
    expectTypeOf(connection.destroy()).resolves.toBeVoid();
  });

  test("a connection implemented with the signatures from before ADR 0005 still is a Connection", () => {
    // A third-party adapter that ignores the execution options compiles unchanged.
    const legacy = {
      execute: async (_sql: string, _params: readonly unknown[]) => result,
      stream: noRows,
      begin: async (_options?: BeginOptions): Promise<void> => {},
      commit: async (): Promise<void> => {},
      rollback: async (): Promise<void> => {},
      savepoint: async (_name: string): Promise<void> => {},
      rollbackTo: async (_name: string): Promise<void> => {},
      releaseSavepoint: async (_name: string): Promise<void> => {},
      inTransaction: () => false,
      release: async (): Promise<void> => {},
      destroy: async (): Promise<void> => {},
    };
    expectTypeOf(legacy).toExtend<Connection>();
    const asConnection: Connection = legacy;
    void asConnection;
    // A method whose second parameter is not the execution options does not fit.
    const wrong = { ...legacy, savepoint: async (_name: string, _depth: number): Promise<void> => {} };
    expectTypeOf(wrong).not.toExtend<Connection>();
  });

  test("every transaction method takes execution options last, optionally (ADR 0005)", () => {
    expectTypeOf(connection.begin).parameter(1).toEqualTypeOf<ExecuteOptions | undefined>();
    expectTypeOf(connection.commit).parameter(0).toEqualTypeOf<ExecuteOptions | undefined>();
    expectTypeOf(connection.rollback).parameter(0).toEqualTypeOf<ExecuteOptions | undefined>();
    expectTypeOf(connection.savepoint).parameter(1).toEqualTypeOf<ExecuteOptions | undefined>();
    expectTypeOf(connection.rollbackTo).parameter(1).toEqualTypeOf<ExecuteOptions | undefined>();
    expectTypeOf(connection.releaseSavepoint).parameter(1).toEqualTypeOf<ExecuteOptions | undefined>();
    const options: ExecuteOptions = { timeoutMs: 1_000, signal: AbortSignal.abort(), context: { id: 1 } };
    connection.begin(undefined, options);
    connection.begin({ readOnly: true }, options);
    connection.commit(options);
    connection.rollback(options);
    connection.savepoint("a", options);
    connection.rollbackTo("a", options);
    connection.releaseSavepoint("a", options);
    // Existing callers compile unchanged.
    connection.commit();
    connection.savepoint("a");
    // @ts-expect-error the begin options come first
    connection.begin(options, { readOnly: true });
    // @ts-expect-error timeoutMs is a number
    connection.commit({ timeoutMs: "1s" });
    // @ts-expect-error the name comes first
    connection.savepoint(options);
  });

  test("typeOverrides answers with a codec or undefined", () => {
    const type = {} as AnyFieldType;
    expectTypeOf(fake.typeOverrides(type)).toEqualTypeOf<Codec | undefined>();
  });

  test("events are typed by name", () => {
    fake.on("query", (event) => {
      expectTypeOf(event).toEqualTypeOf<QueryEvent>();
      expectTypeOf(event.durationMs).toEqualTypeOf<number>();
      expectTypeOf(event.params).toEqualTypeOf<readonly unknown[] | undefined>();
      expectTypeOf(event.context).toBeUnknown();
    });
    fake.on("poolExhausted", (event) => expectTypeOf(event).toEqualTypeOf<AdapterEvents["poolExhausted"]>());
    expectTypeOf(fake.on("connect", () => {})).toEqualTypeOf<() => void>();
    // @ts-expect-error no such event
    fake.on("commit", () => {});
  });

  test("dialect and capabilities are closed sets", () => {
    expectTypeOf<Dialect>().toEqualTypeOf<"postgres" | "mysql" | "sqlite">();
    // @ts-expect-error not a dialect
    const bad: Adapter = { ...fake, dialect: "mssql" };
    // @ts-expect-error every capability must be stated
    const partial: Capabilities = { returning: true };
    // @ts-expect-error capabilities are booleans, lists or numbers, not strings
    const wrong: Capabilities = { ...capabilities, returning: "yes" };
    void [bad, partial, wrong];
  });

  test("an adapter is missing nothing and may not skip a member", () => {
    const { close: _close, ...withoutClose } = fake;
    // @ts-expect-error close is required
    const incomplete: Adapter = withoutClose;
    void incomplete;
  });
});

describe("ParamSlot", () => {
  test("discriminates on kind", () => {
    const slot = {} as ParamSlot;
    if (slot.kind === "inline" || slot.kind === "list") expectTypeOf(slot.index).toEqualTypeOf<number>();
    if (slot.kind === "element") expectTypeOf(slot.element).toEqualTypeOf<number>();
    if (slot.kind === "named") {
      expectTypeOf(slot.name).toEqualTypeOf<string>();
      // @ts-expect-error a named slot has no index
      slot.index;
    }
    expectTypeOf(slot.toDb).toEqualTypeOf<((value: unknown) => unknown) | undefined>();
    expectTypeOf(slot.redact).toEqualTypeOf<boolean>();
  });

  test("is enough to write bindParams", () => {
    function bindParams(
      slots: readonly ParamSlot[],
      params: readonly unknown[],
      named: Record<string, unknown>,
    ): unknown[] {
      const out = new Array<unknown>(slots.length);
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        let value: unknown;
        switch (slot.kind) {
          case "inline":
          case "list":
            value = params[slot.index];
            break;
          case "element":
            value = (params[slot.index] as readonly unknown[])[slot.element];
            break;
          case "named":
            value = named[slot.name];
            break;
          default:
            expectTypeOf(slot).toBeNever();
        }
        out[i] = slot.toDb === undefined || value === null ? value : slot.toDb(value);
      }
      return out;
    }
    expectTypeOf(bindParams).returns.toEqualTypeOf<unknown[]>();
  });

  test("rejects incomplete and unknown slots", () => {
    // @ts-expect-error toDb must be given, even as undefined
    const a: ParamSlot = { kind: "inline", index: 0, redact: false };
    // @ts-expect-error an element slot needs its element
    const b: ParamSlot = { kind: "element", index: 0, toDb: undefined, redact: false };
    // @ts-expect-error no such kind
    const c: ParamSlot = { kind: "positional", index: 0, toDb: undefined, redact: false };
    // @ts-expect-error whether the value is redacted must be stated
    const d: ParamSlot = { kind: "named", name: "x", toDb: undefined };
    void [a, b, c, d];
  });
});

describe("CompiledQuery and OutputPlan", () => {
  test("only the decoder can be assigned after creation", () => {
    const decoder: RowDecoder = (row, constants) => [row.c0, constants[0]];
    plan.decoder = decoder;
    expectTypeOf(decoder).parameter(1).toEqualTypeOf<readonly unknown[]>();
    // @ts-expect-error the database schema a plan resolved to is fixed
    plan.schema = "other";
    // @ts-expect-error the sql is fixed
    plan.sql = "select 2";
    // @ts-expect-error the slots are fixed
    plan.slots = [];
    expectTypeOf(decoder).returns.toBeUnknown();
  });

  test("an output plan mirrors objects, tuples, rows and values", () => {
    const output: OutputPlan = {
      kind: "object",
      keys: ["id", "author", "pair"],
      values: [
        { kind: "value", alias: "c0", type: undefined },
        {
          kind: "row",
          meta,
          aliases: ["c1", "c2"],
          key: ["c1"],
          schema: undefined,
          nullable: false,
          preloads: [],
        },
        { kind: "tuple", items: [{ kind: "value", alias: "c3", type: undefined }] },
      ],
    };
    if (output.kind === "object") expectTypeOf(output.values).toEqualTypeOf<readonly OutputPlan[]>();
    // @ts-expect-error a value needs its alias
    const bad: OutputPlan = { kind: "value", type: undefined };
    void bad;
  });
});

describe("insert options", () => {
  test("cover every conflict action and conflict target form", () => {
    const updates: ConflictUpdate[] = ["all", [field], { except: [field] }];
    const targets: ConflictTarget[] = [[field], { constraint: "users_email_key" }, fragment];
    const forms: OnConflict[] = [
      "nothing",
      { target: targets[0], update: updates[0]! },
      { target: targets[1], update: updates[1]! },
      { target: targets[2], update: updates[2]! },
      // No target: the only form MySQL accepts.
      { target: undefined, update: "all" },
    ];
    const options: InsertPlanOptions = {
      source: { kind: "values", rows: 2 },
      returning: [],
      onConflict: forms[1],
    };
    const raises: InsertPlanOptions = {
      source: { kind: "values", rows: 2 },
      returning: [],
      onConflict: undefined,
    };
    void [options, raises];
    // @ts-expect-error raising is the absence of the option; it has no spelling
    const raise: OnConflict = "raise";
    // @ts-expect-error not a conflict action
    const bad: OnConflict = "ignore";
    // @ts-expect-error fields are FieldMeta, not names
    const names: OnConflict = { target: undefined, update: ["name"] };
    // @ts-expect-error the target must be stated, even as undefined
    const noTarget: OnConflict = { update: "all" };
    // @ts-expect-error doing nothing takes no target
    const nothingAt: OnConflict = { target: [field], update: "nothing" };
    // @ts-expect-error onConflict must be stated, even as undefined
    const unstated: InsertPlanOptions = { source: { kind: "values", rows: 1 }, returning: [] };
    void [raise, bad, names, noTarget, nothingAt, unstated];
  });
});

// ---------------------------------------------------------------------------
// The features of later steps, written against the contract alone. None of these could
// be written against the first version of the contract (step 02 review, findings 1-9).
// ---------------------------------------------------------------------------

function bindParams(slots: readonly ParamSlot[], params: readonly unknown[]): unknown[] {
  return slots.map((slot) =>
    slot.kind === "inline" || slot.kind === "list" ? params[slot.index] : undefined,
  );
}

describe("what steps 08 to 17 need from the contract", () => {
  test("step 12: a read in a per-call schema, without touching the AST, with rows stamped with that schema", () => {
    async function all(
      adapter: Adapter,
      query: QueryAst,
      options: { schema?: string },
      repoSchema: string | undefined,
    ) {
      // The argument is the weakest schema: the per-call option, else the repo default. A
      // database schema on the source, on the schema or on the query wins over it in the compiler.
      const compiled = adapter.compile(query, "all", options.schema ?? repoSchema);
      const raw = await adapter.execute(compiled.sql, bindParams(compiled.slots, query.params), {
        slots: compiled.slots,
        context: { operation: "all" },
      });
      const output = compiled.output;
      if (output === undefined || output.kind !== "row") return [];
      // The row's database schema is its own leaf's, not the statement's.
      const rowMeta = output.meta.rowMeta("loaded", output.schema);
      expectTypeOf(rowMeta).toEqualTypeOf<RowMeta>();
      return raw.rows.map((row) =>
        output.meta.create(
          output.aliases.map((alias) => row[alias]),
          rowMeta,
        ),
      );
    }
    expectTypeOf(all).returns.resolves.toEqualTypeOf<object[]>();
    expectTypeOf(plan.schema).toEqualTypeOf<string | undefined>();
  });

  test("steps 12 and 13: rows of a mixed-schema join are each written back where they were read", () => {
    type RowLeaf = Extract<OutputPlan, { kind: "row" }>;
    // repo default "tenant_1"; User declares none; Org declares "global"; Post is joined
    // with the per-source database schema "archive". One statement, three resolved database schemas.
    const leaf = (schema: string | undefined, aliases: string[]): RowLeaf => ({
      kind: "row",
      meta,
      aliases,
      key: [aliases[0] ?? ""],
      schema,
      nullable: false,
      preloads: [],
    });
    const output: OutputPlan = {
      kind: "tuple",
      items: [leaf("tenant_1", ["c0"]), leaf("global", ["c1"]), leaf("archive", ["c2"])],
    };
    function decode(row: Readonly<Record<string, unknown>>): object[] {
      if (output.kind !== "tuple") return [];
      return output.items.flatMap((item) =>
        item.kind === "row"
          ? [
              item.meta.create(
                item.aliases.map((alias) => row[alias]),
                item.meta.rowMeta("loaded", item.schema),
              ),
            ]
          : [],
      );
    }
    // Writing any of them back: the row's own database schema is the argument of the write.
    function updatePlan(adapter: Adapter, row: { readonly [ROW]: RowMeta }) {
      return adapter.compileUpdate(meta, [field], meta.primaryKey, [], row[ROW].schema);
    }
    expectTypeOf(decode).returns.toEqualTypeOf<object[]>();
    expectTypeOf(updatePlan).returns.toEqualTypeOf<CompiledQuery>();
    expectTypeOf<RowLeaf["schema"]>().toEqualTypeOf<string | undefined>();
  });

  test("step 13: an insert has no row, so it goes to the schema's declared database schema", () => {
    // per-call option, else the database schema the schema class declares, else the repo
    // default. An update or a delete uses the row's own in the second position.
    function insertSchema(callSchema: string | undefined, repoSchema: string | undefined) {
      return callSchema ?? meta.schema ?? repoSchema;
    }
    function insertPlan(adapter: Adapter, repoSchema: string | undefined) {
      return adapter.compileInsert(meta, [field], insertOne, insertSchema(undefined, repoSchema));
    }
    expectTypeOf(insertSchema).returns.toEqualTypeOf<string | undefined>();
    expectTypeOf(insertPlan).returns.toEqualTypeOf<CompiledQuery>();
  });

  test("step 13: an update of a loaded row goes to the schema the row came from", () => {
    function updatePlan(adapter: Adapter, row: { readonly [ROW]: RowMeta }, callSchema: string | undefined) {
      return adapter.compileUpdate(meta, [field], meta.primaryKey, [], callSchema ?? row[ROW].schema);
    }
    expectTypeOf(updatePlan).returns.toEqualTypeOf<CompiledQuery>();
  });

  test("step 12: repo.query compiles a bare fragment and returns raw rows", () => {
    async function query(adapter: Adapter, sql: FragmentNode, params: readonly unknown[]) {
      const compiled = adapter.compileFragment(sql);
      const raw = await adapter.execute(compiled.sql, bindParams(compiled.slots, params), {
        slots: compiled.slots,
      });
      return { rows: raw.rows, rowCount: raw.rowCount };
    }
    expectTypeOf(query).returns.resolves.toEqualTypeOf<{
      rows: readonly Record<string, unknown>[];
      rowCount: number;
    }>();
  });

  test("steps 13 and 17: an insert without RETURNING reads the generated key from the result", () => {
    async function insertedId(adapter: Adapter, values: readonly unknown[]) {
      const options: InsertPlanOptions = {
        ...insertOne,
        returning: adapter.capabilities.returning ? [field] : [],
      };
      const compiled = adapter.compileInsert(meta, [field], options, undefined);
      const raw = await adapter.execute(compiled.sql, bindParams(compiled.slots, values));
      return adapter.capabilities.returning ? raw.rows[0]?.c0 : raw.insertId;
    }
    expectTypeOf(result.insertId).toEqualTypeOf<bigint | number | undefined>();
    expectTypeOf(insertedId).returns.resolves.toBeUnknown();
    // @ts-expect-error the insert id must be reported, even as undefined
    const incomplete: RawResult = { rows: [], rowCount: 1 };
    void incomplete;
  });

  test("step 13: insertAll expresses ragged rows, expressions, subqueries, placeholders and a source query", () => {
    const value: ParamNode = { kind: "param", value: 1, type: undefined, redact: false };
    const upper: ExprNode = { kind: "fn", name: "upper", args: [value] };
    const subquery: ExprNode = { kind: "subquery", query: ast };
    const cells: InsertCell[][] = [
      [{ kind: "value" }, { kind: "default" }, { kind: "expr", expr: upper }],
      [{ kind: "value" }, { kind: "placeholder", name: "now" }, { kind: "expr", expr: subquery }],
    ];
    const sources: InsertSource[] = [
      { kind: "values", rows: 500 },
      { kind: "cells", rows: cells },
      { kind: "query", query: ast },
    ];
    for (const source of sources) {
      const options: InsertPlanOptions = { ...insertOne, source };
      expectTypeOf(
        fake.compileInsert(meta, [field, field, field], options, "tenant_1"),
      ).toEqualTypeOf<CompiledQuery>();
    }
    // @ts-expect-error a cell holds no value: values go in the parameter array
    const withValue: InsertCell = { kind: "value", value: 1 };
    // @ts-expect-error an expression cell needs a node, not a value
    const rawExpr: InsertCell = { kind: "expr", expr: "now()" };
    // @ts-expect-error not a source
    const bad: InsertSource = { kind: "rows", rows: 1 };
    void [withValue, rawExpr, bad];
  });

  test("step 13: an upsert on a fragment target that updates all but some fields", () => {
    const options: InsertPlanOptions = {
      source: { kind: "values", rows: 1 },
      returning: [],
      onConflict: { target: fragment, update: { except: [field] } },
    };
    expectTypeOf(fake.compileInsert(meta, [field], options, undefined)).toEqualTypeOf<CompiledQuery>();
  });

  test("step 08: a selected constant comes from the query, not from the plan or the database", () => {
    const select: SelectNode = {
      kind: "select",
      shape: { kind: "object", keys: ["kind"], values: [{ kind: "constant", index: 0 }] },
      constants: ["user"],
    };
    const output: OutputPlan = { kind: "object", keys: ["kind"], values: [{ kind: "constant", index: 0 }] };
    const decode: RowDecoder = (_row, constants) => ({ kind: constants[0] });
    expectTypeOf(decode({}, select.constants)).toBeUnknown();
    // @ts-expect-error the plan holds an index, never the value
    const leaked: OutputPlan = { kind: "constant", value: "user" };
    void [output, leaked];
  });

  test("step 14: join preloads are decoded per row and merged after decoding, from the plan alone", () => {
    type RowLeaf = Extract<OutputPlan, { kind: "row" }>;
    type Raw = Readonly<Record<string, unknown>>;
    const comments: RowLeaf = {
      kind: "row",
      meta,
      aliases: ["c4", "c5"],
      key: ["c4"],
      schema: "archive",
      nullable: true,
      preloads: [],
    };
    const posts: RowLeaf = {
      kind: "row",
      meta,
      aliases: ["c2", "c3"],
      key: ["c2"],
      schema: "global",
      nullable: true,
      preloads: [{ assoc: "comments", cardinality: "many", row: comments }],
    };
    const users: RowLeaf = {
      kind: "row",
      meta,
      aliases: ["c0", "c1"],
      key: ["c0"],
      schema: "tenant_1",
      nullable: false,
      preloads: [
        { assoc: "posts", cardinality: "many", row: posts },
        // Loaded by a separate query after decoding: the plan only reserves the property.
        { assoc: "profile", cardinality: "one", row: undefined },
      ],
    };

    // 1. The decoder: one result row in, one parent out, with that row's child in place.
    //    A pure function of the plan and the row: no state between rows.
    //    Every row is stamped from its OWN leaf: a child can live in another database schema than
    //    its parent (here users in "tenant_1", posts in "global", comments in "archive").
    function decodeRow(leaf: RowLeaf, row: Raw): object | null {
      const rowMeta = leaf.meta.rowMeta("loaded", leaf.schema);
      if (leaf.nullable && leaf.key.every((alias) => row[alias] === null)) return null;
      const values = leaf.aliases.map((alias) => row[alias]);
      if (leaf.preloads.length === 0) return leaf.meta.create(values, rowMeta);
      const loaded = leaf.preloads.map((preload) => {
        const child = preload.row?.kind === "row" ? decodeRow(preload.row, row) : null;
        if (preload.cardinality === "one") return child;
        return child === null ? [] : [child];
      });
      return leaf.meta.createWith(leaf.preloads.map((preload) => preload.assoc))(values, loaded, rowMeta);
    }

    // 2. The post-decode stage (step 12's afterDecode hook, implemented by step 14): merges
    //    parents with equal primary keys, first seen first, and their children likewise.
    function mergeParents(leaf: RowLeaf, decoded: readonly object[]): object[] {
      const byKey = new Map<string, Record<string, unknown>>();
      for (const item of decoded as readonly Record<string, unknown>[]) {
        const key = JSON.stringify(leaf.meta.primaryKey.map((field) => item[field.name]));
        const seen = byKey.get(key);
        if (seen === undefined) {
          byKey.set(key, item);
          continue;
        }
        for (const preload of leaf.preloads) {
          if (preload.cardinality === "many" && preload.row !== undefined) {
            (seen[preload.assoc] as object[]).push(...(item[preload.assoc] as object[]));
          }
        }
      }
      const parents = [...byKey.values()];
      for (const parent of parents) {
        for (const preload of leaf.preloads) {
          if (preload.cardinality === "many" && preload.row?.kind === "row") {
            parent[preload.assoc] = mergeParents(preload.row, parent[preload.assoc] as object[]);
          }
        }
      }
      return parents;
    }

    const decoder: RowDecoder = (row) => decodeRow(users, row);
    const afterDecode = (rows: readonly unknown[]): object[] =>
      mergeParents(users, rows.filter((row) => row !== null) as object[]);
    expectTypeOf(decoder).toEqualTypeOf<RowDecoder>();
    expectTypeOf(afterDecode).returns.toEqualTypeOf<object[]>();
    expectTypeOf(users.meta.createWith(["posts", "profile"])).toEqualTypeOf<
      (values: readonly unknown[], loaded: readonly unknown[], row: RowMeta) => object
    >();
    expectTypeOf(users.preloads[1]!.row).toEqualTypeOf<OutputPlan | undefined>();

    // @ts-expect-error not a cardinality
    const bad: OutputPreload = { ...users.preloads[0]!, cardinality: "several" };
    // @ts-expect-error a separate-query preload says so with `row: undefined`, not by omission
    const omitted: OutputPreload = { assoc: "profile", cardinality: "one" };
    // @ts-expect-error a decoder takes one row: it cannot see the others to de-duplicate
    const resultLevel: RowDecoder = (rows: readonly Raw[]) => rows;
    void [bad, omitted, resultLevel];
  });

  test("steps 08 and 12: a whole binding from an outer join decodes to null", () => {
    // `key` holds the output columns of the primary key. (`FieldMeta.index` is a position
    // in `fields`, not in `aliases`, which is aligned with `persisted`.)
    const profile: OutputPlan = {
      kind: "row",
      meta,
      aliases: ["c2", "c3"],
      key: ["c2"],
      schema: undefined,
      nullable: true,
      preloads: [],
    };
    const decode = (row: Readonly<Record<string, unknown>>): object | null => {
      if (profile.kind !== "row") return null;
      // With no primary key, `key` is empty: fall back to "every column is null".
      const proof = profile.key.length > 0 ? profile.key : profile.aliases;
      const absent = profile.nullable && proof.every((alias) => row[alias] === null);
      return absent
        ? null
        : profile.meta.create(
            profile.aliases.map((alias) => row[alias]),
            profile.meta.rowMeta("loaded", profile.schema),
          );
    };
    expectTypeOf(decode).returns.toEqualTypeOf<object | null>();
    // @ts-expect-error whether the row can be absent must be stated
    const unstated: OutputPlan = { kind: "row", meta, aliases: [], key: [], schema: undefined, preloads: [] };
    // @ts-expect-error the key columns must be stated
    const keyless: OutputPlan = {
      kind: "row",
      meta,
      aliases: [],
      schema: undefined,
      nullable: false,
      preloads: [],
    };
    // @ts-expect-error the database schema the leaf's table resolved to must be stated, even as undefined
    const unplaced: OutputPlan = { kind: "row", meta, aliases: [], key: [], nullable: false, preloads: [] };
    void [unstated, keyless, unplaced];
  });

  test("steps 09 and 12: explain and named prepared statements go through the contract", () => {
    const explain = fake.compileExplain(ast, "all", undefined, { analyze: true, format: "json" });
    expectTypeOf(explain).toEqualTypeOf<CompiledQuery>();
    void fake.execute(plan.sql, [], { statementName: "user_by_email", slots: plan.slots });
    // @ts-expect-error not an explain format
    fake.compileExplain(ast, "all", undefined, { format: "yaml" });
    // @ts-expect-error the options are required
    fake.compileExplain(ast, "all", undefined);
  });

  test("steps 11 and 12: an event can be matched to its call and redacted parameters are known", () => {
    const slots: ParamSlot[] = [
      { kind: "inline", index: 0, toDb: stringType.toDb, redact: true },
      { kind: "inline", index: 1, toDb: undefined, redact: false },
    ];
    const context = { operation: "insert", source: "users" };
    void fake.execute("insert", ["secret", 1], { slots, context });
    fake.on("query", (event) => {
      expectTypeOf(event.context).toBeUnknown();
      const mine: boolean = event.context === context;
      void mine;
    });
    const masked = (params: readonly unknown[]): unknown[] =>
      params.map((value, i) => (slots[i]?.redact === true ? "**redacted**" : value));
    expectTypeOf(masked).returns.toEqualTypeOf<unknown[]>();
    // @ts-expect-error slots are ParamSlots, not a list of booleans
    void fake.execute("insert", [], { slots: [true, false] });
  });
});
