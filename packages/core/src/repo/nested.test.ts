// Unit tests for nested writes over the real compiler and a fake driver: the statements a
// nested insert or update sends, in order, inside one transaction; what a failure rolls
// back and returns; options and the call's budget. What the database does with them is
// checked against Postgres by the nested conformance suite.
import { describe, expect, test } from "vitest";
import { createAdapter, type DatabaseAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { PoolEvent, RawResult } from "../contracts/adapter.js";
import type { AnySchema, Row } from "../contracts/schema.js";
import { ConstraintError, DatabaseError, QueryError, StaleEntryError } from "../errors.js";
import {
  belongsTo,
  cast,
  change,
  EmbeddedSchema,
  hasMany,
  hasOne,
  isLoaded,
  manyToMany,
  meta,
  Schema,
  stateOf,
  t,
} from "../index.js";
import type { RepoQueryEvent } from "./options.js";
import { createRepo } from "./repo.js";

// --- a driver without a database ---------------------------------------------------

interface Answer {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
}

class FakeDriver implements DriverWrapper {
  readonly statements: string[] = [];
  readonly params: (readonly unknown[])[] = [];
  respond: (sql: string, params: readonly unknown[]) => Answer | Error = (sql) =>
    sql.startsWith("insert") ? { rows: [{ c0: this.next++ }], rowCount: 1 } : { rowCount: 1 };
  delay: (sql: string) => number = () => 0;
  next = 100;

  init(): void {}
  async acquire(): Promise<DriverConnection> {
    const driver = this;
    return {
      async query(sql, params): Promise<RawResult> {
        driver.statements.push(sql);
        driver.params.push(params);
        const ms = driver.delay(sql);
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        const answer = driver.respond(sql, params);
        if (answer instanceof Error) throw answer;
        const rows = answer.rows ?? [];
        return { rows, rowCount: answer.rowCount ?? rows.length, insertId: undefined };
      },
      async cursor(): Promise<DriverCursor> {
        throw new Error("no cursors here");
      },
      async cancel(): Promise<void> {},
      inTransaction: () => false,
    };
  }
  async release(): Promise<void> {}
  async destroy(): Promise<void> {}
  stats(): PoolEvent {
    return { size: 1, idle: 1, waiting: 0 };
  }
  saturated(): boolean {
    return false;
  }
}

function setup(schema?: string, logParams = false) {
  const driver = new FakeDriver();
  const adapter: DatabaseAdapter = createAdapter({
    dialect: "postgres",
    capabilities: POSTGRES_CAPABILITIES,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: () => driver,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  const repo = createRepo({
    adapter,
    ...(schema === undefined ? {} : { schema }),
    ...(logParams ? { log: { params: true } as const } : {}),
  });
  const events: RepoQueryEvent[] = [];
  repo.on("query", (event) => events.push(event));
  return { repo, driver, events };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** The first words of each statement: `insert into "x"`, `update "x"`, `begin`, … */
function verbs(statements: readonly string[]): string[] {
  return statements.map((sql) => {
    const match =
      /^(insert into "\w+"|update "\w+"|delete from "\w+"|begin|commit|rollback|savepoint \S+|release savepoint \S+|rollback to savepoint \S+)/.exec(
        sql,
      );
    return match?.[1] ?? sql;
  });
}

function loaded<S extends AnySchema>(
  schema: S,
  values: Readonly<Record<string, unknown>>,
  assocs: Readonly<Record<string, unknown>> = {},
): Row<S> {
  const info = meta(schema);
  const names = Object.keys(assocs);
  const fields = info.persisted.map((field) =>
    Object.hasOwn(values, field.name) ? values[field.name] : null,
  );
  const rowMeta = info.rowMeta("loaded", undefined);
  return (
    names.length === 0
      ? info.create(fields, rowMeta)
      : info.createWith(names)(
          fields,
          names.map((name) => assocs[name]),
          rowMeta,
        )
  ) as Row<S>;
}

// --- fixtures ------------------------------------------------------------------------

class Crew extends Schema("crews", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {
  static boats = hasMany(() => Boat, { foreignKey: "crewId", onReplace: "delete" });
  static loose = hasMany(() => Boat, { foreignKey: "spareCrewId", onReplace: "setNull" });
  static flag = hasOne(() => Flag, { foreignKey: "crewId", onReplace: "setNull" });
  static badge = hasOne(() => Badge, { foreignKey: "crewId", onReplace: "deleteIfExists" });
  static ports = manyToMany(() => Port, {
    joinThrough: "crew_ports",
    joinKeys: { owner: "crew_id", target: "port_id" },
    onReplace: "delete",
  });
}

class Boat extends Schema("boats", {
  id: t.integer().primaryKey().dbGenerated(),
  crewId: t.integer(),
  spareCrewId: t.integer().nullable(),
  name: t.string(),
}) {
  static crew = belongsTo(() => Crew, { foreignKey: "crewId", onReplace: "delete" });
  static changeset(boat: Boat | typeof Boat, params: unknown) {
    return cast(boat, params, ["name"]).validateRequired(["name"]).uniqueConstraint("name");
  }
}

class Flag extends Schema("flags", {
  id: t.integer().primaryKey().dbGenerated(),
  crewId: t.integer().nullable(),
  colour: t.string(),
}) {}

class Badge extends Schema("badges", {
  id: t.integer().primaryKey().dbGenerated(),
  crewId: t.integer(),
  text: t.string(),
}) {}

class Port extends Schema("ports", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  secret: t.string().nullable().redact(),
}) {}

class Knot extends EmbeddedSchema({ name: t.string() }) {}

class Rope extends Schema("ropes", {
  id: t.integer().primaryKey().dbGenerated(),
  knot: t.embedOne(() => Knot).nullable(),
}) {}

// --- order and transaction ---------------------------------------------------------

describe("nested insert", () => {
  test("parent, then children keyed to it, in one transaction; the row has them loaded", async () => {
    const { repo, driver, events } = setup();
    const result = await repo.insert(
      change(Crew, { name: "Swift" }).putAssoc("boats", [{ name: "a" }, { name: "b" }]),
    );
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'insert into "crews"',
      'insert into "boats"',
      'insert into "boats"',
      "commit",
    ]);
    expect(driver.params[2]).toEqual([100, "a"]);
    if (!result.success) throw new Error("expected success");
    const crew = result.data;
    expect(stateOf(crew)).toBe("loaded");
    if (!isLoaded(Crew, crew, "boats")) throw new Error("expected boats");
    expect(crew.boats.map((boat) => [boat.id, boat.crewId, boat.name])).toEqual([
      [101, 100, "a"],
      [102, 100, "b"],
    ]);
    expect(events.map((event) => `${event.operation} ${event.source}`)).toEqual([
      "transaction undefined",
      "insert crews",
      "insert boats",
      "insert boats",
      "transaction undefined",
    ]);
  });

  test("a belongsTo target is written before the row that points at it", async () => {
    const { repo, driver } = setup();
    const boat = await repo.insertOrThrow(change(Boat, { name: "Lone" }).putAssoc("crew", { name: "New" }));
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'insert into "crews"',
      'insert into "boats"',
      "commit",
    ]);
    expect(boat.crewId).toBe(100);
  });

  test("an upsert with association changes is refused before anything is sent", async () => {
    const { repo, driver } = setup();
    const error = await rejection(
      repo.insert(change(Crew, { name: "X" }).putAssoc("boats", [{ name: "x" }]), { onConflict: "nothing" }),
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(driver.statements).toEqual([]);
  });

  test("an invalid tree sends nothing; prepare functions run inside the transaction", async () => {
    const { repo, driver } = setup();
    const invalid = await repo.insert(
      change(Crew, { name: "X" }).putAssoc("boats", [cast(Boat, {}, ["name"]).validateRequired(["name"])]),
    );
    expect(invalid.success).toBe(false);
    expect(driver.statements).toEqual([]);
    let seen: unknown;
    await repo.insertOrThrow(
      change(Crew, { name: "Y" })
        .putAssoc("boats", [{ name: "c" }])
        .prepareChanges((cs) => {
          seen = cs.repo;
          return cs.putChange("name", "Z");
        }),
    );
    expect(seen).not.toBe(repo);
    expect(driver.params[1]).toEqual(["Z"]);
  });

  test("a prepare function that adds association changes opens the transaction then", async () => {
    const { repo, driver } = setup();
    await repo.insertOrThrow(
      change(Crew, { name: "P" }).prepareChanges((cs) => cs.putAssoc("boats", [{ name: "late" }])),
    );
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'insert into "crews"',
      'insert into "boats"',
      "commit",
    ]);
  });

  test("a child's declared constraint failure rolls back and comes back in place", async () => {
    const { repo, driver } = setup();
    driver.respond = (sql) => {
      if (
        sql.startsWith('insert into "boats"') &&
        driver.statements.filter((s) => s.startsWith('insert into "boats"')).length === 2
      ) {
        return new ConstraintError({
          type: "unique",
          constraint: "boats_name_key",
          table: "boats",
          column: undefined,
          detail: undefined,
        });
      }
      return sql.startsWith("insert") ? { rows: [{ c0: driver.next++ }], rowCount: 1 } : { rowCount: 1 };
    };
    const result = await repo.insert(
      cast(Crew, { name: "Q", boats: [{ name: "one" }, { name: "dup" }] }, ["name"]).castAssoc("boats"),
    );
    if (result.success) throw new Error("expected a failure");
    expect(verbs(driver.statements).at(-1)).toBe("rollback");
    expect(result.error.action).toBe("insert");
    expect(result.error.errorMessages()).toEqual({ boats: [{}, { name: ["has already been taken"] }] });
  });

  test("an unhandled error rolls back and is thrown", async () => {
    const { repo, driver } = setup();
    driver.respond = (sql) =>
      sql.startsWith('insert into "boats"')
        ? new DatabaseError("boom", { code: "connection" })
        : sql.startsWith("insert")
          ? { rows: [{ c0: 1 }], rowCount: 1 }
          : {};
    expect(
      await rejection(repo.insert(change(Crew, { name: "R" }).putAssoc("boats", [{ name: "x" }]))),
    ).toBeInstanceOf(DatabaseError);
    expect(verbs(driver.statements).at(-1)).toBe("rollback");
  });

  test("the parent's own failure comes back with its nested changes kept", async () => {
    const { repo, driver } = setup();
    driver.respond = (sql) =>
      sql.startsWith('insert into "crews"')
        ? new ConstraintError({
            type: "unique",
            constraint: "crews_name_key",
            table: "crews",
            column: undefined,
            detail: undefined,
          })
        : {};
    const result = await repo.insert(
      change(Crew, { name: "S" })
        .uniqueConstraint("name")
        .putAssoc("boats", [{ name: "kept" }]),
    );
    if (result.success) throw new Error("expected a failure");
    expect(result.error.errorMessages()).toEqual({ name: ["has already been taken"] });
    expect(Array.isArray(result.error.changes.boats)).toBe(true);
  });

  test("timeoutMs covers every statement of the call", async () => {
    const { repo, driver } = setup();
    driver.delay = (sql) => (sql.startsWith("insert") ? 60 : 0);
    const error = await rejection(
      repo.insert(change(Crew, { name: "T" }).putAssoc("boats", [{ name: "x" }, { name: "y" }]), {
        timeoutMs: 100,
      }),
    );
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe("timeout");
    expect((error as Error).message).toContain("(100 ms)");
  });

  test("a child with nested changes of its own joins the same transaction", async () => {
    const { repo, driver } = setup();
    const boat = change(Boat, { name: "deep" }).putAssoc(
      "crew",
      change(Crew, { name: "c" }).putAssoc("ports", [{ name: "p" }]),
    );
    await repo.insertOrThrow(boat);
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'insert into "crews"',
      'insert into "ports"',
      'insert into "crew_ports"',
      'insert into "boats"',
      "commit",
    ]);
  });

  test("inside repo.transaction a nested write takes a savepoint", async () => {
    const { repo, driver } = setup();
    await repo.transaction(async (tx) =>
      tx.insertOrThrow(change(Crew, { name: "In" }).putAssoc("boats", [{ name: "b" }])),
    );
    expect(verbs(driver.statements)).toEqual(
      [
        "begin",
        "savepoint egon_1",
        'insert into "crews"',
        'insert into "boats"',
        "release savepoint egon_1",
        "commit",
      ].map((each) => each.replace("egon_1", '"egon_1"')),
    );
  });
});

describe("nested update", () => {
  test("removed children leave first, then updates, then inserts", async () => {
    const { repo, driver } = setup();
    const keep = loaded(Boat, { id: 1, crewId: 9, name: "keep" });
    const gone = loaded(Boat, { id: 2, crewId: 9, name: "gone" });
    const crew = loaded(Crew, { id: 9, name: "Old" }, { boats: [keep, gone] });
    const saved = await repo.updateOrThrow(
      cast(crew, { name: "New", boats: [{ name: "fresh" }, { id: 1, name: "kept" }] }, ["name"]).castAssoc(
        "boats",
      ),
    );
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'update "crews"',
      'delete from "boats"',
      'update "boats"',
      'insert into "boats"',
      "commit",
    ]);
    if (!isLoaded(Crew, saved, "boats")) throw new Error("expected boats");
    expect(saved.boats.map((boat) => boat.name)).toEqual(["fresh", "kept"]);
  });

  test("setNull on a to-many and a to-one sets the key to null; deleteIfExists allows a missing row", async () => {
    const { repo, driver } = setup();
    const spare = loaded(Boat, { id: 3, crewId: 1, spareCrewId: 9, name: "spare" });
    const flag = loaded(Flag, { id: 4, crewId: 9, colour: "red" });
    const badge = loaded(Badge, { id: 5, crewId: 9, text: "old" });
    const crew = loaded(Crew, { id: 9, name: "C" }, { loose: [spare], flag, badge });
    driver.respond = (sql) =>
      sql.startsWith('delete from "badges"')
        ? { rowCount: 0 }
        : sql.startsWith("insert")
          ? { rows: [{ c0: 50 }], rowCount: 1 }
          : { rowCount: 1 };
    const saved = await repo.updateOrThrow(
      change(crew)
        .putAssoc("loose", [])
        .putAssoc("flag", { colour: "blue" })
        .putAssoc("badge", { text: "new" }),
    );
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'update "boats"',
      'update "flags"',
      'insert into "flags"',
      'delete from "badges"',
      'insert into "badges"',
      "commit",
    ]);
    expect(driver.params[1]).toEqual([null, 3]);
    if (!isLoaded(Crew, saved, "loose") || !isLoaded(Crew, saved, "flag")) throw new Error("expected loads");
    expect(saved.loose).toEqual([]);
    expect(saved.flag?.colour).toBe("blue");
  });

  test("a replaced belongsTo target is deleted after the row points elsewhere", async () => {
    const { repo, driver } = setup();
    const old = loaded(Crew, { id: 1, name: "old" });
    const boat = loaded(Boat, { id: 7, crewId: 1, name: "b" }, { crew: old });
    await repo.updateOrThrow(change(boat).putAssoc("crew", loaded(Crew, { id: 2, name: "new" })));
    expect(verbs(driver.statements)).toEqual(["begin", 'update "boats"', 'delete from "crews"', "commit"]);
    expect(driver.params[1]).toEqual([2, 7]);
  });

  test("a stale child is thrown and everything is rolled back", async () => {
    const { repo, driver } = setup();
    driver.respond = (sql) => (sql.startsWith('update "boats"') ? { rowCount: 0 } : { rowCount: 1 });
    const crew = loaded(
      Crew,
      { id: 9, name: "C" },
      { boats: [loaded(Boat, { id: 1, crewId: 9, name: "x" })] },
    );
    const error = await rejection(
      repo.update(cast(crew, { boats: [{ id: 1, name: "y" }] }, []).castAssoc("boats")),
    );
    expect(error).toBeInstanceOf(StaleEntryError);
    expect(verbs(driver.statements).at(-1)).toBe("rollback");
  });

  test("many-to-many: new targets are inserted and linked, removed ones unlinked", async () => {
    const { repo, driver } = setup();
    const old = loaded(Port, { id: 1, name: "Old" });
    const kept = loaded(Port, { id: 2, name: "Kept" });
    const crew = loaded(Crew, { id: 9, name: "C" }, { ports: [old, kept] });
    const saved = await repo.updateOrThrow(
      change(crew).putAssoc("ports", [kept, { name: "New" }, loaded(Port, { id: 3, name: "Other" })]),
    );
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'delete from "crew_ports"',
      'insert into "ports"',
      'insert into "crew_ports"',
      'insert into "crew_ports"',
      "commit",
    ]);
    expect(driver.statements[1]).toBe('delete from "crew_ports" where "crew_id" = $1 and "port_id" = $2');
    expect(driver.params[1]).toEqual([9, 1]);
    expect(driver.params[3]).toEqual([9, 100]);
    expect(driver.params[4]).toEqual([9, 3]);
    if (!isLoaded(Crew, saved, "ports")) throw new Error("expected ports");
    expect(saved.ports.map((port) => port.name)).toEqual(["Kept", "New", "Other"]);
  });

  test("embed changes are written as JSON with the row, without a transaction", async () => {
    const { repo, driver } = setup();
    const rope = await repo.insertOrThrow(change(Rope).putEmbed("knot", { name: "bowline" }));
    expect(verbs(driver.statements)).toEqual(['insert into "ropes"']);
    expect(driver.params[0]).toEqual([{ name: "bowline" }]);
    expect(rope.knot).toBeInstanceOf(Knot);
    const missing = await repo.insert(change(Rope).putEmbed("knot", {} as never));
    expect(missing.success || missing.error.errorMessages()).toEqual({ knot: { name: ["can't be blank"] } });
    const updated = await repo.update(
      change(loaded(Rope, { id: 1, knot: null })).putEmbed("knot", {} as never),
    );
    expect(updated.success).toBe(false);
  });

  test("a changeset on a field that is not an embed, or an unknown key, is refused", async () => {
    const { repo } = setup();
    const crew = change(Crew, { name: "x" });
    const odd = Object.create(Object.getPrototypeOf(crew), Object.getOwnPropertyDescriptors(crew));
    Object.defineProperty(odd, "changes", { value: { name: change(Crew) } });
    expect(await rejection(repo.insert(odd))).toBeInstanceOf(QueryError);
  });
});

// --- more paths ----------------------------------------------------------------------

class Guild extends Schema("guilds", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {
  static members = manyToMany(() => Sailor, {
    joinThrough: () => Berth,
    joinKeys: { owner: "guildId", target: "sailorId" },
    onReplace: "delete",
  });
}

class Sailor extends Schema("sailors", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {}

class Berth extends Schema("berths", {
  guildId: t.integer().primaryKey(),
  sailorId: t.integer().primaryKey(),
  rank: t.string().default("deckhand"),
}) {}

class Tenant extends Schema(
  "tenants",
  { id: t.integer().primaryKey().dbGenerated(), name: t.string() },
  { schema: "own" },
) {
  static boats = hasMany(() => Boat, { foreignKey: "crewId" });
}

describe("nested writes, other paths", () => {
  test("a join schema's rows are written with its defaults, and removed by both keys", async () => {
    const { repo, driver } = setup();
    const old = loaded(Sailor, { id: 1, name: "old" });
    const guild = loaded(Guild, { id: 5, name: "G" }, { members: [old] });
    await repo.updateOrThrow(change(guild).putAssoc("members", [{ name: "new" }]));
    expect(verbs(driver.statements)).toEqual([
      "begin",
      'delete from "berths"',
      'insert into "sailors"',
      'insert into "berths"',
      "commit",
    ]);
    expect(driver.statements[3]).toContain('("guild_id", "sailor_id", "rank")');
    expect(driver.params[3]).toEqual([5, 100, "deckhand"]);
  });

  test("a failing target of a many-to-many fails the parent with that child in place", async () => {
    const { repo, driver } = setup();
    driver.respond = (sql) =>
      sql.startsWith('insert into "ports"')
        ? new ConstraintError({
            type: "unique",
            constraint: "ports_name_key",
            table: "ports",
            column: undefined,
            detail: undefined,
          })
        : sql.startsWith("insert")
          ? { rows: [{ c0: 1 }], rowCount: 1 }
          : { rowCount: 1 };
    const crew = loaded(Crew, { id: 9, name: "C" }, { ports: [] });
    const result = await repo.update(
      change(crew).putAssoc("ports", [change(Port, { name: "dup" }).uniqueConstraint("name")]),
    );
    expect(result.success || result.error.errorMessages()).toEqual({
      ports: [{ name: ["has already been taken"] }],
    });
  });

  test("a failing link of a many-to-many fails the parent with its target in place", async () => {
    const { repo, driver } = setup();
    driver.respond = (sql) =>
      sql.startsWith('insert into "berths"')
        ? new ConstraintError({
            type: "unique",
            constraint: "berths_pkey",
            table: "berths",
            column: undefined,
            detail: undefined,
          })
        : sql.startsWith("insert")
          ? { rows: [{ c0: 1 }], rowCount: 1 }
          : { rowCount: 1 };
    const guild = loaded(Guild, { id: 5, name: "G" }, { members: [] });
    const error = await rejection(repo.update(change(guild).putAssoc("members", [{ name: "x" }])));
    expect(error).toBeInstanceOf(ConstraintError);
  });

  test("removing a to-one child or a belongsTo target writes null", async () => {
    const { repo, driver } = setup();
    const flag = loaded(Flag, { id: 4, crewId: 9, colour: "red" });
    const crew = loaded(Crew, { id: 9, name: "C" }, { flag });
    const saved = await repo.updateOrThrow(change(crew).putAssoc("flag", null));
    expect(verbs(driver.statements)).toEqual(["begin", 'update "flags"', "commit"]);
    if (!isLoaded(Crew, saved, "flag")) throw new Error("expected flag");
    expect(saved.flag).toBeNull();
    class Raft extends Schema("rafts", {
      id: t.integer().primaryKey().dbGenerated(),
      crewId: t.integer().nullable(),
    }) {
      static crew = belongsTo(() => Crew, { foreignKey: "crewId", onReplace: "setNull" });
    }
    driver.statements.length = 0;
    driver.params.length = 0;
    const raft = loaded(Raft, { id: 2, crewId: 9 }, { crew: loaded(Crew, { id: 9, name: "C" }) });
    await repo.updateOrThrow(change(raft).putAssoc("crew", null));
    expect(verbs(driver.statements)).toEqual(["begin", 'update "rafts"', "commit"]);
    expect(driver.params[1]).toEqual([null, 2]);
  });

  test("children are inserted where the parent was: the call's schema, else the repo's", async () => {
    const { repo, driver } = setup("base");
    await repo.insertOrThrow(change(Tenant, { name: "t" }).putAssoc("boats", [{ name: "b" }]));
    expect(driver.statements[1]).toContain('insert into "own"."tenants"');
    expect(driver.statements[2]).toContain('insert into "base"."boats"');
    driver.statements.length = 0;
    await repo.insertOrThrow(change(Crew, { name: "c" }).putAssoc("boats", [{ name: "b" }]), {
      schema: "other",
    });
    expect(driver.statements[1]).toContain('insert into "other"."crews"');
    expect(driver.statements[2]).toContain('insert into "other"."boats"');
  });

  test("the signal and the context reach every statement of the call", async () => {
    const { repo, events } = setup();
    const controller = new AbortController();
    await repo.insertOrThrow(change(Crew, { name: "c" }).putAssoc("boats", [{ name: "b" }]), {
      signal: controller.signal,
      context: { request: "r-1" },
    });
    // BEGIN and COMMIT included.
    expect(events.map((event) => [event.operation, event.context])).toEqual([
      ["transaction", { request: "r-1" }],
      ["insert", { request: "r-1" }],
      ["insert", { request: "r-1" }],
      ["transaction", { request: "r-1" }],
    ]);
  });

  test("a child prepare function that makes it invalid fails the parent and rolls back", async () => {
    const { repo, driver } = setup();
    const result = await repo.insert(
      change(Crew, { name: "c" }).putAssoc("boats", [
        change(Boat, { name: "b" }).prepareChanges((cs) => cs.addError("name", "is taken")),
      ]),
    );
    expect(result.success || result.error.errorMessages()).toEqual({ boats: [{ name: ["is taken"] }] });
    expect(verbs(driver.statements)).toEqual(["begin", 'insert into "crews"', "rollback"]);
    const bad = await repo.insert(
      change(Boat, { name: "x" }).putAssoc(
        "crew",
        change(Crew, { name: "y" }).prepareChanges((cs) => cs.addError("name", "no")),
      ),
    );
    expect(bad.success || bad.error.errorMessages()).toEqual({ crew: { name: ["no"] } });
    const flagged = await repo.insert(
      change(Crew, { name: "z" }).putAssoc(
        "flag",
        change(Flag, { colour: "c" }).prepareChanges((cs) => cs.addError("colour", "no")),
      ),
    );
    expect(flagged.success || flagged.error.errorMessages()).toEqual({ flag: { colour: ["no"] } });
  });

  test("a parent whose own prepare function fails writes nothing", async () => {
    const { repo, driver } = setup();
    const result = await repo.insert(
      change(Crew, { name: "c" })
        .putAssoc("boats", [{ name: "b" }])
        .prepareChanges((cs) => cs.addError("name", "no")),
    );
    expect(result.success).toBe(false);
    expect(verbs(driver.statements)).toEqual(["begin", "rollback"]);
  });
});

// --- review round 1 ----------------------------------------------------------------------

class Fleet extends Schema("fleets", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  knot: t.embedOne(() => Knot).nullable(),
}) {
  static boats = hasMany(() => Boat, { foreignKey: "crewId" });
}

class Coin extends Schema("coins", { id: t.integer().primaryKey().dbGenerated(), label: t.string() }) {}

class Vault extends Schema("vaults", {
  id: t.integer().primaryKey().dbGenerated().redact(),
  name: t.string(),
}) {
  static coins = manyToMany(() => Coin, {
    joinThrough: "vault_coins",
    joinKeys: { owner: "vault_id", target: "coin_id" },
    onReplace: "delete",
  });
}

class Pass extends Schema("passes", {
  guildId: t.integer().primaryKey(),
  sailorId: t.integer().primaryKey(),
  stamp: t.string(),
}) {}

class Club extends Schema("clubs", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {
  static members = manyToMany(() => Sailor, {
    joinThrough: () => Pass,
    joinKeys: { owner: "guildId", target: "sailorId" },
  });
}

class Secret extends EmbeddedSchema({ code: t.string().redact() }) {}

class Locker extends Schema("lockers", {
  id: t.integer().primaryKey().dbGenerated(),
  secret: t.embedOne(() => Secret, { onReplace: "update" }).nullable(),
}) {}

function logged() {
  const made = setup(undefined, true);
  return made;
}

describe("review round 1: repo", () => {
  test("a parent's own embed errors survive a failed nested write, with its association changes", async () => {
    const { repo, driver } = setup();
    const result = await repo.insert(
      change(Fleet, { name: "F" })
        .putAssoc("boats", [{ name: "b" }])
        .putEmbed("knot", {} as never),
    );
    if (result.success) throw new Error("expected a failure");
    expect(result.error.errorMessages()).toEqual({ knot: { name: ["can't be blank"] } });
    expect(Array.isArray((result.error.changes as Record<string, unknown>).boats)).toBe(true);
    expect(verbs(driver.statements)).toEqual(["begin", "rollback"]);
  });

  test("join-row keys are redacted in logs when a key field is", async () => {
    const { repo, events } = logged();
    await repo.insertOrThrow(change(Vault, { name: "v" }).putAssoc("coins", [{ label: "c" }]));
    const link = events.find((event) => event.source === "vault_coins");
    // As preloads do, a key is redacted when the field on either side is.
    expect(link?.params).toEqual(["**redacted**", "**redacted**"]);
    const coin = events.find((event) => event.source === "coins");
    expect(coin?.params).toEqual(["c"]);
  });

  test("an embed holding a redacted field is redacted as a whole in logs: insert, update, insertAll", async () => {
    const { repo, events } = logged();
    const locker = await repo.insertOrThrow(change(Locker).putEmbed("secret", { code: "SECRET-1" }));
    await repo.updateOrThrow(change(locker).putEmbed("secret", { code: "SECRET-2" }));
    await repo.insertAll(Locker, [{ secret: { code: "SECRET-3" } }]);
    expect(events.map((event) => event.params?.[0])).toEqual([
      "**redacted**",
      "**redacted**",
      "**redacted**",
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  test("a join row that cannot be written fails the parent with its target in place", async () => {
    const { repo, driver } = setup();
    const result = await repo.insert(change(Club, { name: "c" }).putAssoc("members", [{ name: "s" }]));
    if (result.success) throw new Error("expected a failure");
    expect(result.error.errorMessages()).toEqual({ members: [{ stamp: ["can't be blank"] }] });
    expect(verbs(driver.statements).at(-1)).toBe("rollback");
  });

  test("a change that is not a field or association is refused before the validity check, naming the method", async () => {
    const { repo } = setup();
    const crew = change(Crew, { name: "x" }).addError("name", "is bad");
    const odd = Object.create(Object.getPrototypeOf(crew), Object.getOwnPropertyDescriptors(crew));
    Object.defineProperty(odd, "changes", { value: { name: "x", nothing: [] } });
    const error = await rejection(repo.insert(odd));
    expect((error as Error).message).toMatch(/^repo\.insert\(\): the changeset holds a change of "nothing"/);
    const row = loaded(Crew, { id: 1, name: "x" });
    const onRow = change(row).addError("name", "is bad");
    const odder = Object.create(Object.getPrototypeOf(onRow), Object.getOwnPropertyDescriptors(onRow));
    Object.defineProperty(odder, "changes", { value: { name: change(Crew) } });
    expect(((await rejection(repo.update(odder))) as Error).message).toMatch(
      /^repo\.update\(\): the changeset of Crew/,
    );
  });
});
