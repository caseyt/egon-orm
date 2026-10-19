import { Post, Profile, User, UserSettings } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { QueryError } from "../../errors.js";
import { count, exists, from, max, meta, outerRef, param, scalar, subquery, sum, t, val } from "../../index.js";
import { canonical, compiled } from "./test-helpers.js";

const authorTotals = from(Post, "p")
  .groupBy(({ p }) => p.authorId)
  .select(({ p }) => ({ authorId: p.authorId, total: sum(p.views), hash: max(p.title.lower()) }));

describe("subquery as a source", () => {
  test("the binding of an object source has one column per select key, typed like the value", () => {
    from(subquery(authorTotals), "s").where(({ s }) => {
      expect(s.authorId.type).toBe(meta(Post).fieldsByName.get("authorId")?.type);
      expect(s.total.node).toEqual({ kind: "column", binding: "s", field: "total", column: "total" });
      return s.total.gt(1);
    });
  });

  test("a value compared with a source column takes the column's type", () => {
    const q = from(subquery(authorTotals), "s").where(({ s }) => s.authorId.eq(7));
    const where = q.ast.wheres[0]?.expr;
    expect(where?.kind === "binary" && where.right.kind === "param" ? where.right.type : undefined).toBe(
      meta(Post).fieldsByName.get("authorId")?.type,
    );
  });

  test("the binding of an object source is the same object for the same alias", () => {
    const source = subquery(authorTotals);
    const seen: object[] = [];
    from(source, "s").where(({ s }) => {
      seen.push(s);
      return s.total.gt(1);
    });
    from(source, "s").where(({ s }) => {
      seen.push(s);
      return s.total.gt(1);
    });
    expect(seen[0]).toBe(seen[1]);
  });

  test("selecting an object source whole gives the object of its columns", () => {
    const q = from(subquery(authorTotals), "s").select(({ s }) => s);
    expect(compiled(q).sql).toBe(
      'select "s"."authorId" as "c0", "s"."total" as "c1", "s"."hash" as "c2" from (select "p"."author_id" as "authorId", sum("p"."views") as "total", max(lower("p"."title")) as "hash" from "posts" as "p" group by "p"."author_id") as "s"',
    );
  });

  test("a source over a source with no select of its own reads the inner keys", () => {
    const inner = from(subquery(authorTotals), "s").where(({ s }) => s.total.gt(1));
    const q = from(subquery(inner), "o");
    expect(compiled(q).sql).toBe(
      'select "o"."authorId" as "c0", "o"."total" as "c1", "o"."hash" as "c2" from (select "s"."authorId" as "authorId", "s"."total" as "total", "s"."hash" as "hash" from (select "p"."author_id" as "authorId", sum("p"."views") as "total", max(lower("p"."title")) as "hash" from "posts" as "p" group by "p"."author_id") as "s" where "s"."total" > $1) as "o"',
    );
  });

  test("a source that selects a whole binding exposes that schema's columns", () => {
    const authors = from(Post, "p")
      .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
      .select(({ u }) => u);
    from(subquery(authors), "a").where(({ a }) => {
      expect(a.email.node).toEqual({ kind: "column", binding: "a", field: "email", column: "email" });
      return a.age.gt(1);
    });
  });

  test("parameters of the inner query come first, in canonical order", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.views.gt(10))
      .select(({ p }) => ({ id: p.id }));
    const q = from(subquery(inner), "s").where(({ s }) => s.id.lt(99));
    expect(q.ast.params).toEqual([10, 99]);
    expect(canonical(q)).toBe(true);
    const joined = from(User, "u")
      .where(({ u }) => u.age.gt(1))
      .join(subquery(inner), "s", ({ u, s }) => s.id.eq(u.id));
    expect(joined.ast.params).toEqual([10, 1]);
    expect(canonical(joined)).toBe(true);
  });

  test("named parameters of the inner query are the outer query's", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.views.gt(param("min", t.integer())))
      .select(({ p }) => ({ id: p.id }));
    const q = from(subquery(inner), "s").where(({ s }) => s.id.lt(param("max", t.bigint({ mode: "number" }))));
    expect(q.namedParams()).toEqual(["min", "max"]);
    expect(compiled(q, "all", { min: 1, max: 2 }).params).toEqual([1, 2]);
  });

  test("one named parameter with two types across the subquery and the outer query is refused", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.views.gt(param("n", t.integer())))
      .select(({ p }) => ({ id: p.id }));
    expect(() => from(subquery(inner), "s").where(({ s }) => s.id.eq(param("n", t.string()) as never))).toThrow(
      /"n" is used with two types/,
    );
    expect(() =>
      from(User, "u")
        .where(({ u }) => u.email.eq(param("n", t.string())))
        .join(subquery(inner), "s", ({ u, s }) => s.id.eq(u.id)),
    ).toThrow(/join\(\): The named parameter "n"/);
  });

  test("a value of a redacted column stays redacted through a source", () => {
    const inner = from(User, "u").select(({ u }) => ({ hash: u.passwordHash, lowered: u.passwordHash.lower(), id: u.id }));
    from(subquery(inner), "s").where(({ s }) => {
      expect(s.hash.redact).toBe(true);
      expect(s.lowered.redact).toBe(true);
      expect(s.id.redact).toBe(false);
      return s.id.gt(1);
    });
    const twice = from(subquery(from(subquery(inner), "s").select(({ s }) => ({ hash: s.hash, n: count() }))), "o");
    twice.where(({ o }) => {
      expect(o.hash.redact).toBe(true);
      expect(o.n.redact).toBe(false);
      return o.n.gt(0);
    });
  });

  test("redaction is read through every value-preserving wrapper", () => {
    const inner = from(User, "u")
      .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
      .select(({ u, pr }) => ({
        cast: u.passwordHash.cast(t.string()),
        concat: u.email.concat(u.passwordHash),
        minimum: max(u.passwordHash),
        counted: count(u.passwordHash),
        bio: pr.bio,
        secret: val("x").as<string>(),
      }));
    from(subquery(inner), "s").where(({ s }) => {
      expect([s.cast.redact, s.concat.redact, s.minimum.redact, s.counted.redact, s.bio.redact]).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      return s.bio.isNull();
    });
  });

  test("a query that cannot be read as a source is refused when the source is made", () => {
    expect(() => subquery(from(Post, "p").select(({ p }) => p.id) as never)).toThrow(/selects one value/);
    expect(() => subquery(from(Post, "p").select(({ p }) => [p.id]) as never)).toThrow(/selects an array/);
    expect(() => subquery(from(Post, "p").select(() => "x") as never)).toThrow(/selects a plain value/);
    expect(() => subquery(from(Post, "p").select(({ p }) => ({ a: { b: p.id } })) as never)).toThrow(
      /key "a" holds a nested object or array/,
    );
    expect(() => subquery(from(Post, "p").select(({ p }) => ({ a: p })) as never)).toThrow(/key "a" holds a whole binding/);
    expect(() => subquery(from(Post, "p").select(({ p }) => ({ a: p.id, k: "x" })) as never)).toThrow(
      /key "k" holds a plain value/,
    );
    expect(() => subquery(from(User, "u").preload("posts") as never)).toThrow(/has preloads/);
    expect(() => subquery(from(Post, "p").set({ views: 1 }) as never)).toThrow(/set\(…\) assignments/);
    expect(() => subquery("posts" as never)).toThrow(QueryError);
  });
});

describe("subqueries as expressions", () => {
  test("in, exists and scalar carry the inner query's parameters", () => {
    const inner = from(Post, "p")
      .where(({ p }) => p.views.gt(5))
      .select(({ p }) => p.authorId);
    const q = from(User, "u")
      .where(({ u }) => u.id.in(inner))
      .where(() => exists(inner))
      .select(({ u }) => ({ id: u.id, n: scalar(inner) }));
    expect(q.ast.params).toEqual([5, 5, 5]);
    expect(canonical(q)).toBe(true);
  });

  test("scalar takes a query of one expression and is typed like it", () => {
    const n = scalar(from(Post, "p").select(() => count()));
    expect(n.node.kind).toBe("subquery");
    expect(n.type?.name).toBe("bigint(number)");
    expect(() => scalar(from(Post, "p") as never)).toThrow(/selects whole rows/);
    expect(() => scalar(from(Post, "p").select(({ p }) => p) as never)).toThrow(/a whole binding/);
    expect(() => scalar(from(Post, "p").select(({ p }) => ({ id: p.id })) as never)).toThrow(/an object/);
    expect(() => scalar(42 as never)).toThrow(/takes a query/);
  });

  test("a query with set(…) is not a subquery", () => {
    expect(() => exists(from(Post, "p").set({ views: 1 }))).toThrow(/an update, was used as a subquery/);
  });
});

describe("outerRef", () => {
  test("is the schema's binding under the outer alias", () => {
    const ref = outerRef("u", User);
    expect(ref.id.node).toEqual({ kind: "column", binding: "u", field: "id", column: "id" });
    expect(outerRef("u", User)).toBe(ref);
  });

  test("a column of an outer binding no query has is refused when compiled", () => {
    const orphan = from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("x", User).id));
    expect(() => compiled(orphan)).toThrow(/refers to the binding "x"/);
  });

  test("checks its arguments", () => {
    expect(() => outerRef("", User)).toThrow(/takes the alias/);
    expect(() => outerRef("u", {} as never)).toThrow(/takes the schema class/);
    expect(() => outerRef("u", UserSettings as never)).toThrow(/embedded schema/);
  });
});
