// The compiler caches write and explain plans under a key built from the statement's shape.
// Two statements that differ in their SQL must not share a key, or the second would be
// served the first one's plan. Each test below compiles a set of variants with one compiler
// (so that every variant after the first can find a cached plan) and checks that each gets
// exactly what a fresh compiler gives it.
import { Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExplainOptions, InsertPlanOptions, OnConflict } from "../contracts/adapter.js";
import type { FieldMeta } from "../contracts/schema.js";
import { from, t } from "../index.js";
import { binaryNode, fragmentNode, listNode, paramNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { type Compiler, createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, type SqlDialect, sqliteDialect } from "./dialect.js";
import { typeOf } from "./sql-fixtures.js";

const users = meta(User);
const tags = meta(Tag);
const field = (name: string): FieldMeta => users.fieldsByName.get(name) as FieldMeta;
const email = field("email");
const name = field("name");
const age = field("age");
const id = field("id");
const updatedAt = field("updatedAt");
/** A field of another schema, at the same position as `email` in `users`. */
const tagName = tags.fieldsByName.get("name") as FieldMeta;

const DIALECTS = [postgresDialect, mysqlDialect, sqliteDialect] as const;

/** What a compile gave: the SQL and slots, or the message it was refused with. */
function outcome(run: () => { readonly sql: string; readonly slots: unknown }): unknown {
  try {
    const plan = run();
    return { sql: plan.sql, slots: plan.slots };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Compiles every variant with one shared compiler, twice, and with a fresh compiler each. */
function expectNoSharedKeys<T>(
  dialect: SqlDialect,
  variants: readonly T[],
  run: (
    compiler: Compiler,
    variant: T,
  ) => {
    readonly sql: string;
    readonly slots: unknown;
  },
): void {
  const fresh = variants.map((variant) => outcome(() => run(createCompiler(dialect), variant)));
  const distinct = new Set(fresh.map((each) => JSON.stringify(each)));
  // The variants are meant to differ (some are refused by a dialect without the feature).
  expect(distinct.size).toBeGreaterThan(1);
  const shared = createCompiler(dialect);
  for (let round = 0; round < 2; round++) {
    variants.forEach((variant, i) => {
      expect(
        outcome(() => run(shared, variant)),
        `variant ${i}, round ${round}`,
      ).toEqual(fresh[i]);
    });
  }
}

const insertOf = (
  source: InsertPlanOptions["source"],
  onConflict: OnConflict | undefined = undefined,
  returning: readonly FieldMeta[] = [],
): InsertPlanOptions => ({ source, returning, onConflict });

const one = { kind: "values", rows: 1 } as const;
const INTEGER = typeOf(t.integer());
/** `$1 in ($2, …)` with a list of `length` integers: expanded to one placeholder each on MySQL and SQLite. */
const inList = (length: number) =>
  binaryNode(
    "in",
    paramNode(1, INTEGER, false),
    listNode(
      Array.from({ length }, (_, i) => i),
      INTEGER,
      false,
    ),
  );

const INSERTS: readonly InsertPlanOptions[] = [
  insertOf(one),
  insertOf({ kind: "values", rows: 2 }),
  insertOf(one, undefined, [id]),
  insertOf(one, undefined, [id, email]),
  insertOf(one, "nothing"),
  insertOf(one, { target: undefined, update: "all" }),
  insertOf(one, { target: [email], update: "all" }),
  insertOf(one, { target: [name], update: "all" }),
  insertOf(one, { target: [email, name], update: "all" }),
  insertOf(one, { target: { constraint: "users_email_key" }, update: "all" }),
  insertOf(one, { target: { constraint: "users_name_key" }, update: "all" }),
  insertOf(one, { target: fragmentNode(["(lower(email))"], []), update: "all" }),
  insertOf(one, { target: fragmentNode(["(lower(name))"], []), update: "all" }),
  insertOf(one, { target: [email], update: [name] }),
  insertOf(one, { target: [email], update: [email] }),
  insertOf(one, { target: [email], update: [email, name] }),
  insertOf(one, { target: [email], update: { except: [name] } }),
  insertOf(one, { target: [email], update: { except: [email] } }),
  insertOf(one, { target: [email], update: { except: [] } }),
  insertOf({ kind: "cells", rows: [[{ kind: "value" }, { kind: "value" }]] }),
  insertOf({ kind: "cells", rows: [[{ kind: "default" }, { kind: "value" }]] }),
  insertOf({ kind: "cells", rows: [[{ kind: "value" }, { kind: "default" }]] }),
  insertOf({
    kind: "cells",
    rows: [
      [{ kind: "value" }, { kind: "value" }],
      [{ kind: "default" }, { kind: "value" }],
    ],
  }),
  insertOf({ kind: "cells", rows: [[{ kind: "placeholder", name: "a" }, { kind: "value" }]] }),
  insertOf({ kind: "cells", rows: [[{ kind: "placeholder", name: "b" }, { kind: "value" }]] }),
  insertOf({ kind: "cells", rows: [[{ kind: "expr", expr: inList(1) }, { kind: "value" }]] }),
  insertOf({ kind: "cells", rows: [[{ kind: "expr", expr: inList(2) }, { kind: "value" }]] }),
  insertOf({ kind: "query", query: from(User, "u").select(({ u }) => [u.email, u.name]).ast }),
  insertOf({ kind: "query", query: from(User, "u").select(({ u }) => [u.name, u.email]).ast }),
];

test("the fixture: updatedAt is at position 10, email at 1 and id at 0", () => {
  expect([updatedAt.index, email.index, id.index]).toEqual([10, 1, 0]);
});

describe.each(DIALECTS)("$name", (dialect) => {
  test("inserts that differ in their source, returning list or conflict handling get plans of their own", () => {
    expectNoSharedKeys(dialect, INSERTS, (compiler, options) =>
      compiler.compileInsert(users, [email, name], options, undefined),
    );
  });

  test("inserts into another schema, another column list or another database schema get plans of their own", () => {
    const variants = [
      { meta: users, columns: [email, name], schema: undefined },
      { meta: users, columns: [name, email], schema: undefined },
      { meta: users, columns: [email], schema: undefined },
      { meta: users, columns: [age], schema: undefined },
      { meta: users, columns: [email, name], schema: "tenant_a" },
      { meta: users, columns: [email, name], schema: "tenant_b" },
      { meta: tags, columns: [tagName], schema: undefined },
    ];
    expectNoSharedKeys(dialect, variants, (compiler, each) =>
      compiler.compileInsert(each.meta, each.columns, insertOf(one), each.schema),
    );
  });

  test("updates that differ in their set, where or returning list or schema get plans of their own", () => {
    const variants = [
      { set: [name], where: [id], returning: [], schema: undefined },
      { set: [email], where: [id], returning: [], schema: undefined },
      { set: [name, email], where: [id], returning: [], schema: undefined },
      { set: [name], where: [email], returning: [], schema: undefined },
      { set: [name], where: [id, email], returning: [], schema: undefined },
      // Positions 1, 0 and 10: a key that ran the positions together would read "10" for both.
      { set: [name], where: [email, id], returning: [], schema: undefined },
      { set: [name], where: [updatedAt], returning: [], schema: undefined },
      { set: [name], where: [id], returning: [id], schema: undefined },
      { set: [name], where: [id], returning: [], schema: "tenant_a" },
    ];
    expectNoSharedKeys(dialect, variants, (compiler, each) =>
      compiler.compileUpdate(users, each.set, each.where, each.returning, each.schema),
    );
  });

  test("explains with different options get plans of their own", () => {
    const query = from(User, "u").ast;
    const variants: readonly ExplainOptions[] = [
      {},
      { analyze: false },
      { analyze: true },
      { format: "text" },
      { format: "json" },
      { analyze: true, format: "text" },
      { analyze: true, format: "json" },
    ];
    const run = (compiler: Compiler, options: ExplainOptions) =>
      compiler.compileExplain(query, "all", undefined, options);
    const fresh = variants.map((options) => outcome(() => run(createCompiler(dialect), options)));
    const shared = createCompiler(dialect);
    for (let round = 0; round < 2; round++) {
      variants.forEach((options, i) => {
        expect(
          outcome(() => run(shared, options)),
          JSON.stringify(options),
        ).toEqual(fresh[i]);
      });
    }
  });

  test("a field of another schema at the position of a cached plan's field is refused, hit or miss", () => {
    const compiler = createCompiler(dialect);
    const upsert = (onConflict: OnConflict) =>
      compiler.compileInsert(users, [email, name], insertOf(one, onConflict), undefined);
    const cases: readonly [OnConflict, OnConflict, string][] = [
      [{ target: [email], update: "all" }, { target: [tagName], update: "all" }, "onConflict's target"],
      [
        { target: [email], update: [email] },
        { target: [email], update: [tagName] },
        "onConflict's update list",
      ],
      [
        { target: [email], update: { except: [email] } },
        { target: [email], update: { except: [tagName] } },
        "onConflict's except list",
      ],
    ];
    for (const [valid, foreign, what] of cases) {
      const before = outcome(() => upsert(valid));
      if ("error" in (before as object)) continue; // a form this dialect refuses anyway
      expect(() => upsert(foreign)).toThrow(`${what} holds a field that is not a field of User.`);
    }
    // MySQL has no RETURNING: there, the returning lists are empty and not checked.
    const returns = dialect.capabilities.returning;
    const returning = returns ? [email] : [];
    compiler.compileInsert(users, [email], insertOf(one, undefined, returning), undefined);
    expect(() =>
      compiler.compileInsert(users, [tagName], insertOf(one, undefined, returning), undefined),
    ).toThrow("The insert's column list holds a field that is not a field of User.");
    compiler.compileUpdate(users, [email], [email], returning, undefined);
    expect(() => compiler.compileUpdate(users, [tagName], [email], returning, undefined)).toThrow(
      "The update's set list holds a field that is not a field of User.",
    );
    expect(() => compiler.compileUpdate(users, [email], [tagName], returning, undefined)).toThrow(
      "The update's where list holds a field that is not a field of User.",
    );
    if (returns) {
      expect(() =>
        compiler.compileInsert(users, [email], insertOf(one, undefined, [tagName]), undefined),
      ).toThrow("The returning list holds a field that is not a field of User.");
      expect(() => compiler.compileUpdate(users, [email], [email], [tagName], undefined)).toThrow(
        "The returning list holds a field that is not a field of User.",
      );
    }
  });
});

test("MySQL's explain keywords", () => {
  const compiler = createCompiler(mysqlDialect);
  const sql = (options: ExplainOptions) =>
    compiler.compileExplain(from(User, "u").ast, "all", undefined, options).sql;
  const select = "select `u`.`id`";
  expect(sql({})).toMatch(/^explain select /);
  expect(sql({ analyze: true })).toMatch(/^explain analyze select /);
  expect(sql({ format: "json" })).toMatch(/^explain format=json select /);
  expect(sql({ format: "text" })).toMatch(/^explain format=tree select /);
  expect(sql({ analyze: true, format: "text" })).toMatch(/^explain analyze format=tree select /);
  expect(sql({})).toContain(select);
  expect(() => sql({ analyze: true, format: "json" })).toThrow(
    'explain with both analyze and format "json" is not supported by mysql.',
  );
});
