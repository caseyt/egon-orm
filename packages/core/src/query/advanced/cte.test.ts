import { Post, User, UserSettings } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { Category } from "../../compiler/advanced/advanced-queries.js";
import { count, cte, from, param, t } from "../../index.js";
import { canonical, compiled } from "./test-helpers.js";

const counts = from(Post, "p")
  .where(({ p }) => p.views.gt(param("min", t.integer())))
  .groupBy(({ p }) => p.authorId)
  .select(({ p }) => ({ authorId: p.authorId, n: count() }));

describe("withCte", () => {
  test("puts the CTE's parameters and named parameters into the query, in canonical order", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gt(1))
      .withCte("counts", counts)
      .join(cte("counts", counts), "c", ({ u, c }) => c.authorId.eq(u.id))
      .orderBy(({ c }) => c.n.desc());
    expect(canonical(q)).toBe(true);
    expect(q.namedParams()).toEqual(["min"]);
    // The WITH clause is written first, so its value is $1.
    expect(compiled(q, "all", { min: 3 }).params).toEqual([3, 1]);
  });

  test("the options are recursive and materialized, both booleans", () => {
    const base = from(cte("counts", counts), "c");
    expect(compiled(base.withCte("counts", counts, { materialized: true }), "all", { min: 1 }).sql).toMatch(
      /^with "counts" as materialized \(/,
    );
    expect(compiled(base.withCte("counts", counts, {}), "all", { min: 1 }).sql).toMatch(
      /^with "counts" as \(/,
    );
    expect(() => base.withCte("counts", counts, { recursive: "yes" } as never)).toThrow(
      /recursive is true or false/,
    );
    expect(() => base.withCte("counts", counts, { materialized: 1 } as never)).toThrow(
      /materialized is true or false/,
    );
    expect(() => base.withCte("counts", counts, { cycle: true } as never)).toThrow(/no option "cycle"/);
    expect(() => base.withCte("counts", counts, 5 as never)).toThrow(/options as an object/);
  });

  test("refuses an empty or repeated name, a value that is not a query, and queries a CTE cannot hold", () => {
    const base = from(User, "u");
    expect(() => base.withCte("", counts)).toThrow(/a non-empty string/);
    expect(() => base.withCte("c", counts).withCte("c", counts)).toThrow(/already has a CTE named "c"/);
    expect(() => base.withCte("c", "select 1" as never)).toThrow(/withCte\("c", query\) takes a query/);
    expect(() => base.withCte(1 as never, "select 1" as never)).toThrow(
      /withCte\(name, query\) takes a query/,
    );
    expect(() => base.withCte("c", from(User, "x").preload("posts"))).toThrow(/has preloads/);
    expect(() => base.withCte("c", from(Post, "p").set({ views: 0 }))).toThrow(
      /A CTE that writes rows is not supported/,
    );
  });

  test("a CTE that no query defines is refused when compiled", () => {
    expect(() => compiled(from(cte("missing", Category), "m"))).toThrow(/the CTE "missing"/);
  });

  test("withCte may follow a set operation: it applies to the whole statement", () => {
    const q = from(User, "u")
      .select(({ u }) => ({ id: u.id }))
      .union(
        from(
          cte(
            "ids",
            from(Post, "p").select(({ p }) => ({ id: p.authorId })),
          ),
          "i",
        ).select(({ i }) => ({ id: i.id })),
      )
      .withCte(
        "ids",
        from(Post, "p").select(({ p }) => ({ id: p.authorId })),
      );
    expect(compiled(q).sql).toBe(
      'with "ids" as (select "p"."author_id" as "id" from "posts" as "p") select "u"."id" as "c0" from "users" as "u" union (select "i"."id" as "c0" from "ids" as "i")',
    );
  });
});

describe("cte", () => {
  test("typed by a schema, its binding has the schema's columns", () => {
    from(cte("tree", Category), "t").where(({ t: tree }) => {
      expect(tree.parentId.node).toEqual({
        kind: "column",
        binding: "t",
        field: "parentId",
        column: "parent_id",
      });
      return tree.parentId.isNull();
    });
  });

  test("typed by a query, its binding has the query's keys, and the reference brings no parameters", () => {
    const q = from(cte("counts", counts), "c");
    expect(q.ast.from).toEqual({ kind: "cteSource", name: "counts", meta: undefined, alias: "c" });
    expect(q.ast.params).toEqual([]);
  });

  test("refuses what it cannot type", () => {
    expect(() => cte("", Category)).toThrow(/non-empty string/);
    expect(() => cte("x", UserSettings as never)).toThrow(/embedded schema/);
    expect(() => cte("x", 3 as never)).toThrow(/takes the schema class of its rows/);
    expect(() => cte("x", from(Post, "p").select(({ p }) => p.id) as never)).toThrow(/selects one value/);
  });
});
