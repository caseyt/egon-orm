// The recorder: what each call records, the default names, and the arguments it refuses
// (when they are recorded, at the line that made the mistake).
import { describe, expect, test } from "vitest";
import { fragment, param } from "../query/functions.js";
import { t as field } from "../schema/index.js";
import { MigrationBuilder, typeSpec } from "./builder.js";
import { defaultName } from "./names.js";
import type { ColumnDef, CreateTableOp, Operation } from "./types.js";

function record(
  define: (m: MigrationBuilder) => void,
  maxBytes: number | undefined = 63,
): readonly Operation[] {
  const m = new MigrationBuilder(maxBytes);
  define(m);
  return m.operations;
}

function columnsOf(define: (m: MigrationBuilder) => void): readonly ColumnDef[] {
  return (record(define)[0] as CreateTableOp).columns;
}

/** Calls `run` with whatever arguments, as JavaScript could. */
const loose = <T>(value: T): Record<string, (...args: unknown[]) => unknown> =>
  value as unknown as Record<string, (...args: unknown[]) => unknown>;

describe("default names", () => {
  test("unique, foreign key and check constraints follow <table>_<column>_<label>", () => {
    const [id, email, orgId, role] = columnsOf((m) =>
      m.createTable("members", (t) => {
        t.id();
        t.text("email").unique();
        t.references("org_id", "orgs");
        t.enumText("role", ["a", "b"]);
      }),
    );
    expect(id?.primaryKey).toBe(true);
    expect(email?.unique).toBe("members_email_key");
    expect(orgId?.references?.name).toBe("members_org_id_fkey");
    expect(role?.check?.name).toBe("members_role_check");
  });

  test("an index is <table>_<columns>_key when unique, _index otherwise", () => {
    const ops = record((m) => {
      m.createIndex("posts", ["author_id", "slug"], { unique: true });
      m.createIndex("posts", ["author_id", "slug"]);
    });
    expect(ops.map((op) => (op.op === "createIndex" ? op.index.name : undefined))).toEqual([
      "posts_author_id_slug_key",
      "posts_author_id_slug_index",
    ]);
  });

  test("a name longer than the identifier limit is shortened as Postgres shortens its own", () => {
    const table = "a".repeat(40);
    const name = defaultName(table, ["b".repeat(40)], "key", 63);
    expect(name).toBe(`${"a".repeat(29)}_${"b".repeat(29)}_key`);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63);
    // Without a limit nothing is shortened.
    expect(defaultName(table, ["b".repeat(40)], "key", undefined)).toBe(`${table}_${"b".repeat(40)}_key`);
    const [op] = record((m) => m.createIndex(table, ["b".repeat(40)], { unique: true }));
    expect(op?.op === "createIndex" && op.index.name).toBe(name);
  });

  test("names can be given instead", () => {
    const [email] = columnsOf((m) =>
      m.createTable("users", (t) => t.text("email").primaryKey().unique({ name: "email_unique" })),
    );
    expect(email?.unique).toBe("email_unique");
  });
});

describe("columns", () => {
  test("columns allow null unless notNull(), and nullable() undoes it", () => {
    const [a, b, c] = columnsOf((m) =>
      m.createTable("t", (t) => {
        t.integer("a").primaryKey();
        t.integer("b").notNull();
        t.integer("c").notNull().nullable();
      }),
    );
    expect([a?.notNull, b?.notNull, c?.notNull]).toEqual([false, true, false]);
  });

  test("timestamps() takes its type and its column names", () => {
    const columns = columnsOf((m) =>
      m.createTable("t", (t) => {
        t.id();
        t.timestamps({ type: "timestamp", createdAt: "inserted_at", updatedAt: "changed_at" });
      }),
    );
    expect(columns.slice(1).map((c) => [c.name, c.type.kind, c.notNull, c.default?.kind])).toEqual([
      ["inserted_at", "timestamp", true, "now"],
      ["changed_at", "timestamp", true, "now"],
    ]);
  });

  test("a json default is stored as its JSON text; other objects are refused", () => {
    const [, json] = columnsOf((m) =>
      m.createTable("t", (t) => {
        t.id();
        t.jsonb("j").default([1, { a: null }]);
      }),
    );
    expect(json?.default).toEqual({ kind: "value", value: '[1,{"a":null}]' });
    expect(() =>
      record((m) =>
        m.createTable("t", (t) =>
          t
            .text("x")
            .primaryKey()
            .default({ a: 1 } as never),
        ),
      ),
    ).toThrow(TypeError);
    expect(() =>
      record((m) =>
        m.createTable("t", (t) =>
          t
            .jsonb("x")
            .primaryKey()
            .default({ a: () => 1 } as never),
        ),
      ),
    ).toThrow(TypeError);
    expect(() =>
      record((m) =>
        m.createTable("t", (t) =>
          t
            .jsonb("x")
            .primaryKey()
            .default(new Date() as never),
        ),
      ),
    ).toThrow(TypeError);
  });

  test("defaults that cannot be written as constants are refused", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "a\u0000",
      "\ud800",
      "a\udc00b",
      undefined,
      Symbol("x"),
      () => 1,
    ]) {
      expect(() =>
        record((m) =>
          m.createTable("t", (t) =>
            t
              .text("x")
              .primaryKey()
              .default(value as never),
          ),
        ),
      ).toThrow(TypeError);
    }
  });

  test("a DDL fragment cannot bind a value or a named parameter", () => {
    expect(() =>
      record((m) => m.createTable("t", (t) => t.integer("x").primaryKey().default(fragment`${1} + 1`))),
    ).toThrow(/cannot bind values/);
    expect(() => record((m) => m.createIndex("t", ["a"], { where: fragment`a > ${0}` }))).toThrow(
      /cannot bind/,
    );
    expect(() => record((m) => m.createIndex("t", [fragment`lower(${"a"})`], { name: "n" }))).toThrow(
      /cannot bind/,
    );
    expect(() => record((m) => m.createConstraint("t", "c", { check: fragment`a > ${0}` }))).toThrow(
      /cannot bind/,
    );
    expect(() => record((m) => m.execute(fragment`select ${param("x", field.integer())}` as never))).toThrow(
      /named parameter/,
    );
  });
});

describe("string constants", () => {
  test("well-formed text, astral characters included, is accepted", () => {
    const [, emoji] = columnsOf((m) =>
      m.createTable("t", (t) => {
        t.id();
        t.text("x").default("party 🎉");
      }),
    );
    expect(emoji?.default).toEqual({ kind: "value", value: "party 🎉" });
  });
});

describe("column types", () => {
  test("names, objects and DbType values are accepted", () => {
    expect(typeSpec("x", "integer").kind).toBe("integer");
    expect(typeSpec("x", { kind: "jsonb" }).kind).toBe("jsonb");
    expect(typeSpec("x", { kind: "array", of: { kind: "array", of: "integer" } }).of?.of?.kind).toBe(
      "integer",
    );
    expect(typeSpec("x", { kind: "decimal", precision: 12, scale: 0 })).toMatchObject({
      precision: 12,
      scale: 0,
    });
    expect(typeSpec("x", { kind: "timestamptz", precision: 6 })).toMatchObject({ precision: 6 });
    expect(typeSpec("x", { kind: "custom", sql: "numeric(10, 2)[]" }).sql).toBe("numeric(10, 2)[]");
  });

  test.each([
    ["an unknown name", "varchar"],
    ["a non-object", 7],
    ["an unknown kind", { kind: "money" }],
    ["a custom type that is not a type name", { kind: "custom", sql: "text); drop table users; --" }],
    ["a custom type without sql", { kind: "custom" }],
    ["a scale without a precision", { kind: "decimal", scale: 2 }],
    ["a fractional precision", { kind: "decimal", precision: 2.5 }],
    ["a negative scale", { kind: "decimal", precision: 4, scale: -1 }],
    ["a zero decimal precision", { kind: "decimal", precision: 0 }],
    ["a precision on a type without one", { kind: "integer", precision: 2 }],
    ["a negative timestamp precision", { kind: "timestamp", precision: -1 }],
    ["an array of nothing", { kind: "array" }],
  ])("%s is refused", (_name, type) => {
    expect(() => typeSpec("x", type)).toThrow(TypeError);
  });
});

describe("t.id() with its options first", () => {
  // Each message comes from the options-first branch: without it, the object would be
  // refused as a column name instead.
  test.each<[string, (m: MigrationBuilder) => void, string]>([
    [
      "a type other than bigint or integer",
      (m) => m.createTable("t", (t) => t.id({ type: "uuid" } as never)),
      'createTable("t"): id(): the option "type" must be "bigint" or "integer".',
    ],
    [
      "an unknown option",
      (m) => m.createTable("t", (t) => t.id({ name: "key" } as never)),
      'createTable("t"): id(): unknown option "name". The options are "type".',
    ],
    [
      "options given twice",
      (m) => m.createTable("t", (t) => loose(t).id?.({ type: "integer" }, { type: "bigint" })),
      'createTable("t"): id(): give the options once, as t.id(options) or t.id(name, options).',
    ],
  ])("refuses %s with the options' own message", (_name, define, message) => {
    expect(() => record(define)).toThrow(new TypeError(message));
  });
});

describe("arguments refused when recorded", () => {
  test.each<[string, (m: MigrationBuilder) => void]>([
    ["an empty table name", (m) => m.createTable("", (t) => t.id())],
    ["a name with NUL", (m) => m.createTable("a\u0000b", (t) => t.id())],
    ["a non-function definition", (m) => loose(m).createTable?.("t", "id")],
    ["a table without columns", (m) => m.createTable("t", () => {})],
    ["a table without a primary key", (m) => m.createTable("t", (t) => t.text("a"))],
    ["primaryKey: false with a key column", (m) => m.createTable("t", (t) => t.id(), { primaryKey: false })],
    ["primaryKey: true", (m) => m.createTable("t", (t) => t.id(), { primaryKey: true as never })],
    ["an unknown option", (m) => m.createTable("t", (t) => t.id(), { temporary: true } as never)],
    ["options that are not an object", (m) => m.createTable("t", (t) => t.id(), [] as never)],
    ["a non-boolean flag", (m) => m.createTable("t", (t) => t.id(), { ifNotExists: "yes" } as never)],
    ["an empty schema", (m) => m.createTable("t", (t) => t.id(), { schema: "" })],
    ["an id of another type", (m) => m.createTable("t", (t) => t.id("id", { type: "uuid" } as never))],
    ["an id named by null", (m) => m.createTable("t", (t) => t.id(null as never))],
    [
      "a bad reference action",
      (m) => m.createTable("t", (t) => t.id() && t.references("o", "orgs", { onDelete: "drop" } as never)),
    ],
    ["a reference to an empty table", (m) => m.createTable("t", (t) => t.id() && t.references("o", ""))],
    ["enumText without values", (m) => m.createTable("t", (t) => t.id() && t.enumText("r", []))],
    [
      "enumText with a lone surrogate",
      (m) => m.createTable("t", (t) => t.id() && t.enumText("r", ["\udfff"])),
    ],
    ["enumText with a non-string", (m) => m.createTable("t", (t) => t.id() && t.enumText("r", [1] as never))],
    [
      "enumText with values that are not an array",
      (m) => m.createTable("t", (t) => t.id() && t.enumText("r", "a" as never)),
    ],
    [
      "timestamps of another type",
      (m) => m.createTable("t", (t) => t.id() && t.timestamps({ type: "date" } as never)),
    ],
    ["an alterTable that changes nothing", (m) => m.alterTable("t", () => {})],
    ["an alterTable without a function", (m) => loose(m).alterTable?.("t")],
    [
      "remove options without a type",
      (m) => m.alterTable("t", (t) => t.remove("a", undefined, { notNull: true })),
    ],
    [
      "modify with a bad notNull",
      (m) => m.alterTable("t", (t) => t.modify("a", "text", { notNull: 1 } as never)),
    ],
    [
      "modify from an unknown type",
      (m) => m.alterTable("t", (t) => t.modify("a", "text", { from: "varchar" } as never)),
    ],
    [
      "modify from with an unknown key",
      (m) => m.alterTable("t", (t) => t.modify("a", "text", { from: { type: "text", size: 1 } } as never)),
    ],
    ["rename to nothing", (m) => m.alterTable("t", (t) => t.rename("a", ""))],
    ["an index without columns", (m) => m.createIndex("t", [])],
    ["an index on a non-array", (m) => m.createIndex("t", "a" as never)],
    ["an expression index without a name", (m) => m.createIndex("t", [fragment`lower(a)`])],
    ["an index column that is not a name or fragment", (m) => m.createIndex("t", [1 as never])],
    ["include that is not an array", (m) => m.createIndex("t", ["a"], { include: "b" as never })],
    ["ifExists on createIndex", (m) => m.createIndex("t", ["a"], { ifExists: true })],
    ["ifNotExists on dropIndex", (m) => m.dropIndex("t", ["a"], { ifNotExists: true })],
    ["a constraint with neither check nor exclude", (m) => m.createConstraint("t", "c", {})],
    [
      "a constraint with both",
      (m) => m.createConstraint("t", "c", { check: fragment`a`, exclude: fragment`a with =` }),
    ],
    ["using on a check", (m) => m.createConstraint("t", "c", { check: fragment`a`, using: "gist" })],
    ["using without exclude", (m) => m.dropConstraint("t", "c", { using: "gist" })],
    ["a check that is not a fragment", (m) => m.createConstraint("t", "c", { check: "a > 0" as never })],
    ["execute of a string", (m) => m.execute("drop table users" as never)],
    [
      "execute of an expression that is not a fragment",
      (m) => m.execute({ node: { kind: "param" }, params: [] } as never),
    ],
    ["a schema without a name", (m) => m.createSchema("")],
    ["dropSchema with a bad option", (m) => m.dropSchema("s", { force: true } as never)],
    ["an extension without a name", (m) => m.createExtension("")],
    ["dropExtension with a bad option", (m) => m.dropExtension("e", { cascade: true } as never)],
    ["renameTable to nothing", (m) => m.renameTable("a", "")],
    ["dropTable with a bad option", (m) => m.dropTable("a", undefined, { force: true } as never)],
    [
      "decimal with a bad option",
      (m) => m.createTable("t", (t) => t.decimal("d", { size: 3 } as never).primaryKey()),
    ],
    [
      "time with a bad option",
      (m) => m.createTable("t", (t) => t.time("d", { zone: true } as never).primaryKey()),
    ],
  ])("%s", (_name, define) => {
    expect(() => record(define)).toThrow(TypeError);
  });
});

describe("what is recorded", () => {
  test("dropTable keeps the definition it is given, and the key rule applies to it", () => {
    const [op] = record((m) => m.dropTable("logs", (t) => t.text("line"), { primaryKey: false }));
    expect(op).toMatchObject({
      op: "dropTable",
      ifExists: false,
      cascade: false,
      definition: { op: "createTable" },
    });
    expect(() => record((m) => m.dropTable("logs", (t) => t.text("line")))).toThrow(/no primary key/);
  });

  test("remove keeps the type and options it is given", () => {
    const [op] = record((m) =>
      m.alterTable("t", (t) => t.remove("n", "integer", { notNull: true, default: 3 })),
    );
    expect(op?.op === "alterTable" && op.changes[0]).toMatchObject({
      change: "remove",
      column: "n",
      definition: { name: "n", notNull: true, default: { kind: "value", value: 3 } },
    });
  });

  test("modify keeps what it changes and what it changes from", () => {
    const [op] = record((m) =>
      m.alterTable("t", (t) => {
        t.modify("a", "bigint");
        t.modify("b", "text", { default: null, from: { type: "text", default: "x" } });
      }),
    );
    expect(op?.op === "alterTable" && op.changes).toMatchObject([
      { change: "modify", column: "a", notNull: undefined, default: undefined, from: undefined },
      { change: "modify", column: "b", default: null, from: { default: { kind: "value", value: "x" } } },
    ]);
  });

  test("an exclusion constraint uses gist unless told otherwise", () => {
    const [op] = record((m) => m.createConstraint("t", "c", { exclude: fragment`a with &&` }));
    expect(op?.op === "createConstraint" && op.definition.using).toBe("gist");
  });

  test("dropConstraint without a definition records none", () => {
    const [op] = record((m) => m.dropConstraint("t", "c"));
    expect(op).toMatchObject({ op: "dropConstraint", definition: undefined });
  });

  test("execute keeps both statements and their values", () => {
    const [op] = record((m) =>
      m.execute(fragment`insert into t values (${1})`, fragment`delete from t where a = ${1}`),
    );
    expect(op?.op === "execute" && [op.up.params, op.down?.params]).toEqual([[1], [1]]);
  });
});
