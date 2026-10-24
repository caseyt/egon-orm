// Step 21 (changeset gaps): nested-changeset behaviours that mutation testing showed no test
// covered, each checked against the mutant it kills.

import { Profile, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, FieldMeta, Row } from "../../contracts/schema.js";
import { NotLoadedError } from "../../errors.js";
import { EmbeddedSchema, hasMany, hasOne, meta, Schema, t } from "../../index.js";
import { type Changeset, cast, change, withAction } from "../changeset.js";
import { indexOfRow, keyFinder, leaves, relationOf } from "./relation.js";

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

class Leaf extends Schema("leaves", {
  id: t.integer().primaryKey(),
  bookId: t.integer().nullable(),
  text: t.string(),
}) {
  static changeset(leaf: Leaf | typeof Leaf, params: unknown) {
    return cast(leaf, params, ["id", "text"]).validateRequired(["text"]).validateLength("text", { min: 2 });
  }
}
class Jacket extends Schema("jackets", {
  id: t.integer().primaryKey(),
  bookId: t.integer().nullable(),
  colour: t.string(),
}) {
  static changeset(jacket: Jacket | typeof Jacket, params: unknown) {
    return cast(jacket, params, ["colour"]).validateLength("colour", { min: 3 });
  }
}
class Sleeve extends Schema("sleeves", { id: t.integer().primaryKey(), bookId: t.integer().nullable() }) {}
class Volume extends Schema("volumes", { id: t.integer().primaryKey(), title: t.string() }) {
  static leaves = hasMany(() => Leaf, { foreignKey: "bookId", onReplace: "invalid" });
  static jacket = hasOne(() => Jacket, { foreignKey: "bookId", onReplace: "update" });
  static sleeve = hasOne(() => Sleeve, { foreignKey: "bookId", onReplace: "delete" });
}

const leaf = (id: number, text: string) => loaded(Leaf, { id, bookId: 7, text });
const volume = (leaves: readonly Leaf[], jacket: Jacket | null = null, sleeve: Sleeve | null = null) =>
  loaded(Volume, { id: 7, title: "V" }, { leaves, jacket, sleeve });

describe("validity of the parent", () => {
  test("an invalid single child makes the parent invalid", () => {
    const cs = cast(volume([]), { jacket: { colour: "x" } }, []).castAssoc("jacket");
    expect((cs.changes as Record<string, AnyCs>).jacket?.valid).toBe(false);
    expect(cs.valid).toBe(false);
  });
});

describe("required", () => {
  test("given children, required is met", () => {
    const cs = cast(volume([]), { leaves: [{ id: 1, text: "ab" }] }, []).castAssoc("leaves", {
      required: true,
    });
    expect(cs.valid).toBe(true);
    expect(cs.errors).toEqual({});
  });

  test("an empty list over an empty list is still blank, with the required validation", () => {
    const cs = cast(volume([]), { leaves: [] }, []).castAssoc("leaves", { required: true });
    expect(cs.errors.leaves).toStrictEqual([{ message: "can't be blank", validation: "required", meta: {} }]);
    // With an error on it, the relation keeps its (empty) change, so the error has its value.
    expect(Object.keys(cs.changes)).toEqual(["leaves"]);
  });

  test("a relation keeps both of two errors of its own", () => {
    // onReplace "invalid" leaves out a stored row (one error); required with no children is the other.
    const cs = cast(volume([leaf(1, "ab")]), { leaves: [] }, []).castAssoc("leaves", { required: true });
    expect(cs.errors.leaves).toHaveLength(2);
  });
});

const children = (cs: { readonly changes: object }, name: string): readonly AnyCs[] =>
  (cs.changes as Record<string, readonly AnyCs[]>)[name] ?? [];
const child = (cs: { readonly changes: object }, name: string): AnyCs | undefined =>
  (cs.changes as Record<string, AnyCs | undefined>)[name];

describe("a stored row put back", () => {
  test("as a changeset, it is an update whatever its action, and with no change it changes nothing", () => {
    // putAssoc: "changesets (a new record is inserted, one of a loaded row updated)".
    const stored = volume([leaf(1, "ab")]);
    const same = change(stored).putAssoc("leaves", [withAction(change(leaf(1, "ab")), "delete")] as never);
    expect(same.changes).toEqual({});
    const edited = change(stored).putAssoc("leaves", [
      withAction(change(leaf(1, "ab"), { text: "cd" }), "delete"),
    ] as never);
    expect(children(edited, "leaves").map((item) => item.action)).toEqual(["update"]);
  });

  test("with an error and no change, the parent is invalid", () => {
    const row = leaf(1, "ab");
    const cs = change(volume([row])).putAssoc("leaves", [change(row).addError("text", "is taken")] as never);
    expect(cs.valid).toBe(false);
  });

  test("a row given as a plain object is matched by its key as given, without casting", () => {
    const stored = volume([leaf(1, "ab"), leaf(2, "cd")]);
    const put = change(stored).putAssoc("leaves", [
      { id: 1, text: "ef" },
      { id: 2, text: "gh" },
    ] as never);
    expect(children(put, "leaves").map((item) => [item.action, (item.data as Leaf | null)?.id])).toEqual([
      ["update", 1],
      ["update", 2],
    ]);
    const asText = change(stored).putAssoc("leaves", [{ id: "1", text: "ef" }] as never);
    expect(children(asText, "leaves")[0]?.action).toBe("insert");
  });
});

describe("the same row twice in a cast", () => {
  test("is a duplicate, and does not keep another stored row", () => {
    const stored = volume([leaf(1, "ab"), leaf(2, "cd")]);
    const cs = cast(
      stored,
      {
        leaves: [
          { id: 1, text: "xy" },
          { id: 1, text: "zz" },
        ],
      },
      [],
    ).castAssoc("leaves");
    const validations = (cs.errors.leaves ?? []).map((error) => error.validation);
    expect(validations).toContain("duplicate");
    // Row 2 is left out, and the relation's onReplace is "invalid".
    expect(validations).toContain("replace");
  });
});

describe("a to-one relation", () => {
  test("required is met by a value; a null over no row is still blank and keeps its change", () => {
    const given = cast(volume([]), { jacket: { colour: "red" } }, []).castAssoc("jacket", { required: true });
    expect(given.valid).toBe(true);
    const none = cast(volume([]), { jacket: null }, []).castAssoc("jacket", { required: true });
    expect(none.errors.jacket?.map((error) => error.validation)).toEqual(["required"]);
    expect(Object.keys(none.changes)).toEqual(["jacket"]);
  });

  test("onReplace update with no row there inserts", () => {
    const cs = cast(volume([]), { jacket: { colour: "red" } }, []).castAssoc("jacket");
    expect(child(cs, "jacket")?.action).toBe("insert");
  });

  test("putAssoc(null) on an optional relation is no error", () => {
    const stored = volume([], null, loaded(Sleeve, { id: 3, bookId: 7 }));
    const cs = change(stored).putAssoc("sleeve", null);
    expect(cs.errors).toEqual({});
    expect(cs.valid).toBe(true);
  });
});

class Spot extends EmbeddedSchema({ id: t.integer().primaryKey(), label: t.string() }) {
  static changeset(spot: Spot | typeof Spot, params: unknown) {
    return cast(spot, params, ["id", "label"]);
  }
}
class Plate extends EmbeddedSchema({ label: t.string() }) {}
class Hall extends Schema("halls", {
  id: t.integer().primaryKey(),
  spot: t.embedOne(() => Spot).nullable(),
  plate: t.embedOne(() => Plate).nullable(),
}) {}

describe("a to-one embed and the stored row", () => {
  const stored = () =>
    loaded(Hall, { id: 1, spot: loaded(Spot, { id: 5, label: "a" }), plate: loaded(Plate, { label: "p" }) });

  test("a cast key given as text is cast before it is matched", () => {
    const cs = cast(stored(), { spot: { id: "5", label: "b" } }, []).castEmbed("spot");
    expect(child(cs, "spot")?.action).toBe("update");
  });

  test("a change of a copy with the stored key is that row; without a key, a copy is a replacement", () => {
    const hall = stored();
    const copy = loaded(Spot, { id: 5, label: "a" });
    // onReplace is "error": a replacement would throw.
    expect(() => change(hall).putEmbed("spot", change(copy, { label: "b" }) as never)).not.toThrow();
    const plate = loaded(Plate, { label: "p" });
    expect(() => change(hall).putEmbed("plate", change(plate, { label: "q" }) as never)).toThrow(
      /leaves out/,
    );
  });
});

class Mark extends EmbeddedSchema({
  text: t.string(),
  at: t.timestamp().nullable(),
  tags: t.array(t.string()).nullable(),
  level: t.integer().default(() => 3),
}) {
  static changeset(mark: Mark | typeof Mark, params: unknown) {
    return cast(mark, params, ["text", "at", "tags", "level"]).validateLength("text", { min: 2 });
  }
}
class Log extends Schema("logs", { id: t.integer().primaryKey(), marks: t.embedMany(() => Mark) }) {}

describe("a keyless embedded list compared with the stored one", () => {
  const when = new Date("2026-05-01T00:00:00.000Z");
  const log = (mark: Readonly<Record<string, unknown>>) =>
    loaded(Log, { id: 1, marks: [loaded(Mark, mark)] });
  const recast = (stored: Readonly<Record<string, unknown>>, given: Readonly<Record<string, unknown>>) =>
    Object.keys(cast(log(stored), { marks: [given] }, []).castEmbed("marks").changes);

  test("equal values, null included, are no change; a default given by a function counts", () => {
    expect(recast({ text: "ab", at: null, tags: null, level: 3 }, { text: "ab" })).toEqual([]);
  });

  test("a date replaced by null, null by a date, or a missing required value is a change", () => {
    expect(recast({ text: "ab", at: when, tags: null, level: 3 }, { text: "ab", at: null })).toEqual([
      "marks",
    ]);
    expect(
      recast({ text: "ab", at: null, tags: null, level: 3 }, { text: "ab", at: when.toISOString() }),
    ).toEqual(["marks"]);
    expect(recast({ text: "ab", at: when, tags: null, level: 3 }, { at: when.toISOString() })).toEqual([
      "marks",
    ]);
  });

  test("a missing value of a required date is a change", () => {
    class Stamp extends EmbeddedSchema({ text: t.string(), at: t.timestamp() }) {
      static changeset(stamp: Stamp | typeof Stamp, params: unknown) {
        return cast(stamp, params, ["text", "at"]);
      }
    }
    class Book extends Schema("books", { id: t.integer().primaryKey(), stamps: t.embedMany(() => Stamp) }) {}
    const stored = loaded(Book, { id: 1, stamps: [loaded(Stamp, { text: "ab", at: when })] });
    expect(Object.keys(cast(stored, { stamps: [{ text: "ab" }] }, []).castEmbed("stamps").changes)).toEqual([
      "stamps",
    ]);
  });

  test("an item with a list value is always a change", () => {
    expect(recast({ text: "ab", at: null, tags: ["x"], level: 3 }, { text: "ab", tags: ["x"] })).toEqual([
      "marks",
    ]);
  });

  test("an invalid item equal to the stored one is still a change, and the parent is invalid", () => {
    const cs = cast(
      log({ text: "a", at: null, tags: null, level: 3 }),
      { marks: [{ text: "a" }] },
      [],
    ).castEmbed("marks");
    expect(cs.valid).toBe(false);
  });
});

describe("plain objects with nested relations", () => {
  test("an association key holding undefined is skipped", () => {
    const cs = change(User).putAssoc("posts", [{ title: "t", comments: undefined }] as never);
    expect(Object.keys((children(cs, "posts")[0] as AnyCs).changes)).toEqual(["title"]);
  });

  test("an association of a target without embeds, and of a target with embeds, is put as an association", () => {
    expect(() => change(User).putAssoc("posts", [{ title: "t", comments: [] }] as never)).not.toThrow();
    expect(() => change(Profile).putAssoc("user", { email: "e@x", posts: [] } as never)).not.toThrow();
  });
});

describe("which child changes take a row out of its relation", () => {
  const relation = (owner: AnyCs, name: string, wanted: "assoc" | "embed") =>
    relationOf(owner, name, "putAssoc", wanted);

  test("a delete, or a has-many or has-one child whose foreign key is set to null", () => {
    const owner = change(volume([])) as AnyCs;
    const many = relation(owner, "leaves", "assoc");
    const one = relation(owner, "jacket", "assoc");
    const row = leaf(1, "ab");
    expect(leaves(many, withAction(change(row), "delete") as AnyCs)).toBe(true);
    expect(leaves(many, change(row, { bookId: null }) as AnyCs)).toBe(true);
    expect(leaves(many, change(row, { bookId: 9 }) as AnyCs)).toBe(false);
    expect(leaves(many, change(row, { text: "cd" }) as AnyCs)).toBe(false);
    const jacket = loaded(Jacket, { id: 3, bookId: 7, colour: "red" });
    expect(leaves(one, change(jacket, { bookId: null }) as AnyCs)).toBe(true);
    expect(leaves(one, change(jacket, { colour: "blue" }) as AnyCs)).toBe(false);
  });

  test("never an embedded item or a belongs-to parent that is not deleted", () => {
    const logged = change(loaded(Log, { id: 1, marks: [] })) as AnyCs;
    expect(leaves(relation(logged, "marks", "embed"), change(Mark, { text: "ab" }) as AnyCs)).toBe(false);
    const profile = change(Profile) as AnyCs;
    expect(leaves(relation(profile, "user", "assoc"), change(User, { email: "e@x" }) as AnyCs)).toBe(false);
  });
});

describe("indexOfRow", () => {
  test("without a key, a row is found by identity; a row with no key value is found nowhere", () => {
    const plates = [loaded(Plate, { label: "a" }), loaded(Plate, { label: "a" })];
    expect(indexOfRow(plates, [], plates[1] as object)).toBe(1);
    const rows = [leaf(1, "ab"), leaf(2, "cd")];
    const key = meta(Leaf).primaryKey;
    expect(indexOfRow(rows, key, leaf(2, "zz"))).toBe(1);
    expect(indexOfRow(rows, key, loaded(Leaf, { id: null, bookId: 7, text: "new" }))).toBe(-1);
  });
});

describe("the stored value of a relation", () => {
  test("a to-one embed stored as null holds no row", () => {
    const hall = loaded(Hall, { id: 1, spot: null, plate: null });
    // onReplace is "error": a stored row read from null would be left out and throw.
    const cs = change(hall).putEmbed("spot", { id: 5, label: "a" } as never);
    expect(child(cs, "spot")?.action).toBe("insert");
  });

  test("an association that is not preloaded, or preloaded as plain objects, names itself", () => {
    const bare = loaded(Volume, { id: 7, title: "V" });
    const error = (() => {
      try {
        change(bare).putAssoc("leaves", []);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(NotLoadedError);
    expect(error).toMatchObject({ schema: "Volume", association: "leaves" });
    const plain = loaded(Volume, { id: 7, title: "V" }, { leaves: [{ id: 1, bookId: 7, text: "ab" }] });
    expect(() => change(plain).putAssoc("leaves", [])).toThrow(
      expect.objectContaining({ schema: "Volume", association: "leaves" }),
    );
  });
});

describe("dropping a nested change that changes nothing", () => {
  test("the other changes stay, and no key is left for the relation", () => {
    const stored = volume([leaf(1, "ab")]);
    const first = cast(stored, { title: "W", leaves: [{ id: 1, text: "cd" }] }, ["title"]).castAssoc(
      "leaves",
    );
    expect(Object.keys(first.changes)).toEqual(["title", "leaves"]);
    const again = cast(first, { leaves: [{ id: 1, text: "ab" }] }, []).castAssoc("leaves");
    expect(again.changes).toStrictEqual({ title: "W" });
    expect(Object.keys(again.changes)).toEqual(["title"]);
  });
});

describe("keyFinder over many rows", () => {
  test("a key that two rows share finds the first of them, as a scan does", () => {
    class Tile extends Schema("tiles", { a: t.integer().primaryKey(), b: t.integer().primaryKey() }) {}
    const key = meta(Tile).primaryKey as readonly FieldMeta[];
    const rows = Array.from({ length: 20 }, (_, i) => ({ a: i, b: 1 }));
    rows[15] = { a: 5, b: 1 };
    expect(keyFinder(rows, key)([5, 1])).toBe(5);
  });
});
