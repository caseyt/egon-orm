// Type tests for expressions: which operators exist on which types, what they accept and
// reject, their result types, and how named parameters are tracked.
import type { Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { AnySchema, FieldNames, Row } from "../contracts/schema.js";
import { Schema, t } from "../schema/index.js";
import type {
  Col,
  Expr,
  NoParams,
  NoType,
  OrderExpr,
  ParamsOf,
  SomeParams,
  SubqueryOperand,
  Untyped,
} from "./expr.js";
import {
  type Aggregate,
  and,
  arrayAgg,
  avg,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  exists,
  fragment,
  jsonAgg,
  lit,
  max,
  min,
  not,
  now,
  or,
  param,
  stringAgg,
  sum,
  val,
} from "./functions.js";

type Columns<S extends AnySchema> = {
  readonly [K in FieldNames<S>]: Col<K extends keyof Row<S> ? Row<S>[K] : never>;
};

class Ledger extends Schema("ledgers", {
  id: t.integer().primaryKey(),
  total: t.bigint(),
  balance: t.decimal(),
  meta: t.json<{ readonly limits: readonly number[] }>(),
  scores: t.array(t.integer()),
}) {}

declare const u: Columns<typeof User>;
declare const p: Columns<typeof Post>;
declare const l: Columns<typeof Ledger>;
declare const authorIds: SubqueryOperand<number, NoParams>;
declare const titles: SubqueryOperand<string, NoParams>;
declare const withParams: SubqueryOperand<number, { readonly since: Date }>;

type Value<X> = X extends Expr<infer T, infer _P> ? T : never;

describe("columns", () => {
  test("carry the field's type, nullable or not", () => {
    expectTypeOf(u.email).toEqualTypeOf<Col<string>>();
    expectTypeOf(u.name).toEqualTypeOf<Col<string | null>>();
    expectTypeOf(u.role).toEqualTypeOf<Col<"admin" | "member">>();
    expectTypeOf(p.tagList).toEqualTypeOf<Col<string[] | null>>();
    expectTypeOf<Value<typeof u.age>>().toEqualTypeOf<number | null>();
  });
});

describe("comparison", () => {
  test("every comparison is a boolean expression with no params", () => {
    expectTypeOf(u.age.gte(18)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.age.gt(1)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.age.lt(1)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.age.lte(1)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.email.eq("a@b.c")).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.email.neq("a@b.c")).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.age.between(18, 65)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.name.isNull()).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.name.isNotNull()).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.age.gte(18)).not.toBeAny();
  });

  test("accepts a value of the column's type or an expression of it", () => {
    u.role.eq("admin");
    u.name.eq(u.email);
    u.email.eq(u.name);
    u.age.eq(p.views);
    u.createdAt.gt(new Date());
    u.createdAt.gt(p.publishedAt);
  });

  test("rejects a value or expression of another type", () => {
    // @ts-expect-error a number column is not compared with a string
    u.age.gt("x");
    // @ts-expect-error not a member of the enum
    u.role.eq("owner");
    // @ts-expect-error an expression of another type
    u.age.eq(u.email);
    // @ts-expect-error a date column is not compared with a string
    u.createdAt.gt("2026-01-01");
  });

  test("rejects null and undefined: use isNull", () => {
    // @ts-expect-error null in a comparison is always unknown
    u.name.eq(null);
    // @ts-expect-error undefined is not a value
    u.name.neq(undefined);
    // @ts-expect-error neither end of a range may be null
    u.age.between(null, 65);
  });

  test("isDistinctFrom accepts null", () => {
    expectTypeOf(u.name.isDistinctFrom(null)).toEqualTypeOf<Expr<boolean, NoParams>>();
    u.name.isDistinctFrom("x");
    // @ts-expect-error still typed
    u.name.isDistinctFrom(1);
  });

  test("in takes an array, an array expression or a single-value subquery", () => {
    expectTypeOf(u.role.in(["admin", "member"])).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.id.in([])).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.id.notIn([1, 2])).toEqualTypeOf<Expr<boolean, NoParams>>();
    u.id.in(authorIds);
    u.email.in(p.tagList);
    // @ts-expect-error not members of the enum
    u.role.in(["owner"]);
    // @ts-expect-error no null in a list
    u.name.in(["a", null]);
    // @ts-expect-error a subquery of another type
    u.id.in(titles);
    // @ts-expect-error a single value is not a list
    u.id.in(1);
  });
});

describe("boolean", () => {
  test("and, or and not exist on boolean expressions", () => {
    expectTypeOf(u.age.gte(18).and(u.role.eq("admin"))).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.age.gte(18).or(p.published)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(p.published.not()).toEqualTypeOf<Expr<boolean, NoParams>>();
    p.published.and(true);
  });

  test("do not exist on other types", () => {
    // @ts-expect-error a number is not a condition
    u.age.and(u.age.gte(1));
    // @ts-expect-error a string is not a condition
    u.email.not();
    // @ts-expect-error the operand must be boolean
    p.published.and(u.age);
  });

  test("the free functions take boolean expressions", () => {
    expectTypeOf(and(u.age.gte(18), p.published)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(or()).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(not(p.published)).toEqualTypeOf<Expr<boolean, NoParams>>();
    // @ts-expect-error not a condition
    and(u.age);
    // @ts-expect-error not a condition
    not(u.email);
  });
});

describe("text", () => {
  test("like, notLike and ilike exist on text", () => {
    expectTypeOf(u.name.ilike("%ann%")).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.email.like("%@x")).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(u.email.notLike(u.name)).toEqualTypeOf<Expr<boolean, NoParams>>();
    u.role.like("adm%");
  });

  test("text operators do not exist on other types", () => {
    // @ts-expect-error ilike on a number
    u.age.ilike("%1%");
    // @ts-expect-error lower on a date
    u.createdAt.lower();
    // @ts-expect-error concat on a number
    u.age.concat("x");
    // @ts-expect-error the pattern is text
    u.email.like(1);
  });

  test("concat, lower and upper keep null from any nullable part", () => {
    expectTypeOf(u.email.concat(" ", u.email)).toEqualTypeOf<Expr<string, NoParams>>();
    expectTypeOf(u.email.concat(" ", u.name)).toEqualTypeOf<Expr<string | null, NoParams>>();
    expectTypeOf(u.name.concat("!")).toEqualTypeOf<Expr<string | null, NoParams>>();
    expectTypeOf(u.email.lower()).toEqualTypeOf<Expr<string, NoParams>>();
    expectTypeOf(u.name.upper()).toEqualTypeOf<Expr<string | null, NoParams>>();
    expectTypeOf(u.role.lower()).toEqualTypeOf<Expr<string, NoParams>>();
    // @ts-expect-error null is not a part
    u.email.concat(null);
  });
});

describe("arithmetic", () => {
  test("keeps the operand's number type and propagates null", () => {
    expectTypeOf(u.lockVersion.add(1)).toEqualTypeOf<Expr<number, NoParams>>();
    expectTypeOf(p.views.add(1)).toEqualTypeOf<Expr<number | null, NoParams>>();
    expectTypeOf(u.lockVersion.sub(p.views)).toEqualTypeOf<Expr<number | null, NoParams>>();
    expectTypeOf(u.lockVersion.mul(2)).toEqualTypeOf<Expr<number, NoParams>>();
    expectTypeOf(u.lockVersion.div(2)).toEqualTypeOf<Expr<number, NoParams>>();
    expectTypeOf(u.lockVersion.mod(2)).toEqualTypeOf<Expr<number, NoParams>>();
    expectTypeOf(p.views.neg()).toEqualTypeOf<Expr<number | null, NoParams>>();
    expectTypeOf(l.total.add(1n)).toEqualTypeOf<Expr<bigint, NoParams>>();
  });

  test("does not exist on other types, nor take other types", () => {
    // @ts-expect-error add on text
    u.email.add(1);
    // @ts-expect-error add on a date
    u.createdAt.add(1);
    // @ts-expect-error a string operand
    u.age.add("1");
    // @ts-expect-error a number operand for a bigint
    l.total.add(1);
    // @ts-expect-error null operand
    u.age.add(null);
  });
});

describe("arrays", () => {
  test("contains, containedBy, overlaps and has exist on arrays and take their element type", () => {
    expectTypeOf(p.tagList.contains(["ts"])).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(p.tagList.containedBy(["ts", "sql"])).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(p.tagList.overlaps(["ts"])).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(p.tagList.has("ts")).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(l.scores.has(1)).toEqualTypeOf<Expr<boolean, NoParams>>();
    // @ts-expect-error elements are strings
    p.tagList.contains([1]);
    // @ts-expect-error the element is a string
    p.tagList.has(1);
    // @ts-expect-error has on text
    u.email.has("a");
  });

  test("append and remove keep the array type", () => {
    expectTypeOf(p.tagList.append("ts")).toEqualTypeOf<Expr<string[], NoParams>>();
    expectTypeOf(p.tagList.remove("ts")).toEqualTypeOf<Expr<string[] | null, NoParams>>();
    // @ts-expect-error the element is a string
    p.tagList.append(1);
    // @ts-expect-error append on a number
    u.age.append(1);
  });
});

describe("JSON", () => {
  test("path is unknown and pathText is nullable text", () => {
    expectTypeOf(u.settings.path("theme")).toEqualTypeOf<Expr<unknown, NoParams>>();
    expectTypeOf(u.settings.pathText("theme")).toEqualTypeOf<Expr<string | null, NoParams>>();
    expectTypeOf(l.meta.path("limits", 0).cast(t.integer())).toEqualTypeOf<Expr<number, NoParams>>();
  });

  test("does not exist on scalar types and needs a key", () => {
    // @ts-expect-error path on text
    u.email.path("a");
    // @ts-expect-error path on a number
    u.age.pathText("a");
    // @ts-expect-error at least one key
    u.settings.path();
    // @ts-expect-error keys are strings or numbers
    u.settings.path(true);
  });
});

describe("typing", () => {
  test("cast takes a field type and keeps the operand's null", () => {
    expectTypeOf(u.age.cast(t.string())).toEqualTypeOf<Expr<string | null, NoParams>>();
    expectTypeOf(u.lockVersion.cast(t.string())).toEqualTypeOf<Expr<string, NoParams>>();
    expectTypeOf(fragment`now()`.cast(t.timestamp())).toEqualTypeOf<Expr<Date, NoParams>>();
    // @ts-expect-error a field type, not a type name
    u.age.cast("text");
  });

  test("as changes the TypeScript type only", () => {
    expectTypeOf(fragment`lower(${u.email})`.as<string>()).toEqualTypeOf<Expr<string, NoParams>>();
  });
});

describe("ordering", () => {
  test("asc and desc make order items, refined with nulls first or last", () => {
    expectTypeOf(u.createdAt.desc()).toEqualTypeOf<OrderExpr<NoParams>>();
    expectTypeOf(u.createdAt.desc().nullsLast()).toEqualTypeOf<OrderExpr<NoParams>>();
    expectTypeOf(u.name.asc().nullsFirst()).toEqualTypeOf<OrderExpr<NoParams>>();
  });

  test("an order item is not an expression", () => {
    // @ts-expect-error no comparison on an order item
    u.createdAt.desc().eq(1);
  });
});

describe("aggregates", () => {
  test("count is a number", () => {
    expectTypeOf(count()).toEqualTypeOf<Aggregate<number, NoParams>>();
    expectTypeOf(count(p.id)).toEqualTypeOf<Aggregate<number, NoParams>>();
    expectTypeOf(countDistinct(p.authorId)).toEqualTypeOf<Aggregate<number, NoParams>>();
  });

  test("sum, avg, min and max are nullable", () => {
    expectTypeOf(sum(p.views)).toEqualTypeOf<Aggregate<number | null, NoParams>>();
    expectTypeOf(sum(l.total)).toEqualTypeOf<Aggregate<bigint | null, NoParams>>();
    expectTypeOf(sum(l.balance)).toEqualTypeOf<Aggregate<string | null, NoParams>>();
    expectTypeOf(avg(u.age)).toEqualTypeOf<Aggregate<number | null, NoParams>>();
    expectTypeOf(avg(l.total)).toEqualTypeOf<Aggregate<number | null, NoParams>>();
    expectTypeOf(avg(l.balance)).toEqualTypeOf<Aggregate<string | null, NoParams>>();
    expectTypeOf(min(p.createdAt)).toEqualTypeOf<Aggregate<Date | null, NoParams>>();
    expectTypeOf(max(u.role)).toEqualTypeOf<Aggregate<"admin" | "member" | null, NoParams>>();
    // @ts-expect-error sum of a date
    sum(u.createdAt);
    // @ts-expect-error avg of a boolean
    avg(p.published);
  });

  test("the list aggregates", () => {
    expectTypeOf(arrayAgg(p.title)).toEqualTypeOf<Aggregate<string[] | null, NoParams>>();
    expectTypeOf(jsonAgg(p.title)).toEqualTypeOf<Aggregate<unknown[] | null, NoParams>>();
    expectTypeOf(stringAgg(p.title, ", ")).toEqualTypeOf<Aggregate<string | null, NoParams>>();
    // @ts-expect-error string_agg joins text
    stringAgg(p.views, ", ");
  });

  test("filter and over exist on aggregates only", () => {
    expectTypeOf(sum(p.views).filter(p.published)).toEqualTypeOf<Aggregate<number | null, NoParams>>();
    expectTypeOf(count().over("w")).toEqualTypeOf<Aggregate<number, NoParams>>();
    expectTypeOf(
      sum(p.views).over({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }),
    ).toEqualTypeOf<Aggregate<number | null, NoParams>>();
    expectTypeOf(count(p.id).gt(3)).toEqualTypeOf<Expr<boolean, NoParams>>();
    // @ts-expect-error filter is for aggregates
    p.views.filter(p.published);
    // @ts-expect-error over is for aggregates
    p.views.over();
    // @ts-expect-error the filter is a condition
    count().filter(p.views);
  });
});

describe("functions", () => {
  test("coalesce drops null when the last argument is not nullable", () => {
    expectTypeOf(coalesce(u.name, u.email)).toEqualTypeOf<Expr<string, NoParams>>();
    expectTypeOf(coalesce(u.name, "anonymous")).toEqualTypeOf<Expr<string, NoParams>>();
    expectTypeOf(coalesce(u.name, u.passwordHash)).toEqualTypeOf<Expr<string | null, NoParams>>();
    expectTypeOf(coalesce(sum(p.views), 0)).toEqualTypeOf<Expr<number, NoParams>>();
    // @ts-expect-error the arguments share a type
    coalesce(u.name, 1);
    // @ts-expect-error at least two arguments
    coalesce(u.name);
  });

  test("caseWhen is nullable until else", () => {
    const minor = caseWhen(u.age.lt(18), "minor");
    expectTypeOf<Value<typeof minor>>().toEqualTypeOf<string | null>();
    // Text with no type: fine in a select, but it gives later branches no type.
    expectTypeOf(minor.else("adult")).toEqualTypeOf<Expr<string, NoParams> & NoType>();
    // Untyped numbers: the result cannot be selected (owner decision, 2026-10-15).
    expectTypeOf(caseWhen(u.age.lt(13), 1).when(u.age.lt(18), 2).else(3)).toEqualTypeOf<
      Expr<number, NoParams> & Untyped
    >();
    expectTypeOf(caseWhen(p.published, p.title).else(u.name)).toEqualTypeOf<Expr<string | null, NoParams>>();
    // @ts-expect-error the condition is boolean
    caseWhen(u.age, "x");
  });

  test("now is a date and exists is a boolean", () => {
    expectTypeOf(now()).toEqualTypeOf<Expr<Date, NoParams>>();
    expectTypeOf(exists(authorIds)).toEqualTypeOf<Expr<boolean, NoParams>>();
    // @ts-expect-error a query, not an expression
    exists(u.age.gte(1));
  });

  test("val keeps the value's type, or takes the field type's", () => {
    expectTypeOf(val("member")).toEqualTypeOf<Expr<"member", NoParams> & NoType>();
    expectTypeOf(val(new Date(), t.timestamp())).toEqualTypeOf<Expr<Date, NoParams>>();
    u.role.eq(val("member"));
    // @ts-expect-error the value does not fit the field type
    val("x", t.integer());
  });

  test("lit takes only the safe literal kinds", () => {
    expectTypeOf(lit(true)).toEqualTypeOf<Expr<boolean, NoParams>>();
    expectTypeOf(lit(0)).toEqualTypeOf<Expr<number, NoParams>>();
    expectTypeOf(lit(null)).toEqualTypeOf<Expr<null, NoParams>>();
    // @ts-expect-error a string is never inlined
    lit("admin");
  });
});

describe("fragment", () => {
  test("is unknown until typed", () => {
    expectTypeOf(fragment`lower(${u.email})`).toEqualTypeOf<Expr<unknown, NoParams>>();
    expectTypeOf(fragment`similarity(${u.name}, ${"ann"}) > ${0.3}`.as<boolean>()).toEqualTypeOf<
      Expr<boolean, NoParams>
    >();
    expectTypeOf(fragment.ident("search_vector")).toEqualTypeOf<Expr<unknown, NoParams>>();
  });

  test("is a tagged template only", () => {
    // @ts-expect-error a string is never SQL text
    fragment("lower(email)");
    // @ts-expect-error undefined cannot be bound
    fragment`x = ${undefined}`;
  });
});

describe("named parameters", () => {
  test("param tracks its name and type", () => {
    const minAge = param("minAge", t.integer());
    expectTypeOf(minAge).toEqualTypeOf<Expr<number, { minAge: number }>>();
    expectTypeOf(param("since", t.timestamp().nullable())).toEqualTypeOf<
      Expr<Date | null, { since: Date | null }>
    >();
    // @ts-expect-error a field type is required
    param("minAge");
  });

  test("operators carry the params of both sides", () => {
    const where = u.age
      .gte(param("minAge", t.integer()))
      .and(u.role.eq(param("role", t.enum(["admin", "member"]))));
    expectTypeOf<ParamsOf<typeof where>>().toEqualTypeOf<{ minAge: number; role: "admin" | "member" }>();
    const between = u.age.between(param("low", t.integer()), param("high", t.integer()));
    expectTypeOf<ParamsOf<typeof between>>().toEqualTypeOf<{ low: number; high: number }>();
    const text = u.email.concat(param("suffix", t.string())).lower();
    expectTypeOf<ParamsOf<typeof text>>().toEqualTypeOf<{ suffix: string }>();
    const sub = u.id.in(withParams);
    expectTypeOf<ParamsOf<typeof sub>>().toEqualTypeOf<{ readonly since: Date }>();
  });

  test("functions merge the params of every argument", () => {
    const all = and(u.age.gte(param("a", t.integer())), u.name.eq(param("b", t.string())), p.published);
    expectTypeOf<ParamsOf<typeof all>>().toEqualTypeOf<{ a: number; b: string }>();
    const total = sum(p.views).filter(p.views.gt(param("min", t.integer())));
    expectTypeOf<ParamsOf<typeof total>>().toEqualTypeOf<{ min: number }>();
    const label = caseWhen(u.age.lt(param("adult", t.integer())), "minor").else(param("other", t.string()));
    expectTypeOf<ParamsOf<typeof label>>().toEqualTypeOf<{ adult: number; other: string }>();
    const raw = fragment`${u.age} > ${param("n", t.integer())}`;
    expectTypeOf<ParamsOf<typeof raw>>().toEqualTypeOf<{ n: number }>();
    const order = u.age.add(param("shift", t.integer())).desc();
    expectTypeOf<ParamsOf<typeof order>>().toEqualTypeOf<{ shift: number }>();
    const fallback = coalesce(u.name, param("name", t.string()));
    expectTypeOf<ParamsOf<typeof fallback>>().toEqualTypeOf<{ name: string }>();
  });

  test("an expression with params is still an operand", () => {
    const withParam: Expr<boolean, { minAge: number }> = u.age.gte(param("minAge", t.integer()));
    expectTypeOf(withParam.and(p.published)).toEqualTypeOf<Expr<boolean, { minAge: number }>>();
    const anyCondition: Expr<boolean | null, SomeParams> = withParam;
    void anyCondition;
  });
});

describe("an operand that is always null", () => {
  test("is refused at compile time where a value is compared", () => {
    // @ts-expect-error lit(null) is null
    u.age.eq(lit(null));
    // @ts-expect-error val(null) is null
    u.name.eq(val(null));
    // @ts-expect-error a cast of null is still null
    u.age.eq(val(null).cast(t.integer()));
    // @ts-expect-error neither end of a range
    u.age.between(lit(null), 5);
    // @ts-expect-error nor the high end
    u.age.between(1, val(null));
    // @ts-expect-error in takes no null
    u.id.in(val(null));
    // @ts-expect-error a pattern
    u.email.like(val(null));
    // @ts-expect-error arithmetic
    u.age.add(lit(null));
    // @ts-expect-error an element
    p.tagList.has(val(null));
    // @ts-expect-error a separator
    stringAgg(p.title, val(null));
    expectTypeOf(val(null).cast(t.integer())).toEqualTypeOf<Expr<null, NoParams>>();
  });

  test("is accepted where null means something", () => {
    u.name.isDistinctFrom(lit(null));
    p.tagList.remove(val(null));
    caseWhen(p.published, lit(null));
  });
});

describe("named parameters are a requirement", () => {
  test("an expression that needs a parameter is not one that needs none", () => {
    // @ts-expect-error minAge would be lost
    const adults: Expr<boolean> = u.age.gte(param("minAge", t.integer()));
    void adults;
    // @ts-expect-error role would be lost
    const fewer: Expr<boolean, { minAge: number }> = and(
      u.age.gte(param("minAge", t.integer())),
      u.role.eq(param("role", t.enum(["admin", "member"]))),
    );
    void fewer;
  });

  test("declaring a parameter the expression does not use is allowed", () => {
    const more: Expr<boolean, { minAge: number }> = u.age.gte(18);
    void more;
    function adults(): Expr<boolean, { minAge: number }> {
      return u.age.gte(param("minAge", t.integer()));
    }
    expectTypeOf<ParamsOf<ReturnType<typeof adults>>>().toEqualTypeOf<{ minAge: number }>();
    expectTypeOf<ParamsOf<ReturnType<typeof adults>>>().not.toBeAny();
  });

  test("any expression fits SomeParams", () => {
    const any: Expr<boolean | null, SomeParams> = u.age.gte(param("minAge", t.integer()));
    void any;
  });

  test("one name with two types does not compile where two expressions meet", () => {
    const n = u.age.add(param("n", t.integer()));
    expectTypeOf(n.eq(param("n", t.integer()))).toEqualTypeOf<Expr<boolean, { n: number }>>();
    // @ts-expect-error n is a number on the left
    n.eq(param("n", t.string()).as<number>());
    const cond = u.age.gte(param("n", t.integer()));
    // @ts-expect-error and
    cond.and(u.email.eq(param("n", t.string())));
    // @ts-expect-error between
    u.age.between(param("n", t.integer()), param("n", t.string()).as<number>());
    // @ts-expect-error filter
    sum(p.views.add(param("n", t.integer()))).filter(u.email.eq(param("n", t.string())));
    // @ts-expect-error caseWhen
    caseWhen(cond, param("n", t.string()));
    // @ts-expect-error isDistinctFrom
    n.isDistinctFrom(param("n", t.string()).as<number>());
  });
});

describe("fragment interpolations", () => {
  test("take values, expressions and queries, not order items or plain objects", () => {
    fragment`${1} ${"a"} ${1n} ${true} ${null} ${new Date()} ${new Uint8Array()} ${[1, 2]} ${u.age} ${authorIds}`;
    // @ts-expect-error an order item is not an expression
    fragment`${u.name.asc()}`;
    // @ts-expect-error a plain object has no type to be bound with
    fragment`${{ theme: "dark" }}`;
  });
});

describe("window specs keep their named parameters (review round 2)", () => {
  const mp = param("minAge", t.integer());
  const frame = fragment`ROWS ${param("rows", t.integer())} PRECEDING`;
  test("each member on its own", () => {
    expectTypeOf(sum(p.views).over({ partitionBy: [mp] })).toEqualTypeOf<
      Aggregate<number | null, { minAge: number }>
    >();
    expectTypeOf(sum(p.views).over({ orderBy: [u.age.add(mp).desc()] })).toEqualTypeOf<
      Aggregate<number | null, { minAge: number }>
    >();
    expectTypeOf(sum(p.views).over({ orderBy: [mp] })).toEqualTypeOf<
      Aggregate<number | null, { minAge: number }>
    >();
    expectTypeOf(sum(p.views).over({ frame })).toEqualTypeOf<Aggregate<number | null, { rows: number }>>();
    expectTypeOf(sum(p.views).over({})).toEqualTypeOf<Aggregate<number | null, NoParams>>();
  });

  test("members together", () => {
    expectTypeOf(sum(p.views).over({ partitionBy: [mp], frame })).toEqualTypeOf<
      Aggregate<number | null, { minAge: number; rows: number }>
    >();
    expectTypeOf(sum(p.views).over({ partitionBy: [p.authorId], orderBy: [mp.desc()], frame })).toEqualTypeOf<
      Aggregate<number | null, { minAge: number; rows: number }>
    >();
    expectTypeOf(sum(p.views).over({ partitionBy: [p.authorId], orderBy: [p.id] })).toEqualTypeOf<
      Aggregate<number | null, NoParams>
    >();
  });
});

describe("unknown parameters (SomeParams) stay unknown through every combinator (review round 2)", () => {
  function erased(): Expr<boolean, SomeParams> {
    return u.age.gte(param("minAge", t.integer()));
  }
  const known = u.email.eq("x");
  test("the result needs unknown parameters, so it is not an Expr with none", () => {
    expectTypeOf<ParamsOf<ReturnType<typeof and<[Expr<boolean, SomeParams>, typeof known]>>>>().toBeNever();
    // @ts-expect-error and()
    const a: Expr<boolean> = and(erased(), known);
    // @ts-expect-error or()
    const b: Expr<boolean> = or(known, erased());
    // @ts-expect-error not()
    const c: Expr<boolean> = not(erased());
    // @ts-expect-error .and()
    const d: Expr<boolean> = known.and(erased());
    // @ts-expect-error .or() on the unknown side
    const e: Expr<boolean> = erased().or(known);
    // @ts-expect-error coalesce
    const f: Expr<number> = coalesce(u.age, fragment`${erased()}`.as<number>());
    // @ts-expect-error fragment
    const g: Expr<unknown> = fragment`${known} AND ${erased()}`;
    // @ts-expect-error caseWhen (condition)
    const h: Expr<string> = caseWhen(erased(), "a").else("b");
    // @ts-expect-error caseWhen (value)
    const i: Expr<boolean | null> = caseWhen(known, erased());
    // @ts-expect-error aggregate filter
    const j: Expr<number> = count().filter(erased());
    // @ts-expect-error aggregate over
    const k: Expr<number> = count().over({ partitionBy: [erased()] });
    // @ts-expect-error comparison with it
    const l: Expr<boolean> = p.published.eq(erased());
    void [a, b, c, d, e, f, g, h, i, j, k, l];
  });

  test("declared parameters compose as before", () => {
    function adults(): Expr<boolean, { minAge: number }> {
      return u.age.gte(param("minAge", t.integer()));
    }
    expectTypeOf(and(adults(), known)).toEqualTypeOf<Expr<boolean, { minAge: number }>>();
    expectTypeOf(fragment`${adults()}`).toEqualTypeOf<Expr<unknown, { minAge: number }>>();
  });
});

describe("fragment arrays (review round 2)", () => {
  test("hold values, not expressions", () => {
    fragment`${[1, 2]} ${[["a"], ["b", null]]} ${[new Date()]}`;
    // @ts-expect-error an array of expressions is not one parameter
    fragment`${[u.id, u.email]}`;
    // @ts-expect-error nor of objects
    fragment`${[{ a: 1 }]}`;
    // @ts-expect-error a symbol is not bound
    fragment`${Symbol("x")}`;
  });
});
