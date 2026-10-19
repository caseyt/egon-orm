// The checks added in review round 1: tuples of bound values, outerRef's schema and
// shadowing, sources that would need a lateral join, nested sources with selectedAs
// names, untyped values in set, window functions where they cannot be, unknown selectedAs
// references, cte(name, query) against the withCte body, and tuples in a select.
import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { createCompiler } from "../../compiler/compiler.js";
import { postgresDialect } from "../../compiler/dialect.js";
import { sameShape } from "../../compiler/same-shape.js";
import {
  caseWhen,
  coalesce,
  count,
  cte,
  exists,
  from,
  lit,
  outerRef,
  rowNumber,
  selectedAs,
  subquery,
  sum,
  t,
  tuple,
  val,
} from "../../index.js";
import { canonical, compiled } from "./test-helpers.js";

describe("tuples of bound values", () => {
  test("a typed value compared with another bound value is cast, so they compare as that type", () => {
    const q = from(Post, "p").where(() =>
      tuple(val(10, t.integer()), val(1, t.integer())).gt(tuple(val(9, t.integer()), 0)),
    );
    expect(compiled(q).sql).toMatch(
      /where \(cast\(\$1 as integer\), cast\(\$2 as integer\)\) > \(\$3, \$4\)$/,
    );
    const one = from(Post, "p").where(() => tuple(val(10, t.integer())).gt(tuple(val(9) as never)));
    expect(compiled(one).sql).toMatch(/where row\(cast\(\$1 as integer\)\) > row\(\$2\)$/);
    const right = from(Post, "p").where(() =>
      tuple(val(9) as never).lt(tuple(val(10, t.integer())) as never),
    );
    expect(compiled(right).sql).toMatch(/where row\(\$1\) < row\(cast\(\$2 as integer\)\)$/);
  });

  test("a column beside a bound value is not cast", () => {
    const q = from(Post, "p").where(({ p }) => tuple(p.id).gt(tuple(val(1, t.bigint({ mode: "number" })))));
    expect(compiled(q).sql).toMatch(/where row\("p"."id"\) > row\(\$1\)$/);
  });
});

describe("outerRef", () => {
  test("an outer binding of another schema is refused", () => {
    const q = from(Comment, "u").where(() =>
      exists(from(Post, "p").where(({ p }) => p.id.eq(outerRef("u", User).id))),
    );
    expect(() => compiled(q)).toThrow(
      /outerRef\("u", User\) expects the outer binding "u" to be User, but it is Comment/,
    );
  });

  test("a binding of the query using it, which would shadow the outer one, is refused", () => {
    const q = from(User, "p").where(() =>
      exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("p", User).id))),
    );
    expect(() => compiled(q)).toThrow(/has its own binding "p", which would be read instead/);
  });

  test("an outerRef column never shares a plan with a column that skips its check", () => {
    const compiler = createCompiler(postgresDialect);
    const plain = from(User, "p").where(() => exists(from(Post, "p").where(({ p }) => p.authorId.eq(p.id))));
    const shadowed = from(User, "p").where(() =>
      exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("p", User).id))),
    );
    expect(shadowed.ast.shape).not.toBe(plain.ast.shape);
    expect(canonical(shadowed)).toBe(true);
    compiler.compile(plain.ast, "all", undefined);
    expect(() => compiler.compile(shadowed.ast, "all", undefined)).toThrow(/would be read instead/);
    expect(sameShape(plain.ast, shadowed.ast)).toBe(false);
  });

  test("an outer binding of the right schema compiles", () => {
    const q = from(User, "u").where(() =>
      exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id))),
    );
    expect(compiled(q).sql).toMatch(/"p"."author_id" = "u"."id"\)$/);
  });

  test("an outer binding that is a source with no schema is refused", () => {
    const counts = from(Post, "p").select(({ p }) => ({ id: p.authorId }));
    const q = from(subquery(counts), "u").where(() =>
      exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id))),
    );
    expect(() => compiled(q)).toThrow(/but it is a source with no schema/);
  });
});

describe("a subquery in FROM or a join reads only the queries around it", () => {
  test("reading a sibling binding is refused: it would need a lateral join", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.authorId.eq(outerRef("u", User).id))
      .select(({ p }) => ({ id: p.id }));
    const q = from(User, "u").join(subquery(inner), "s", ({ u, s }) => s.id.eq(u.id));
    expect(() => compiled(q)).toThrow(/needs a lateral join, which is not supported yet/);
  });

  test("it may read a query around the one it is a source of, and that query's CTEs", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.authorId.eq(outerRef("o", User).id))
      .select(({ p }) => ({ id: p.id }));
    const q = from(User, "o").where(() => exists(from(subquery(inner), "s")));
    expect(compiled(q).sql).toMatch(
      /exists \(select 1 from \(select "p"."id" as "id" from "posts" as "p" where "p"."author_id" = "o"."id"\) as "s"\)/,
    );
    const viaCte = from(User, "u")
      .withCte(
        "ids",
        from(Post, "p").select(({ p }) => ({ id: p.id })),
      )
      .join(
        subquery(
          from(
            cte(
              "ids",
              from(Post, "p").select(({ p }) => ({ id: p.id })),
            ),
            "i",
          ),
        ),
        "s",
        ({ u, s }) => s.id.eq(u.id),
      );
    expect(compiled(viaCte).sql).toMatch(/inner join \(select "i"."id" as "id" from "ids" as "i"\) as "s"/);
  });
});

describe("sources over sources", () => {
  test("a selectedAs name of the innermost query is not the middle query's column name", () => {
    const inner = from(Post, "p").select(({ p }) => ({ a: selectedAs(p.id, "zz") }));
    const q = from(subquery(from(subquery(inner), "s")), "m").select(({ m }) => ({ v: m.a }));
    expect(compiled(q).sql).toBe(
      'select "m"."a" as "c0" from (select "s"."zz" as "a" from (select "p"."id" as "zz" from "posts" as "p") as "s") as "m"',
    );
  });
});

describe("untyped values in set", () => {
  test("a CASE or coalesce of values without a type that are not text is refused", () => {
    expect(() =>
      from(Post, "p").set(({ p }) => ({ views: caseWhen(p.published, val(1)).else(val(2)) }) as never),
    ).toThrow(/set\(\{ views \}\) was given a value with no type that is not text/);
    expect(() => from(Post, "p").set(() => ({ views: coalesce(val(1), val(2) as never) }) as never)).toThrow(
      /no type/,
    );
    expect(() => from(Post, "p").set(() => ({ views: val(5) }) as never)).toThrow(/no type/);
  });

  test("text, null, a typed value, a plain value and anything an operator types are fine", () => {
    const q = from(Post, "p").set(({ p }) => ({
      title: caseWhen(p.published, "a").else("b"),
      body: val(null),
      views: caseWhen(p.published, val(1, t.integer())).else(2),
      tagList: p.tagList.append("x"),
      publishedAt: null,
    }));
    expect(q.ast.updates).toHaveLength(5);
    // A CASE whose only value is a number with no type is refused, even beside NULL.
    expect(() =>
      from(Post, "p").set(() => ({ views: caseWhen(lit(true), 1).else(lit(null)) }) as never),
    ).toThrow(/no type/);
    // An operator types the value: allowed.
    expect(
      from(Post, "p").set(({ p }) => ({ views: p.views.add(val(2) as never) })).ast.updates,
    ).toHaveLength(1);
  });
});

describe("window functions where they cannot be", () => {
  const windowed = () => rowNumber().over();
  test("in where, orWhere, having, groupBy, a join's on, set and returning", () => {
    const posts = from(Post, "p");
    expect(() => posts.where(() => windowed().gt(1))).toThrow(
      /where\(\): rowNumber\(\) over a window, which cannot be used in where\(\): window functions are computed after the rows are filtered and grouped\. Select it, then filter/,
    );
    expect(() => posts.orWhere(() => windowed().gt(1))).toThrow(/orWhere\(\): rowNumber\(\)/);
    expect(() => posts.groupBy(({ p }) => p.id).having(() => count().over().gt(1))).toThrow(
      /having\(\): count\(\)/,
    );
    expect(() => posts.groupBy(() => windowed())).toThrow(/groupBy\(\): rowNumber\(\)/);
    expect(() => posts.join(User, "u", ({ u }) => u.id.eq(windowed() as never))).toThrow(
      /join\(\): rowNumber\(\)/,
    );
    expect(() => posts.joinAssoc("p", "author", "a", () => windowed().gt(0))).toThrow(
      /joinAssoc\(\): rowNumber\(\)/,
    );
    expect(() => posts.set(({ p }) => ({ views: p.views.add(windowed() as never) }))).toThrow(
      /set\(\): rowNumber\(\)/,
    );
    expect(() => posts.returning(() => ({ n: windowed() }) as never)).toThrow(/returning\(\): rowNumber\(\)/);
    expect(() => posts.returning(() => ({ n: sum(val(1, t.integer())).over({}) }) as never)).toThrow(
      /returning\(\): sum\(\)/,
    );
  });

  test("an aggregate without a window is fine in having, and a windowed subquery in where", () => {
    expect(() =>
      from(Post, "p")
        .groupBy(({ p }) => p.authorId)
        .having(() => count().gt(1)),
    ).not.toThrow();
    expect(() =>
      from(Post, "p").where(({ p }) => p.id.in(from(Post, "q").select(() => rowNumber().over()))),
    ).not.toThrow();
  });
});

describe("selectedAs references", () => {
  test("a name the select does not have is refused", () => {
    const q = from(Post, "p")
      .select(({ p }) => ({ id: p.id, total: selectedAs(p.views, "total") }))
      .orderBy(() => selectedAs("nope").desc());
    expect(() => compiled(q)).toThrow(
      /selectedAs\("nope"\) refers to a selected value of that name, and the query selects none/,
    );
    expect(() =>
      compiled(
        from(Post, "p")
          .groupBy(() => selectedAs("nope"))
          .select(({ p }) => ({ n: count(p.id) })),
      ),
    ).toThrow(/selectedAs\("nope"\)/);
  });

  test("on a combined query, a name the select does not have is refused too", () => {
    const left = from(User, "u").select(({ u }) => ({ id: selectedAs(u.id, "key") }));
    const right = from(User, "v").select(({ v }) => ({ id: selectedAs(v.id, "key") }));
    expect(compiled(left.union(right).orderBy(() => selectedAs("key"))).sql).toMatch(/order by "key" asc$/);
    expect(() => compiled(left.union(right).orderBy(() => selectedAs("nope")))).toThrow(
      /can only use expressions the query selects/,
    );
  });
});

describe("cte(name, query) against the withCte body", () => {
  const idsOf = from(Post, "p").select(({ p }) => ({ id: p.id }));
  test("other keys, or the same keys with other types, are refused", () => {
    const wrongKeys = from(cte("x", idsOf), "t").withCte(
      "x",
      from(User, "u").select(({ u }) => ({ email: u.email })),
    );
    expect(() => compiled(wrongKeys)).toThrow(
      /reads the CTE "x" as \{ id: bigint\(number\) \}, but the query given to withCte\("x", …\) returns \{ email: string \}/,
    );
    const wrongTypes = from(cte("x", idsOf), "t").withCte(
      "x",
      from(User, "u").select(({ u }) => ({ id: u.email })),
    );
    expect(() => compiled(wrongTypes)).toThrow(/returns \{ id: string \}/);
    const rows = from(cte("x", idsOf), "t").withCte("x", from(User, "u"));
    expect(() => compiled(rows)).toThrow(/returns something else/);
  });

  test("the same keys and types compile, from another query too", () => {
    const authors = from(Comment, "c").select(({ c }) => ({ id: c.postId }));
    expect(compiled(from(cte("x", idsOf), "t").withCte("x", authors)).sql).toMatch(/^with "x" as \(/);
  });
});

describe("tuples in a select", () => {
  test("are refused: a row value is compared, not selected", () => {
    expect(() => from(Post, "p").select(({ p }) => ({ row: tuple(p.id) }) as never)).toThrow(
      /select\(\) was given a row value \(tuple\) at "row"/,
    );
  });
});

describe("review round 1: the remaining cases", () => {
  test("set: a literal, a function of a value, a CASE with a column and a CASE without ELSE", () => {
    expect(from(Post, "p").set({ views: lit(1) as never }).ast.updates).toHaveLength(1);
    expect(from(Post, "p").set(() => ({ title: val("a").lower() })).ast.updates).toHaveLength(1);
    expect(from(Post, "p").set(({ p }) => ({ views: coalesce(p.views, 0) })).ast.updates).toHaveLength(1);
    expect(
      from(Post, "p").set(({ p }) => ({ views: caseWhen(p.published, p.views).else(2) })).ast.updates,
    ).toHaveLength(1);
    expect(() => from(Post, "p").set(({ p }) => ({ views: caseWhen(p.published, val(1)) }) as never)).toThrow(
      /no type/,
    );
  });

  test("an aggregate with a filter is checked inside where-like clauses too", () => {
    expect(() =>
      from(Post, "p")
        .groupBy(({ p }) => p.authorId)
        .having(({ p }) =>
          count()
            .filter(p.views.gt(rowNumber().over() as never))
            .gt(1),
        ),
    ).toThrow(/having\(\): rowNumber\(\)/);
    expect(() =>
      from(Post, "p")
        .groupBy(({ p }) => p.authorId)
        .having(({ p }) => count().filter(p.published.isNotNull()).gt(1)),
    ).not.toThrow();
  });

  test("a source over a source of whole rows with no select of its own", () => {
    const rows = from(subquery(from(Post, "p")), "r");
    from(subquery(rows), "o").where(({ o }) => {
      expect(o.title.node).toEqual({ kind: "column", binding: "o", field: "title", column: "title" });
      return o.views.gt(1);
    });
  });

  test("an untyped column in either the reference or the body is named in the message", () => {
    const untypedRef = from(User, "u").select(() => ({ s: val("x") }));
    const typedBody = from(User, "u").select(({ u }) => ({ s: u.email }));
    expect(() => compiled(from(cte("x", untypedRef), "t").withCte("x", typedBody))).toThrow(
      /as \{ s: untyped \}, but the query given to withCte\("x", …\) returns \{ s: string \}/,
    );
    expect(() => compiled(from(cte("x", typedBody), "t").withCte("x", untypedRef))).toThrow(
      /as \{ s: string \}, but the query given to withCte\("x", …\) returns \{ s: untyped \}/,
    );
  });
});

describe("review round 2", () => {
  test("a CASE or coalesce of NULLs only is refused in set unless the field is text", () => {
    expect(() =>
      from(Post, "p").set(({ p }) => ({ views: caseWhen(p.published, lit(null)).else(lit(null)) }) as never),
    ).toThrow(/set\(\{ views \}\) was given a value with no type that is not text/);
    expect(() =>
      from(Post, "p").set(({ p }) => ({ views: caseWhen(p.published, val(null)).else(lit(null)) }) as never),
    ).toThrow(/of NULLs only/);
    // (A coalesce of NULLs is refused by coalesce() itself.)
    // A text field takes it, and so does any field a bare NULL.
    expect(
      from(Post, "p").set(({ p }) => ({ body: caseWhen(p.published, lit(null)).else(lit(null)) as never }))
        .ast.updates,
    ).toHaveLength(1);
    expect(
      from(Post, "p").set({ views: lit(null) as never, body: val(null) as never }).ast.updates,
    ).toHaveLength(2);
    // Text among the values: the CASE is text, which a text field takes.
    expect(
      from(Post, "p").set(({ p }) => ({ title: caseWhen(p.published, "a").else(lit(null)) as never })).ast
        .updates,
    ).toHaveLength(1);
  });

  test("selectedAs references are refused where output names cannot be read", () => {
    const named = from(Post, "p");
    expect(() => named.where(() => selectedAs("a").eq(1 as never))).toThrow(
      /where\(\): selectedAs\("a"\) refers to a selected value by its name, which where\(\) cannot read/,
    );
    expect(() => named.orWhere(() => selectedAs("a").eq(1 as never))).toThrow(
      /orWhere\(\): selectedAs\("a"\)/,
    );
    expect(() => named.groupBy(({ p }) => p.authorId).having(() => selectedAs("a").eq(1 as never))).toThrow(
      /having\(\): selectedAs/,
    );
    expect(() => named.join(User, "u", ({ u }) => u.id.eq(selectedAs("a") as never))).toThrow(
      /join\(\): selectedAs/,
    );
    expect(() => named.set(() => ({ views: selectedAs("a") as never }))).toThrow(/set\(\): selectedAs/);
    expect(() => named.returning(() => ({ n: selectedAs("a") }))).toThrow(/returning\(\): selectedAs/);
    // groupBy and orderBy may refer to a name.
    expect(named.groupBy(() => selectedAs("a")).ast.groupBys).toHaveLength(1);
  });

  test("window functions outside filtering clauses get the plain message", () => {
    expect(() => from(Post, "p").returning(() => ({ n: rowNumber() }) as never)).toThrow(
      /returning\(\): rowNumber\(\) is a window function, which cannot be used in returning\(\): window functions are allowed only in select\(\) and orderBy\(\)\./,
    );
    expect(() => from(Post, "p").groupBy(() => rowNumber().over())).toThrow(
      /groupBy\(\): rowNumber\(\) over a window, which cannot be used in groupBy\(\): window functions are allowed only in select\(\) and orderBy\(\)\./,
    );
    expect(() => from(Post, "p").set(({ p }) => ({ views: p.views.add(count().over() as never) }))).toThrow(
      /set\(\): count\(\) over a window, which cannot be used in set\(\): window functions are allowed only/,
    );
  });

  test("sameShape tells an outerRef column from a plain one of the same name", () => {
    let plain: unknown;
    from(User, "u").where(({ u }) => {
      plain = u.id.node;
      return u.id.gt(0);
    });
    const outer = outerRef("u", User).id.node;
    expect(outer).toEqual(plain);
    expect(sameShape(outer, plain as typeof outer)).toBe(false);
    expect(sameShape(outer, outerRef("u", User).id.node)).toBe(true);
    // Another outerRef column node of the same schema, made apart from the cached one.
    expect(sameShape(outer, { ...outer })).toBe(false);
  });
});
