import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ParamSlot } from "../contracts/adapter.js";
import type { QueryAst } from "../contracts/query.js";
import { QueryError } from "../errors.js";
import { from, param, t, val } from "../index.js";
import { bindParams, type NamedValues, toSql, wholeNumber } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { mysqlDialect, postgresDialect, sqliteDialect } from "./dialect.js";

const double = (value: unknown) => (value as number) * 2;

describe("bindParams", () => {
  test("each slot takes its value from params or from the named values, in slot order", () => {
    const slots: ParamSlot[] = [
      { kind: "named", name: "b", toDb: undefined, redact: false },
      { kind: "inline", index: 1, toDb: undefined, redact: false },
      { kind: "list", index: 0, toDb: undefined, redact: false },
      { kind: "element", index: 0, element: 1, toDb: undefined, redact: false },
    ];
    expect(bindParams(slots, [[10, 20], "x"], { b: true })).toEqual([true, "x", [10, 20], 20]);
  });

  test("toDb converts every value but null, and every element of a list", () => {
    const slots: ParamSlot[] = [
      { kind: "inline", index: 0, toDb: double, redact: false },
      { kind: "inline", index: 1, toDb: double, redact: false },
      { kind: "list", index: 2, toDb: double, redact: false },
      { kind: "element", index: 2, element: 0, toDb: double, redact: false },
      { kind: "named", name: "n", toDb: double, redact: false },
    ];
    expect(bindParams(slots, [3, null, [1, null, 4]], { n: 5 })).toEqual([6, null, [2, null, 8], 2, 10]);
  });

  test("a list that is not an array is passed as it is", () => {
    const slots: ParamSlot[] = [{ kind: "list", index: 0, toDb: double, redact: false }];
    expect(bindParams(slots, [null])).toEqual([null]);
  });

  test("a named value may be null", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "n", toDb: double, redact: false }];
    expect(bindParams(slots, [], { n: null })).toEqual([null]);
  });

  test("a missing named value throws, listing each name once", () => {
    const slots: ParamSlot[] = [
      { kind: "named", name: "minAge", toDb: undefined, redact: false },
      { kind: "named", name: "minAge", toDb: undefined, redact: false },
      { kind: "named", name: "role", toDb: undefined, redact: false },
    ];
    expect(() => bindParams(slots, [])).toThrow(
      'The query needs the named parameters "minAge", "role", which were not given a value.',
    );
    expect(() => bindParams(slots, [], { role: "admin", minAge: undefined })).toThrow(
      'The query needs the named parameter "minAge", which was not given a value.',
    );
  });

  test("an inherited property is not a named value", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "toString", toDb: undefined, redact: false }];
    expect(() => bindParams(slots, [], {})).toThrow('needs the named parameter "toString"');
  });

  test("a named value the query does not use throws", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "minAge", toDb: undefined, redact: false }];
    expect(() => bindParams(slots, [], { minAge: 1, maxAge: 2, extra: 3 })).toThrow(
      'The query has no named parameters "maxAge", "extra"; it takes "minAge".',
    );
    expect(() => bindParams([], [], { minAge: 1 })).toThrow(
      'The query has no named parameter "minAge"; it takes none.',
    );
  });

  test("a compiled query binds named and positional values together", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .where(({ u }) => u.role.eq("admin"))
      .limit(10);
    const plan = createCompiler(postgresDialect).compile(q.ast, "all", undefined);
    expect(toSql(plan, q.ast.params, { minAge: 18 })).toEqual({
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u" where "u"."age" >= $1 and "u"."role" = $2 limit $3',
      params: [18, "admin", 10],
    });
  });
});

describe("a t.integer() value that is not a whole number (owner decision, 2026-10-20)", () => {
  const MESSAGE =
    "has the type t.integer() (its own, or that of the column beside it), but its value is not a whole number. Give a fraction a float type, val(2.5, t.float()), or round it.";
  const bind = (
    dialect: Parameters<typeof createCompiler>[0],
    q: { readonly ast: QueryAst },
    named?: NamedValues,
  ) => bindParams(createCompiler(dialect).compile(q.ast, "all", undefined).slots, q.ast.params, named);

  test("is refused when bound, naming the parameter by its position, on every dialect", () => {
    const q = from(User, "u")
      .where(({ u }) => u.role.eq("admin"))
      .where(({ u }) => u.age.eq(2.5));
    for (const dialect of [postgresDialect, mysqlDialect, sqliteDialect]) {
      expect(() => bind(dialect, q)).toThrow(QueryError);
      expect(() => bind(dialect, q)).toThrow(`Parameter 2 ${MESSAGE}`);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
      expect(() =>
        bind(
          postgresDialect,
          from(User, "u").where(({ u }) => u.age.lt(bad)),
        ),
      ).toThrow(`Parameter 1 ${MESSAGE}`);
    }
  });

  test("names a named parameter, and an item of a list", () => {
    const named = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    expect(() => bind(postgresDialect, named, { minAge: 17.5 })).toThrow(
      `The named parameter "minAge" ${MESSAGE}`,
    );
    const listed = from(User, "u").where(({ u }) => u.age.in([1, 2.5]));
    expect(() => bind(postgresDialect, listed)).toThrow(`An item of parameter 1 ${MESSAGE}`);
    // Expanded into one placeholder per item where there are no array parameters.
    expect(() => bind(mysqlDialect, listed)).toThrow(`Parameter 2 ${MESSAGE}`);
  });

  test("covers between and the values of updateAll's set", () => {
    const between = from(User, "u").where(({ u }) => u.age.between(1, 2.5));
    expect(() => bind(postgresDialect, between)).toThrow(`Parameter 2 ${MESSAGE}`);
    const update = from(Post, "p").set(({ p }) => ({ views: p.views.mul(1.5) }));
    const plan = createCompiler(sqliteDialect).compile(update.ast, "updateAll", undefined);
    expect(() => bindParams(plan.slots, update.ast.params)).toThrow(`Parameter 1 ${MESSAGE}`);
    const plain = from(Post, "p").set({ views: 2.5 });
    const planned = createCompiler(mysqlDialect).compile(plain.ast, "updateAll", undefined);
    expect(() => bindParams(planned.slots, plain.ast.params)).toThrow(`Parameter 1 ${MESSAGE}`);
  });

  test("passes whole numbers, null, digit text and other types unchanged", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.eq(-3))
      .where(({ u }) => u.age.isDistinctFrom(param("none", t.integer())))
      .select(({ u }) => ({ f: u.age.mul(val(2.5, t.float())) }));
    expect(bind(postgresDialect, q, { none: null })).toEqual([2.5, -3, null]);
    expect(wholeNumber("12")).toBe("12");
    expect(wholeNumber(7)).toBe(7);
  });

  test("is one shared check, so plans compiled twice are equal", () => {
    const q = from(User, "u").where(({ u }) => u.age.eq(3));
    const [a, b] = [createCompiler(postgresDialect), createCompiler(postgresDialect)].map(
      (compiler) => compiler.compile(q.ast, "all", undefined).slots,
    );
    expect(a?.[0]?.toDb).toBe(wholeNumber);
    expect(a).toEqual(b);
  });
});
