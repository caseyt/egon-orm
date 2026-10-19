// A value with no type that is not text cannot be selected (owner decision, 2026-10-15):
// in a select list nothing gives it a type, and the database would return it as text.
import { Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { caseWhen, coalesce, from, lit, t, val } from "../index.js";
import type { Expr, NoType, Untyped } from "./expr.js";

const users = from(User, "u");
// Widened, so that other values of the type fit next to them (`val(1)` alone is typed `1`).
const one: number = 1;
const a: string = "a";

describe("untyped values in a select", () => {
  test("val() of a non-text value is marked; of text, null or with a type it is not", () => {
    expectTypeOf(val(5)).toEqualTypeOf<Expr<5> & Untyped>();
    expectTypeOf(val(true)).toEqualTypeOf<Expr<true> & Untyped>();
    expectTypeOf(val("member")).toEqualTypeOf<Expr<"member"> & NoType>();
    expectTypeOf(val(null)).toEqualTypeOf<Expr<null> & NoType>();
    expectTypeOf(val(5, t.integer())).toEqualTypeOf<Expr<number>>();
  });

  test("an untyped non-text value does not compile in select or selectMerge, at any depth", () => {
    // @ts-expect-error: val(5) has no type
    users.select(() => val(5));
    // @ts-expect-error: val(true) has no type
    users.select(({ u }) => ({ id: u.id, flag: val(true) }));
    // @ts-expect-error: nested in an object and an array
    users.select(({ u }) => ({ id: u.id, inner: { list: [u.email, val(1)] } }));
    // @ts-expect-error: caseWhen with an untyped number
    users.select(({ u }) => caseWhen(u.age.lt(18), 1));
    // @ts-expect-error: the mark is kept through when() and else()
    users.select(({ u }) => caseWhen(u.age.lt(18), 1).when(u.age.lt(30), 2).else(3));
    // @ts-expect-error: an untyped val() as a later branch of a typed CASE
    users.select(({ u }) => caseWhen(u.age.lt(18), u.age).else(val(0)));
    // @ts-expect-error: selectMerge too
    users.select(({ u }) => ({ id: u.id })).selectMerge(() => ({ n: val(5) }));
  });

  test("typed values, text, null, literals and columns compile", () => {
    const q = users.select(({ u }) => ({
      id: u.id,
      n: val(5, t.integer()),
      label: val("member"),
      none: val(null),
      one: lit(1),
      kind: caseWhen(u.age.lt(18), "minor").else("adult"),
      age: caseWhen(u.age.lt(18), u.age).else(0),
      typed: caseWhen(u.age.lt(18), val(1, t.integer())).else(2),
    }));
    expectTypeOf(q.ast).not.toBeAny();
    users.select(({ u }) => ({ id: u.id })).selectMerge(() => ({ n: val(5, t.integer()) }));
  });

  test("an untyped value is fine where the other side types it", () => {
    users.where(({ u }) => u.age.eq(val(5))).select(({ u }) => u.id);
    from(Post, "p").where(({ p }) => p.views.gt(val(1)));
  });
});

describe("a CASE that has no type yet (review round 2)", () => {
  test("text, then an untyped number, is untyped", () => {
    // @ts-expect-error: the CASE started with text has no type for the 5
    users.select(({ u }) => caseWhen(u.age.lt(18), "minor").else(5));
    // @ts-expect-error: the same through when()
    users.select(({ u }) => caseWhen(u.age.lt(18), "minor").when(u.age.lt(30), 1));
    // @ts-expect-error: val("x") gives no type either
    users.select(({ u }) => caseWhen(u.age.lt(18), val("x")).else(5));
  });

  test("text branches, and a typed branch first, still compile", () => {
    users.select(({ u }) => caseWhen(u.age.lt(18), "minor").when(u.age.lt(30), "young").else("adult"));
    users.select(({ u }) => caseWhen(u.age.lt(18), u.email).else("x"));
    users.select(({ u }) => caseWhen(u.age.lt(18), val(1, t.integer())).else(2));
  });
});

describe("coalesce of untyped values (review round 2)", () => {
  test("is untyped when no argument has a type", () => {
    expectTypeOf(coalesce(val(1), val(1))).toExtend<Expr<number> & Untyped>();
    // @ts-expect-error: no argument gives the others a type
    users.select(() => coalesce(val(1), val(1)));
    // @ts-expect-error: nor a CASE without one
    users.select(({ u }) => coalesce(caseWhen(u.age.lt(18), 1), 2));
  });

  test("compiles with a typed argument, or with text only", () => {
    users.select(({ u }) => coalesce(val(one), u.age));
    users.select(({ u }) => coalesce(u.age, 1));
    users.select(() => coalesce(val(a), "b"));
  });
});

describe("comparisons where neither side has a type (review round 2)", () => {
  test("do not compile unless both are text", () => {
    // @ts-expect-error: 10 > 9 compared as text
    users.where(() => val(10).gt(9));
    // @ts-expect-error: eq
    users.where(() => val(true).eq(false));
    // @ts-expect-error: text and a number
    users.where(() => val("x").lt(9));
    // @ts-expect-error: between
    users.where(() => val(5).between(1, 9));
    // @ts-expect-error: in
    users.where(() => val(5).in([1, 2]));
    // @ts-expect-error: isDistinctFrom
    users.where(() => val(5).isDistinctFrom(null));
    // @ts-expect-error: a CASE without a type
    users.where(({ u }) => caseWhen(u.age.lt(18), 1).eq(1));
  });

  test("compile when one side has a type, or both are text", () => {
    users.where(() => val(a).lt("b"));
    users.where(() => val(one).gt(val(9, t.integer())));
    users.where(() => val(5, t.integer()).between(1, 9));
    users.where(() => val(a).in(["a", "b"]));
  });
});
