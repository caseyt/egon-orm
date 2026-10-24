// Step 21 (changeset gaps): validate() behaviours that mutation testing showed no test
// covered, each checked against the mutant it kills.
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../../contracts/schema.js";
import type { StandardSchemaV1, StandardSchemaV1Result } from "../../contracts/standard-schema.js";
import { EmbeddedSchema, hasMany, hasOne, meta, Schema, t } from "../../index.js";
import { type Changeset, cast, change } from "../changeset.js";

type AnyCs = Changeset<AnySchema, boolean>;

function loaded<S extends AnySchema>(
  schema: S,
  values: Readonly<Record<string, unknown>>,
  assocs: Readonly<Record<string, unknown>> = {},
): Row<S> {
  const info = meta(schema);
  const names = Object.keys(assocs);
  const fields = info.persisted.map((field) =>
    Object.hasOwn(values, field.name) ? values[field.name] : null,
  );
  const rowMeta = info.rowMeta("loaded", undefined);
  return (
    names.length === 0
      ? info.create(fields, rowMeta)
      : info.createWith(names)(
          fields,
          names.map((name) => assocs[name]),
          rowMeta,
        )
  ) as Row<S>;
}

function standard(validate: (value: unknown) => StandardSchemaV1Result<unknown>): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "handmade", validate } };
}

class Leaf extends Schema("leaves", {
  id: t.integer().primaryKey(),
  bookId: t.integer().nullable(),
  text: t.string(),
}) {
  static changeset(leaf: Leaf | typeof Leaf, params: unknown) {
    return cast(leaf, params, ["id", "text"]);
  }
}
class Cover extends Schema("covers", { id: t.integer().primaryKey(), bookId: t.integer().nullable() }) {}
class Mark extends EmbeddedSchema({ text: t.string() }) {
  static changeset(mark: Mark | typeof Mark, params: unknown) {
    return cast(mark, params, ["text"]);
  }
}
class Book extends Schema("books", {
  id: t.integer().primaryKey(),
  title: t.string(),
  doneAt: t.timestamp().nullable(),
  tags: t.array(t.string()).nullable(),
  marks: t.embedMany(() => Mark),
}) {
  static leaves = hasMany(() => Leaf, { foreignKey: "bookId", onReplace: "delete" });
  static cover = hasOne(() => Cover, { foreignKey: "bookId", onReplace: "delete" });
}

const leaf = (id: number) => loaded(Leaf, { id, bookId: 7, text: `t${id}` });
const book = (rows: readonly Leaf[] = [], extra: Readonly<Record<string, unknown>> = {}) =>
  loaded(
    Book,
    { id: 7, title: "B", doneAt: null, tags: null, marks: [], ...extra },
    { leaves: rows, cover: null },
  );
const messagesOf = (cs: AnyCs, name: string) =>
  ((cs.changes as Record<string, readonly AnyCs[]>)[name] ?? []).map((item) => item.errorMessages());

describe("routing issues into nested changes", () => {
  test("a child that leaves the relation is skipped when positions are counted", () => {
    const [a, b] = [leaf(1), leaf(2)];
    const cs = change(book([a, b] as Leaf[]))
      .putAssoc("leaves", [change(a as Leaf, { bookId: null }), change(b as Leaf, { text: "u" })] as never)
      .validate(() => [{ path: ["leaves", 0, "text"], message: "is short" }]) as AnyCs;
    expect(messagesOf(cs, "leaves")).toEqual([{}, { text: ["is short"] }]);
  });

  test("an issue reaches an item of an embedded list", () => {
    const cs = cast(book(), { marks: [{ text: "a" }, { text: "b" }] }, [])
      .castEmbed("marks")
      .validate(() => [{ path: ["marks", 1, "text"], message: "is short" }]) as AnyCs;
    expect(messagesOf(cs, "marks")).toEqual([{}, { text: ["is short"] }]);
  });

  test("a position given as text counts from 10 on; a position that is not a number goes to the parent", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ text: `m${i}` }));
    const cs = cast(book(), { marks: items }, [])
      .castEmbed("marks")
      .validate(() => [
        { path: ["marks", "10", "text"], message: "is the eleventh" },
        { path: ["marks", "x"], message: "is not a position" },
      ]) as AnyCs;
    expect(messagesOf(cs, "marks")[10]).toEqual({ text: ["is the eleventh"] });
    expect(messagesOf(cs, "marks")[1]).toEqual({});
    expect(cs.errorMessages()).toMatchObject({ marks: expect.anything() });
  });

  test("an issue on an item of a plain list field stays on the field", () => {
    const cs = cast(book(), { tags: ["a", "b"] }, ["tags"]).validate(() => [
      { path: ["tags", 0], message: "is reserved" },
    ]) as AnyCs;
    expect(cs.errorMessages()).toEqual({ tags: ["is reserved"] });
  });

  test("with only, an issue on a relation that is not listed is dropped", () => {
    const cs = cast(book(), { marks: [{ text: "a" }] }, [])
      .castEmbed("marks")
      .validate(() => [{ path: ["marks", 0, "text"], message: "is short" }], { only: ["title"] }) as AnyCs;
    expect(messagesOf(cs, "marks")).toEqual([{}]);
    expect(cs.valid).toBe(true);
  });

  test("the parent's own error keeps it invalid when every routed issue is dropped by the children", () => {
    const stored = book([leaf(1)]);
    const cs = cast(stored, { title: "" }, ["title"])
      .putAssoc("leaves", [{ id: 1, text: "u" }] as never)
      .validate(
        () => [
          { path: ["title"], message: "is bland" },
          // bookId has no change, so scope "changed" drops this issue inside the child.
          { path: ["leaves", 0, "bookId"], message: "is odd" },
        ],
        { scope: "changed" },
      ) as AnyCs;
    expect(messagesOf(cs, "leaves")).toEqual([{}]);
    expect(cs.valid).toBe(false);
  });

  test("the parent keeps its own error beside the routed ones, and the earlier changeset is left alone", () => {
    const before = cast(book(), { title: "", marks: [{ text: "a" }] }, ["title"]).castEmbed("marks") as AnyCs;
    const listBefore = (before.changes as Record<string, readonly AnyCs[]>).marks;
    const cs = before.validate(() => [
      { path: ["title"], message: "is bland" },
      { path: ["marks", 0, "text"], message: "is short" },
    ]) as AnyCs;
    expect(cs.valid).toBe(false);
    expect((before.changes as Record<string, readonly AnyCs[]>).marks).toBe(listBefore);
    expect(listBefore?.[0]?.valid).toBe(true);
  });
});

describe("what a validator sees", () => {
  test("with only, a listed field without a value is not a key at all", () => {
    const seen: unknown[] = [];
    cast(User, { name: "Lin" }, ["name"]).validate(
      (values) => {
        seen.push(values);
        return [];
      },
      { only: ["email", "name"] },
    );
    expect(Object.keys(seen[0] as object)).toEqual(["name"]);
  });

  test("with only, an association change is left out; a to-one change of null is seen as null", () => {
    const seen: unknown[] = [];
    const record = (values: unknown) => {
      seen.push(values);
      return [];
    };
    const withLeaves = change(book([leaf(1)])).putAssoc("leaves", [{ id: 1, text: "u" }] as never);
    withLeaves.validate(record, { only: ["title"] });
    expect(Object.keys(seen[0] as object)).toEqual(["title"]);
    const stored = loaded(
      Book,
      { id: 7, title: "B", doneAt: null, tags: null, marks: [] },
      {
        leaves: [],
        cover: loaded(Cover, { id: 1, bookId: 7 }),
      },
    );
    change(stored).putAssoc("cover", null).validate(record);
    expect((seen[1] as Record<string, unknown>).cover).toBeNull();
  });
});

describe("apply", () => {
  const output = (value: unknown) => standard(() => ({ value }));

  test("null over a stored date and a date over null are changes; an output key holding undefined is ignored", () => {
    const when = new Date("2026-06-01T00:00:00.000Z");
    const cleared = change(book([], { doneAt: when })).validate(output({ doneAt: null }), {
      apply: true,
    }) as AnyCs;
    expect(cleared.changes).toEqual({ doneAt: null });
    const done = change(book()).validate(output({ doneAt: when.toISOString() }), { apply: true }) as AnyCs;
    expect(done.changes).toEqual({ doneAt: when });
    const skipped = change(book()).validate(output({ title: undefined }), { apply: true }) as AnyCs;
    expect(skipped.valid).toBe(true);
    expect(skipped.changes).toEqual({});
  });

  test("a result with an empty list of issues is a success, and its output is applied", () => {
    const cs = change(book()).validate(
      standard(() => ({ value: { title: "C" }, issues: [] })),
      { apply: true },
    ) as AnyCs;
    expect(cs.valid).toBe(true);
    expect(cs.changes).toEqual({ title: "C" });
    const field = change(book(), { title: "C" }).validateField(
      "title",
      standard(() => ({ value: "C", issues: [] })),
    );
    expect(field.valid).toBe(true);
  });
});

describe("validateField and validateFieldAsync", () => {
  test("a rejected promise from validateField is refused without an unhandled rejection", async () => {
    let unhandled = false;
    const listener = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", listener);
    try {
      const cs = change(book(), { title: "C" });
      expect(() => cs.validateField("title", () => Promise.reject(new Error("late")) as never)).toThrow(
        /returned a Promise/,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("validateFieldAsync skips a null value and records the validator", async () => {
    let calls = 0;
    const validator = async () => {
      calls++;
      return [{ path: [], message: "is wrong" }];
    };
    const cs = (await change(book([], { doneAt: new Date(0) }), { doneAt: null }).validateFieldAsync(
      "doneAt",
      validator,
    )) as AnyCs;
    expect(calls).toBe(0);
    expect(cs.valid).toBe(true);
    expect(cs.validations).toStrictEqual([["doneAt", { schema: validator }]]);
  });
});
