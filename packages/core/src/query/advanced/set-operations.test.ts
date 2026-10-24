import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { Category } from "../../compiler/advanced/advanced-queries.js";
import { cte, from, param, subquery, t, val } from "../../index.js";
import { canonical, compiled } from "./test-helpers.js";

const ids = from(User, "u").select(({ u }) => ({ id: u.id }));
const authors = from(Post, "p").select(({ p }) => ({ id: p.authorId }));

describe("set operations", () => {
  test("the other side's parameters and named parameters join the query's", () => {
    const left = from(User, "u")
      .where(({ u }) => u.age.gt(param("age", t.integer())))
      .select(({ u }) => ({ id: u.id }));
    const right = from(Post, "p")
      .where(({ p }) => p.views.gt(9))
      .select(({ p }) => ({ id: p.authorId }));
    const q = left.union(right).limit(3);
    expect(canonical(q)).toBe(true);
    expect(q.namedParams()).toEqual(["age"]);
    expect(compiled(q, "all", { age: 30 }).params).toEqual([30, 9, 3]);
  });

  test("one named parameter with two types on the two sides is refused", () => {
    const left = from(User, "u")
      .where(({ u }) => u.age.gt(param("n", t.integer())))
      .select(({ u }) => ({ id: u.id }));
    const right = from(Post, "p")
      .where(({ p }) => p.title.eq(param("n", t.string())))
      .select(({ p }) => ({ id: p.authorId }));
    expect(() => left.union(right as never)).toThrow(/union\(\): The named parameter "n"/);
  });

  test("only the combined rows' clauses may follow a set operation", () => {
    const q = ids.union(authors);
    expect(() => q.where(({ u }) => u.id.gt(1))).toThrow(/only orderBy\(\), limit\(\), offset\(\)/);
    expect(() => q.join(Comment, "c", ({ u, c }) => c.authorId.eq(u.id))).toThrow(/only orderBy/);
    expect(() => q.lock("update")).toThrow(/only orderBy/);
    expect(() => q.exclude("where")).toThrow(
      /exclude\("where"\) on a query combined with union\(\), intersect\(\) or except\(\) would change its left side only/,
    );
    expect(() => q.exclude({} as never)).toThrow(
      "query.excludeUnknown: exclude() was given an object, which is not a clause it removes.",
    );
    expect(
      q
        .orderBy(({ u }) => u.id)
        .offset(1)
        .schema("tenant_1")
        .exclude("setOperations").ast.combinations,
    ).toEqual([]);
  });

  test('exclude("setOperations") also drops the values of the queries it removes', () => {
    const left = from(User, "u")
      .where(({ u }) => u.age.gt(18))
      .select(({ u }) => ({ id: u.id }));
    const right = from(Post, "p")
      .where(({ p }) => p.views.gt(100))
      .select(({ p }) => ({ id: p.authorId }));
    const back = left.union(right).exclude("setOperations");
    expect(back.ast.params).toEqual(left.ast.params);
    expect(canonical(back)).toEqual(canonical(left));
  });

  test("a side with an order, a limit, an offset or a lock is refused", () => {
    expect(() => ids.orderBy(({ u }) => u.id).union(authors)).toThrow(
      /union\(\) was called on a query with an orderBy\(\)/,
    );
    expect(() => ids.limit(1).unionAll(authors)).toThrow(/with a limit\(\)/);
    expect(() => ids.offset(1).except(authors)).toThrow(/with an offset\(\)/);
    expect(() => from(User, "u").lock("update").union(from(User, "v"))).toThrow(/row lock/);
    expect(() => from(User, "u").union(from(User, "v").lock("update"))).toThrow(/row lock/);
  });

  test("a side with preloads or set(…) is refused", () => {
    expect(() =>
      from(User, "u")
        .preload("posts")
        .union(from(User, "v") as never),
    ).toThrow(/this query has preloads/);
    expect(() => from(User, "u").union(from(User, "v").preload("posts") as never)).toThrow(
      /the other query has preloads/,
    );
    expect(() => from(Post, "p").union(from(Post, "q").set({ views: 1 }))).toThrow(/set\(…\) assignments/);
  });

  test("the two sides must select the same shape, keys in the same order", () => {
    const swapped = from(User, "u").select(({ u }) => ({ b: u.email, a: u.id }));
    const ordered = from(User, "u").select(({ u }) => ({ a: u.id, b: u.email }));
    expect(() => ordered.union(swapped as never)).toThrow(
      /different shapes: this query returns an object with the keys a, b/,
    );
    expect(() => ordered.union(from(User, "u").select(({ u }) => ({ a: u.id })) as never)).toThrow(
      /different shapes/,
    );
    expect(() => from(User, "u").union(from(Post, "p") as never)).toThrow(
      /rows of User, the other rows of Post/,
    );
    expect(() =>
      from(User, "u")
        .select(({ u }) => [u.id, u.email])
        .union(from(User, "v").select(({ v }) => [v.id]) as never),
    ).toThrow(/an array of 2, the other an array of 1/);
    expect(() =>
      from(User, "u")
        .select(({ u }) => ({ x: u }))
        .union(from(User, "v").select(({ v }) => ({ x: v.id })) as never),
    ).toThrow(/at "x"/);
    expect(() =>
      from(User, "u")
        .select(({ u }) => ({ x: [u.id] }))
        .union(from(User, "v").select(({ v }) => ({ x: [v.id] }))),
    ).not.toThrow();
    expect(() =>
      from(User, "u")
        .select(({ u }) => ({ x: u.id }))
        .union(from(User, "v").select(({ v }) => ({ x: [v.id] })) as never),
    ).toThrow(/at "x": this query returns one value, the other an array of 1/);
  });

  test("a plain selected value on either side is refused, since it would not be sent to the database", () => {
    expect(() =>
      from(User, "u")
        .select(({ u }) => ({ id: u.id, kind: "user" }))
        .union(from(Post, "p").select(({ p }) => ({ id: p.authorId, kind: "post" }))),
    ).toThrow(/selects a plain value at "kind"/);
    expect(() =>
      from(User, "u")
        .select(({ u }) => [u.id, "user"])
        .union(from(Post, "p").select(({ p }) => [p.authorId, val("post")]) as never),
    ).toThrow(/at "1"/);
  });

  test("sides whose rows cannot be told apart (no schema) are not compared", () => {
    // A CTE typed by a query has no schema: its rows are compared by the database alone.
    const q = from(cte("a", ids), "a").union(from(cte("b", authors), "b"));
    expect(q.ast.combinations).toHaveLength(1);
    // A source over a query is compared through that query.
    const objects = from(subquery(ids), "s").union(from(subquery(authors), "a"));
    expect(objects.ast.combinations).toHaveLength(1);
    expect(() => from(cte("tree", Category), "t").union(from(User, "u") as never)).toThrow(
      /rows of Category/,
    );
  });

  test("the other side must be a query", () => {
    expect(() => ids.union("select 1" as never)).toThrow(/union\(\) takes another query/);
  });
});
