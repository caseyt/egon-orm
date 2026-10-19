import { Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { Category } from "../../compiler/advanced/advanced-queries.js";
import {
  type Aggregate,
  caseWhen,
  count,
  cte,
  type Dynamic,
  dynamic,
  type Expr,
  exists,
  field,
  from,
  lag,
  lit,
  type NoParams,
  outerRef,
  param,
  prepare,
  type QueryParams,
  type QueryResult,
  rank,
  rowNumber,
  scalar,
  selectedAs,
  subquery,
  sum,
  t,
  tuple,
  type UsesWindow,
  val,
  type WindowFunction,
} from "../../index.js";

const counts = from(Post, "p")
  .groupBy(({ p }) => p.authorId)
  .select(({ p }) => ({ authorId: p.authorId, n: count() }));

describe("subquery and cte sources", () => {
  test("an object source exposes its keys as typed columns, and its rows", () => {
    const q = from(subquery(counts), "c").where(({ c }) => {
      expectTypeOf(c.n).toEqualTypeOf<Expr<number, NoParams>>();
      expectTypeOf(c.authorId).toEqualTypeOf<Expr<number, NoParams>>();
      return c.n.gt(5);
    });
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ authorId: number; n: number }>();
    expectTypeOf<QueryResult<typeof q>>().not.toBeAny();
    // @ts-expect-error the source has no such column
    from(subquery(counts), "c").where(({ c }) => c.title.eq("x"));
    // @ts-expect-error the columns keep their types
    from(subquery(counts), "c").where(({ c }) => c.n.eq("five"));
  });

  test("a left-joined source's columns are nullable, and so are its values when selected whole", () => {
    const q = from(User, "u")
      .leftJoin(subquery(counts), "c", ({ u, c }) => c.authorId.eq(u.id))
      .select(({ c }) => ({ n: c.n, all: c }));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{
      n: number | null;
      all: { authorId: number | null; n: number | null };
    }>();
  });

  test("a source of whole rows exposes the schema's binding and rows", () => {
    const q = from(subquery(from(Post, "p").where(({ p }) => p.published)), "r");
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<Post>();
    q.where(({ r }) => {
      expectTypeOf(r.$schema).toEqualTypeOf<typeof Post>();
      return r.views.gt(1);
    });
  });

  test("a query of one value, or an array, is not a source", () => {
    // @ts-expect-error a source selects an object or whole rows
    subquery(from(Post, "p").select(({ p }) => p.id));
    // @ts-expect-error an array is not an object source
    subquery(from(Post, "p").select(({ p }) => [p.id]));
  });

  test("the named parameters of a source are the query's", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.views.gt(param("min", t.integer())))
      .select(({ p }) => ({ id: p.id }));
    const q = from(subquery(inner), "s").where(({ s }) =>
      s.id.lt(param("max", t.bigint({ mode: "number" }))),
    );
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ min: number; max: number }>();
    const joined = from(User, "u").join(subquery(inner), "s", ({ u, s }) => s.id.eq(u.id));
    expectTypeOf<QueryParams<typeof joined>>().toEqualTypeOf<{ min: number }>();
  });

  test("cte typed by a schema or by its query", () => {
    const tree = from(cte("tree", Category), "t");
    expectTypeOf<QueryResult<typeof tree>>().toEqualTypeOf<Category>();
    const recent = from(cte("recent", counts), "r").withCte("recent", counts);
    expectTypeOf<QueryResult<typeof recent>>().toEqualTypeOf<{ authorId: number; n: number }>();
    const withParams = from(User, "u").withCte(
      "x",
      from(Post, "p").where(({ p }) => p.views.gt(param("v", t.integer()))),
    );
    expectTypeOf<QueryParams<typeof withParams>>().toEqualTypeOf<{ v: number }>();
  });

  test("scalar, exists and outerRef", () => {
    const n = scalar(from(Post, "p").select(() => count()));
    expectTypeOf(n).toEqualTypeOf<Expr<number | null, NoParams>>();
    const ref = outerRef("u", User);
    expectTypeOf(ref.email).toEqualTypeOf<typeof ref.email>();
    expectTypeOf(exists(from(Post, "p").where(({ p }) => p.authorId.eq(ref.id)))).toEqualTypeOf<
      Expr<boolean, NoParams>
    >();
  });
});

describe("set operations", () => {
  const emails = from(User, "u").select(({ u }) => ({ email: u.email }));

  test("both sides must return the same type", () => {
    const q = emails.union(from(Post, "p").select(({ p }) => ({ email: p.title })));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ email: string }>();
    // @ts-expect-error a number is not a string
    emails.union(from(Post, "p").select(({ p }) => ({ email: p.id })));
    // @ts-expect-error another key
    emails.except(from(Post, "p").select(({ p }) => ({ title: p.title })));
    // @ts-expect-error rows of another schema
    from(User, "u").intersect(from(Post, "p"));
  });

  test("the other side's named parameters are required", () => {
    const q = emails.unionAll(
      from(Post, "p")
        .where(({ p }) => p.views.gt(param("min", t.integer())))
        .select(({ p }) => ({ email: p.title })),
    );
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ min: number }>();
  });
});

describe("windows", () => {
  const posts = from(Post, "p");

  test("a named window must be declared", () => {
    const q = posts
      .windows({ w: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
      .select(({ p }) => ({ id: p.id, n: rowNumber().over("w"), total: sum(p.views).over("w") }));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ id: number; n: number; total: number | null }>();
    // @ts-expect-error "v" is not declared
    posts.windows({ w: () => ({}) }).select(() => ({ n: rowNumber().over("v") }));
    // @ts-expect-error no window declared at all
    posts.select(() => ({ n: count().over("w") }));
    // @ts-expect-error orderBy checks names too
    posts.orderBy(() => rank().over("w"));
    posts.windows({ w: () => ({}) }).orderBy(() => rank().over("w"));
  });

  test("a window function needs over()", () => {
    // @ts-expect-error rowNumber() has no window
    posts.select(() => ({ n: rowNumber() }));
    // @ts-expect-error lag() has no window
    posts.select(({ p }) => ({ n: lag(p.views) }));
    posts.select(({ p }) => ({ n: lag(p.views).over({ orderBy: [p.id] }) }));
  });

  test("windows' named parameters are the query's", () => {
    const q = posts.windows({ w: ({ p }) => ({ partitionBy: [p.views.mod(param("m", t.integer()))] }) });
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ m: number }>();
  });

  test("window functions' types", () => {
    posts.select(({ p }) => {
      expectTypeOf(rowNumber()).toEqualTypeOf<WindowFunction<number>>();
      expectTypeOf(lag(p.title).over()).toEqualTypeOf<Aggregate<string | null, NoParams>>();
      expectTypeOf(lag(p.views, 1, 0).over()).toEqualTypeOf<Aggregate<number | null, NoParams>>();
      expectTypeOf(rank().over("w")).toEqualTypeOf<Aggregate<number, NoParams> & UsesWindow<"w">>();
      return p.id;
    });
  });
});

describe("set and returning", () => {
  const posts = from(Post, "p");

  test("values and expressions are checked against the fields", () => {
    posts.set({ published: true, views: null });
    posts.set(({ p }) => ({
      views: p.views.add(1),
      tagList: p.tagList.append("x"),
      title: p.title.concat("!"),
    }));
    // @ts-expect-error title is a string
    posts.set({ title: 5 });
    // @ts-expect-error title is not nullable
    posts.set({ title: null });
    // @ts-expect-error no such column
    posts.set({ title: "x", nope: 1 });
    // @ts-expect-error an expression of another type
    posts.set(({ p }) => ({ title: p.views }));
    // A value without a type is fine: the field gives it one (review round 4).
    posts.set(() => ({ views: val(5) }));
  });

  test("named parameters of the values are required", () => {
    const q = posts.set(({ p }) => ({ views: p.views.add(param("step", t.integer())) }));
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ step: number }>();
  });

  test("returning() types the rows", () => {
    const q = posts.set({ published: true }).returning(({ p }) => ({ id: p.id, title: p.title }));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ id: number; title: string }>();
    // @ts-expect-error an untyped value in a RETURNING list
    posts.returning(() => ({ n: val(5) }));
  });
});

describe("dynamic", () => {
  const adult = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));

  test("a query without the binding, or with another schema under it, does not compile", () => {
    from(User, "u").where(adult);
    from(Post, "p")
      .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
      .where(adult);
    // @ts-expect-error no binding u
    from(Post, "p").where(adult);
    // @ts-expect-error u is a Post
    from(Post, "u").where(adult);
  });

  test("the fold keeps concrete named parameters", () => {
    const min = dynamic({ u: User }, ({ u }) => u.age.gte(param("min", t.integer())));
    const role = dynamic({ u: User }, ({ u }) => u.email.eq(param("role", t.string())));
    const both = min.and(role);
    const q = from(User, "u").where(both);
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ min: number; role: string }>();
    const folded = from(User, "u").where([adult, adult].reduce((acc, f) => acc.and(f), dynamic.true()));
    expectTypeOf<QueryParams<typeof folded>>().toEqualTypeOf<NoParams>();
    type Needed = Dynamic<{ u: typeof User }, Expr<boolean, { min: number }>>;
    const typed = [min, min].reduce<Needed>((acc, f) => acc.and(f), dynamic.true());
    expectTypeOf<QueryParams<ReturnType<typeof withTyped>>>().toEqualTypeOf<{ min: number }>();
    function withTyped() {
      return from(User, "u").where(typed);
    }
    [min, min].reduce<Dynamic<{ u: typeof User }, Expr<boolean, NoParams>>>(
      // @ts-expect-error an accumulator typed with fewer named parameters than it holds
      (acc, f) => acc.and(f),
      dynamic.true(),
    );
    // @ts-expect-error the explicit form takes no named parameters
    dynamic<{ u: typeof User }>(({ u }) => u.age.gte(param("min", t.integer())));
    // @ts-expect-error one name with two types
    min.and(dynamic({ u: User }, ({ u }) => u.email.eq(param("min", t.string()))));
  });

  test("field is typed as the union of the columns it may name", () => {
    from(User, "u").where(({ u }) => {
      expectTypeOf(field(u, "email")).toEqualTypeOf<Expr<string, NoParams>>();
      expectTypeOf(field(u, "age")).toEqualTypeOf<Expr<number | null, NoParams>>();
      const name: string = "email";
      expectTypeOf(field(u, name)).not.toBeAny();
      return u.age.gt(1);
    });
  });
});

describe("prepare, tuple, selectedAs", () => {
  test("a prepared query keeps the result and named parameters", () => {
    const byEmail = prepare(from(User, "u").where(({ u }) => u.email.eq(param("email", t.string()))));
    expectTypeOf<QueryResult<typeof byEmail>>().toEqualTypeOf<User>();
    expectTypeOf<QueryParams<typeof byEmail>>().toEqualTypeOf<{ email: string }>();
  });

  test("rows compare with rows of the same types", () => {
    from(Post, "p").where(({ p }) => {
      expectTypeOf(tuple(p.createdAt, p.id).lt(tuple(new Date(), 10))).toEqualTypeOf<
        Expr<boolean, NoParams>
      >();
      // @ts-expect-error a string where a number is
      tuple(p.createdAt, p.id).lt(tuple(new Date(), "10"));
      // @ts-expect-error another length
      tuple(p.createdAt, p.id).lt(tuple(new Date()));
      return p.id.gt(0);
    });
  });

  test("selectedAs keeps the expression's type and marks", () => {
    const q = from(Post, "p").select(({ p }) => ({
      v: selectedAs(p.views, "v"),
      n: selectedAs(count(), "n"),
    }));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ v: number | null; n: number }>();
    // @ts-expect-error a named copy of an untyped value is still untyped
    from(Post, "p").select(() => ({ v: selectedAs(val(5), "v") }));
    // @ts-expect-error a named copy of a window function still needs a window
    from(Post, "p").select(() => ({ v: selectedAs(rowNumber(), "v") }));
  });
});

describe("review round 1", () => {
  test("scalar refuses whole rows, objects and arrays", () => {
    expectTypeOf(scalar(from(Post, "p").select(({ p }) => p.title))).toEqualTypeOf<
      Expr<string | null, NoParams>
    >();
    // @ts-expect-error whole rows
    scalar(from(Post, "p"));
    // @ts-expect-error an object
    scalar(from(Post, "p").select(({ p }) => ({ a: p.id })));
    // @ts-expect-error an array of values
    scalar(from(Post, "p").select(({ p }) => [p.id, p.title]));
    // An array column is one value.
    scalar(from(Post, "p").select(({ p }) => p.tagList));
  });

  test("tuples: no null items, and not selected", () => {
    from(Post, "p").where(({ p }) => {
      // @ts-expect-error a null item
      tuple(p.id).gt(tuple(null));
      // @ts-expect-error an item that is always null
      tuple(p.id).gt(tuple(lit(null)));
      return tuple(p.views).gt(tuple(1));
    });
    // @ts-expect-error null is not a row item
    tuple(1, null);
    // @ts-expect-error a row value is not selected
    from(Post, "p").select(({ p }) => ({ row: tuple(p.id) }));
  });

  test("one named parameter with two types across clauses is never", () => {
    const asInt = from(Post, "p").where(({ p }) => p.views.gt(param("n", t.integer())));
    const union = asInt
      .select(({ p }) => ({ id: p.id }))
      .union(
        from(Post, "q")
          .where(({ q }) => q.title.eq(param("n", t.string())))
          .select(({ q }) => ({ id: q.id })),
      );
    expectTypeOf<QueryParams<typeof union>["n"]>().toBeNever();
    const withCte = asInt.withCte(
      "x",
      from(User, "u").where(({ u }) => u.email.eq(param("n", t.string()))),
    );
    expectTypeOf<QueryParams<typeof withCte>["n"]>().toBeNever();
    const windows = asInt.windows({
      w: ({ p }) => ({ partitionBy: [p.title.concat(param("n", t.string()))] }),
    });
    expectTypeOf<QueryParams<typeof windows>["n"]>().toBeNever();
    const set = asInt.set(({ p }) => ({ title: p.title.concat(param("n", t.string())) }));
    expectTypeOf<QueryParams<typeof set>["n"]>().toBeNever();
    const returning = asInt.returning(({ p }) => ({ t: p.title.concat(param("n", t.string())) }));
    expectTypeOf<QueryParams<typeof returning>["n"]>().toBeNever();
    const joined = asInt.join(
      subquery(
        from(User, "u")
          .where(({ u }) => u.email.eq(param("n", t.string())))
          .select(({ u }) => ({ id: u.id })),
      ),
      "s",
      ({ p, s }) => s.id.eq(p.authorId),
    );
    expectTypeOf<QueryParams<typeof joined>["n"]>().toBeNever();
  });

  test('exclude("windows") forgets the declared windows', () => {
    const declared = from(Post, "p").windows({ w: () => ({}) });
    declared.select(() => ({ n: rowNumber().over("w") }));
    // @ts-expect-error "w" is no longer declared
    declared.exclude("windows").select(() => ({ n: rowNumber().over("w") }));
  });

  test("and, or and not exist only on dynamic conditions", () => {
    const shape = dynamic({ u: User }, ({ u }) => ({ e: u.email }));
    const adult = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));
    adult.and(adult).or(adult).not();
    // @ts-expect-error not a condition
    shape.and(adult);
    // @ts-expect-error not a condition
    shape.or(adult);
    // @ts-expect-error not a condition
    shape.not();
  });

  test("no window function in returning or set", () => {
    // @ts-expect-error a window function without a window in RETURNING
    from(Post, "p").returning(() => ({ n: rowNumber() }));
    const declared = from(Post, "p").windows({ w: () => ({}) });
    // @ts-expect-error a named window in RETURNING
    declared.returning(() => ({ n: count().over("w") }));
    // @ts-expect-error a window function in a set value
    from(Post, "p").set(() => ({ views: count().over("w") }));
  });
});

describe("review round 3", () => {
  test("set takes values without a type: the field types them (review round 4)", () => {
    const posts = from(Post, "p");
    posts.set(() => ({ title: val("x") }));
    posts.set(({ p }) => ({ title: caseWhen(p.published, "a").else("b") }));
    posts.set(() => ({ body: val(null) }));
    posts.set(({ p }) => ({ views: caseWhen(p.published, 1).else(2) }));
    // The value must still be of the field's type.
    // @ts-expect-error a number is not a title
    posts.set(({ p }) => ({ title: caseWhen(p.published, 1).else(2) }));
    posts.set(({ p }) => ({ title: caseWhen(p.published, val("a", t.string())).else("b"), body: lit(null) }));
  });

  test("the guide's way out for scalar on a JSON column compiles", () => {
    const settings = scalar(
      from(User, "u")
        .where(({ u }) => u.id.eq(1))
        .select(({ u }) => u.settings.as<unknown>()),
    );
    expectTypeOf(settings).toEqualTypeOf<Expr<unknown, NoParams>>();
  });
});
