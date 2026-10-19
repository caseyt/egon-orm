import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { Category } from "../../compiler/advanced/advanced-queries.js";
import { cte, from, lit, param, subquery, t, val } from "../../index.js";
import { canonical, compiled } from "./test-helpers.js";

describe("set", () => {
  test("binds plain values with the field's type and redaction", () => {
    const q = from(User, "u").set({ passwordHash: "secret", age: 3 });
    const [hash, age] = q.ast.updates;
    expect(hash?.value).toMatchObject({ kind: "param", value: "secret", redact: true });
    expect(age?.value.kind === "param" ? age.value.type?.name : undefined).toBe("integer");
    expect(hash?.column).toBe("password_hash");
  });

  test("an expression given for a redacted field is redacted", () => {
    const q = from(User, "u").set(() => ({ passwordHash: val("x").as<string>() }));
    const value = q.ast.updates[0]?.value;
    expect(value?.kind === "param" ? value.redact : undefined).toBe(true);
  });

  test("takes the callback's bindings, and keeps parameters canonical across calls", () => {
    const q = from(Post, "p")
      .where(({ p }) => p.authorId.eq(1))
      .set(({ p }) => ({ views: p.views.add(param("step", t.integer())) }))
      .set({ title: "t" })
      .returning(({ p }) => p.id);
    expect(canonical(q)).toBe(true);
    expect(q.namedParams()).toEqual(["step"]);
    expect(compiled(q, "updateAll", { step: 2 })).toEqual({
      sql: 'update "posts" as "p" set "views" = "p"."views" + $1, "title" = $2 where "p"."author_id" = $3 returning "p"."id" as "c0"',
      params: [2, "t", 1],
    });
  });

  test("lists in assignment values are counted", () => {
    const q = from(Post, "p").set(({ p }) => ({ published: p.id.in([1, 2]) }));
    expect(q.ast.listLengths).toEqual([2]);
    expect(canonical(q)).toBe(true);
  });

  test("a field set again takes the later value, in its first position", () => {
    const q = from(Post, "p").set({ title: "a", views: 1 }).set({ title: "b" });
    expect(q.ast.updates.map((node) => node.field)).toEqual(["title", "views"]);
    expect(canonical(q)).toBe(true);
    expect(q.ast.params).toEqual(["b", 1]);
  });

  test("replacing a field whose value held a named parameter the type still requires is refused", () => {
    const q = from(Post, "p").set(() => ({ views: param("v", t.integer().nullable()) }));
    expect(() => q.set({ views: 1 })).toThrow(/would remove the named parameter "v"/);
  });

  test("one named parameter with two types among the assignments and the rest is refused", () => {
    const q = from(Post, "p").where(({ p }) => p.title.eq(param("n", t.string())));
    expect(() => q.set(() => ({ views: param("n", t.integer()) as never }))).toThrow(
      /set\(\): The named parameter "n"/,
    );
  });

  test("checks the fields and values", () => {
    const q = from(Post, "p");
    expect(() => q.set({ nope: 1 } as never)).toThrow(
      /Post has no field "nope"\. Its columns are: id, authorId/,
    );
    expect(() => from(User, "u").set({ password: "x" } as never)).toThrow(
      /no column for the virtual field "password"/,
    );
    expect(() => q.set({ title: undefined } as never)).toThrow(/undefined is not a value/);
    expect(() => q.set({ title: null } as never)).toThrow(/Post\.title is not nullable/);
    expect(() => q.set({ title: lit(null) } as never)).toThrow(/is not nullable/);
    expect(() => q.set({})).toThrow(/no field/);
    expect(() => q.set(3 as never)).toThrow(/an object of field values/);
    expect(() => q.set(() => [1] as never)).toThrow(/an object of field values/);
    expect(q.set({ body: null }).ast.updates[0]?.value).toMatchObject({ kind: "param", value: null });
  });

  test("an update needs a table root and no select, preloads or set operation", () => {
    expect(() => from(cte("tree", Category), "t").set({ name: "x" } as never)).toThrow(
      /is not a schema's table/,
    );
    expect(() => from(subquery(from(Post, "p")), "s").set({ title: "x" } as never)).toThrow(
      /is not a schema's table/,
    );
    expect(() => from(User, "u").preload("posts").set({ age: 1 })).toThrow(/with preloads/);
    expect(() =>
      from(User, "u")
        .select(({ u }) => u.id)
        .set({ age: 1 } as never),
    ).toThrow(/returning\(\)/);
    expect(() => from(User, "u").union(from(User, "v")).set({ age: 1 })).toThrow(/only orderBy/);
  });

  test("select() on an update is refused; returning() is the way", () => {
    const q = from(Post, "p").set({ views: 0 });
    expect(() => q.select(({ p }) => p.id)).toThrow(/Declare what the update returns with returning\(\)/);
    expect(q.returning(({ p }) => p.id).set({ title: "x" }).ast.updates).toHaveLength(2);
  });

  test("returning() is refused on a query that already selects or preloads", () => {
    expect(() =>
      from(Post, "p")
        .select(({ p }) => p.id)
        .returning(({ p }) => p.id),
    ).toThrow(/already has a select/);
    expect(() =>
      from(Post, "p")
        .returning(({ p }) => p.id)
        .returning(({ p }) => p.id),
    ).toThrow(/already has a returning\(\)/);
    expect(() =>
      from(Post, "p")
        .returning(({ p }) => p.id)
        .select(({ p }) => p.id),
    ).toThrow(/already has a returning\(\)/);
    expect(() =>
      from(User, "u")
        .preload("posts")
        .returning(({ u }) => u),
    ).toThrow(/with preloads/);
  });

  test("selectMerge on a returning() list keeps it a returning() list", () => {
    const q = from(Post, "p")
      .returning(({ p }) => ({ id: p.id }))
      .selectMerge(({ p }) => ({ title: p.title }))
      .set({ views: 0 });
    expect(compiled(q, "updateAll").sql).toBe(
      'update "posts" as "p" set "views" = $1 returning "p"."id" as "c0", "p"."title" as "c1"',
    );
  });

  test('exclude("set") makes it a query again', () => {
    const q = from(Post, "p").set({ views: 0 }).exclude("set");
    expect(q.ast.updates).toEqual([]);
    expect(compiled(q).sql).toMatch(/^select /);
  });

  test("an update with assignments cannot run as a select, nor a delete", () => {
    const q = from(Post, "p").set({ views: 0 });
    expect(() => compiled(q)).toThrow(/run it with updateAll/);
    expect(() => compiled(q, "deleteAll")).toThrow(/deleteAll cannot run a query with set/);
  });
});
