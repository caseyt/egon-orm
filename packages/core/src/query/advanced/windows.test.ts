import { Post } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import {
  count,
  cumeDist,
  exists,
  firstValue,
  fragment,
  from,
  lag,
  lastValue,
  lead,
  nthValue,
  ntile,
  param,
  percentRank,
  rank,
  rowNumber,
  selectedAs,
  sum,
  t,
  val,
} from "../../index.js";
import { canonical, compiled } from "./test-helpers.js";

const posts = from(Post, "p");
const byAuthor = posts.windows({ w: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.id] }) });

describe("window functions", () => {
  test("load ranks and counts as numbers, distributions as floats, values with their argument's type", () => {
    expect(rowNumber().type?.name).toBe("bigint(number)");
    expect(rank().type?.name).toBe("bigint(number)");
    expect(percentRank().type?.name).toBe("float");
    expect(cumeDist().type?.name).toBe("float");
    expect(ntile(3).type?.name).toBe("integer");
    posts.select(({ p }) => {
      expect(lag(p.title).type).toBe(p.title.type);
      expect(firstValue(p.views).type).toBe(p.views.type);
      expect(lastValue(p.views).type).toBe(p.views.type);
      expect(nthValue(p.views, 1).type).toBe(p.views.type);
      return p.id;
    });
  });

  test("lag and lead write only the arguments given; the default is bound with the value's type", () => {
    posts.select(({ p }) => {
      expect((lag(p.views).node as { args: readonly unknown[] }).args).toHaveLength(1);
      expect((lead(p.views, 3).node as { args: readonly unknown[] }).args).toHaveLength(2);
      const withDefault = lead(p.views, 1, 0).node as { args: readonly { type?: unknown }[] };
      expect(withDefault.args[2]?.type).toBe(p.views.type);
      expect((lag(p.title, param("k", t.integer())).named[0]?.name)).toBe("k");
      return p.id;
    });
  });

  test("a whole-number argument must be at least 1, or an expression", () => {
    expect(() => ntile(0)).toThrow(/ntile\(\) takes the number of buckets as a whole number of at least 1/);
    expect(() => ntile(1.5)).toThrow(/it was given 1.5/);
    expect(() => ntile("2" as never)).toThrow(/it was given string/);
    posts.select(({ p }) => {
      expect(() => nthValue(p.title, -1)).toThrow(/the row number/);
      expect(() => lag(p.title, 0)).toThrow(/the offset/);
      expect(() => lag(p.title, 1, undefined as never)).toThrow(/undefined/);
      expect(ntile(p.views as never).node.kind).toBe("aggregate");
      return p.id;
    });
    expect(() => lag("title" as never)).toThrow(/lag\(\) takes an expression/);
    expect(() => firstValue(1 as never)).toThrow(/firstValue\(\) takes an expression/);
  });

  test("a window function without over() is refused in a select and in an order", () => {
    expect(() => posts.select(() => ({ n: rowNumber() }) as never)).toThrow(
      /select\(\): rowNumber\(\) is a window function and needs a window/,
    );
    expect(() => posts.orderBy(() => rank() as never)).toThrow(/orderBy\(\): rank\(\) is a window function/);
  });

  test("filter() on a window function is refused", () => {
    expect(() => posts.select(({ p }) => ({ n: rowNumber().filter(p.published.isNotNull()).over() }))).toThrow(
      /takes no filter\(\)/,
    );
  });

  test("an aggregate over a window is not a window function: filter is fine", () => {
    const q = posts.select(({ p }) => ({ n: count().filter(p.published.isNotNull()).over() }));
    expect(compiled(q).sql).toBe('select count(*) filter (where "p"."published" is not null) over () as "c0" from "posts" as "p"');
  });

  test("window functions are found inside other expressions, but not inside subqueries", () => {
    expect(() => posts.select(() => ({ n: selectedAs(rank(), "r") }) as never)).toThrow(/rank\(\) is a window function/);
    expect(() => posts.select(({ p }) => ({ n: p.views.add(lag(p.views) as never) }))).toThrow(/lag\(\)/);
    const inner = byAuthor.select(() => rowNumber().over("w"));
    expect(() => posts.select(() => ({ ok: exists(inner) }))).not.toThrow();
  });
});

describe("named windows", () => {
  test("a window name must be declared before it is used", () => {
    expect(() => posts.select(() => ({ n: rowNumber().over("w") }) as never)).toThrow(
      /over\("w"\) names a window this query does not declare\. Declare it first/,
    );
    expect(() => byAuthor.select(() => ({ n: rowNumber().over("v") }) as never)).toThrow(/\(it declares w\)/);
    expect(() => byAuthor.orderBy(() => sum(val(1, t.integer())).over("x") as never)).toThrow(/over\("x"\)/);
    expect(byAuthor.select(() => ({ n: rowNumber().over("w") })).ast.select).toBeDefined();
  });

  test("names in inline windows' parts are checked too", () => {
    expect(() =>
      posts.select(({ p }) => ({ n: count().over({ partitionBy: [rank().over("nope")], orderBy: [p.id] }) }) as never),
    ).toThrow(/over\("nope"\)/);
    expect(() =>
      posts.select(({ p }) => ({ n: count().over({ orderBy: [rank().over("nope").desc()], partitionBy: [p.id] }) }) as never),
    ).toThrow(/over\("nope"\)/);
  });

  test("selectMerge is checked like select", () => {
    expect(() =>
      posts.select(({ p }) => ({ id: p.id })).selectMerge(() => ({ n: rowNumber().over("w") }) as never),
    ).toThrow(/selectMerge\(\): over\("w"\)/);
  });

  test("windows() adds definitions with their parameters in canonical order", () => {
    const q = posts
      .where(({ p }) => p.views.gt(1))
      .windows({ a: ({ p }) => ({ partitionBy: [p.views.mod(param("m", t.integer()))] }) })
      .windows({
        b: ({ p }) => ({
          orderBy: [p.views.desc(), p.id],
          frame: fragment`rows between ${val(2, t.integer())} preceding and current row`,
        }),
      })
      .select(({ p }) => ({ id: p.id, a: count().over("a"), b: sum(p.views).over("b") }));
    expect(canonical(q)).toBe(true);
    expect(q.ast.windows.map((node) => node.name)).toEqual(["a", "b"]);
    expect(compiled(q, "all", { m: 3 }).sql).toBe(
      'select "p"."id" as "c0", count(*) over "a" as "c1", sum("p"."views") over "b" as "c2" from "posts" as "p" where "p"."views" > $1 window "a" as (partition by "p"."views" % $2), "b" as (order by "p"."views" desc, "p"."id" asc rows between cast($3 as integer) preceding and current row)',
    );
  });

  test("windows() checks its argument", () => {
    expect(() => posts.windows("w" as never)).toThrow(/an object of named windows/);
    expect(() => posts.windows({})).toThrow(/no window/);
    expect(() => posts.windows({ "1w": () => ({}) })).toThrow(/not an identifier/);
    expect(() => byAuthor.windows({ w: () => ({}) })).toThrow(/already declares/);
    expect(() => posts.windows({ w: 1 as never })).toThrow(/takes a callback/);
    expect(() => posts.windows({ w: () => 3 as never })).toThrow(/must return a window/);
    expect(() => posts.windows({ w: () => ({ order: [] }) as never })).toThrow(/has no "order"/);
    expect(() => posts.windows({ w: ({ p }) => ({ partitionBy: p.id }) as never })).toThrow(/partitionBy is an array/);
    expect(() => posts.windows({ w: () => ({ partitionBy: [1] }) as never })).toThrow(/not an expression/);
    expect(() => posts.windows({ w: () => ({ orderBy: ["x"] }) as never })).toThrow(/not an expression or an order item/);
    expect(() => posts.windows({ w: ({ p }) => ({ frame: p.id }) })).toThrow(/frame is a fragment/);
    expect(() =>
      posts.windows({
        w: () => ({ partitionBy: [param("n", t.integer()), param("n", t.string())] }),
      }),
    ).toThrow(/"n" is used with two types/);
  });

  test("exclude(\"windows\") is refused while a select or order still uses a named window", () => {
    expect(() => byAuthor.select(() => ({ n: rowNumber().over("w") })).exclude("windows")).toThrow(/over\("w"\)/);
    expect(() =>
      byAuthor
        .select(({ p }) => ({ id: p.id }))
        .orderBy(() => rowNumber().over("w"))
        .exclude("windows"),
    ).toThrow(/over\("w"\)/);
    expect(byAuthor.exclude("windows").ast.windows).toEqual([]);
    expect(byAuthor.select(({ p }) => ({ id: p.id })).exclude("windows").ast.windows).toEqual([]);
  });
});
