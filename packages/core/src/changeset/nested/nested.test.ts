// Unit tests for nested changesets: castAssoc, castEmbed, putAssoc, putEmbed and
// buildAssoc build child changesets with the right actions; rows left out follow
// onReplace; errors stay on the children and are traversed; nothing touches a database.
import { Profile, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, FieldMeta, OnReplace, Row } from "../../contracts/schema.js";
import { NotLoadedError, QueryError } from "../../errors.js";
import {
  belongsTo,
  EmbeddedSchema,
  hasMany,
  hasOne,
  manyToMany,
  meta,
  Schema,
  stateOf,
  t,
  timestamps,
} from "../../index.js";
import { defineType } from "../../types/define.js";
import { type Changeset, cast, change, rebuild, withAction } from "../changeset.js";
import { buildAssoc } from "./build.js";
import { embedChanges, embedValue, missingEmbedded } from "./embed.js";
import { indexOfRow, keyFinder, leaves, relationOf } from "./relation.js";

type AnyCs = Changeset<AnySchema, boolean>;

/** A row as the database would return it, with `assocs` loaded. */
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

/** The nested change of `name`, read untyped (a changeset made from a row alone does not type it). */
function nestedOf(changeset: { readonly changes: object }, name: string): unknown {
  return (changeset.changes as Record<string, unknown>)[name];
}

function list(value: unknown): AnyCs[] {
  return value as AnyCs[];
}

// --- fixtures ------------------------------------------------------------------------

class Page extends Schema("pages", {
  id: t.integer().primaryKey(),
  bookId: t.integer().nullable(),
  text: t.string(),
}) {
  static changeset(page: Page | typeof Page, params: unknown) {
    return cast(page, params, ["text"]).validateRequired(["text"]);
  }
}

/** A book class whose `pages` association has the given onReplace. */
function bookWith(onReplace: OnReplace) {
  return class Book extends Schema("books", { id: t.integer().primaryKey(), title: t.string() }) {
    static pages = hasMany(() => Page, { foreignKey: "bookId", onReplace });
  };
}

class Cover extends Schema("covers", {
  id: t.integer().primaryKey(),
  novelId: t.integer(),
  colour: t.string(),
}) {}

function novelWith(onReplace: OnReplace) {
  return class Novel extends Schema("novels", { id: t.integer().primaryKey(), title: t.string() }) {
    static cover = hasOne(() => Cover, { foreignKey: "novelId", onReplace });
  };
}

class Shelf extends Schema("shelves", { id: t.integer().primaryKey(), room: t.string() }) {}

class Volume extends Schema("volumes", {
  id: t.integer().primaryKey(),
  shelfId: t.integer(),
  spareShelfId: t.integer().nullable(),
}) {
  static shelf = belongsTo(() => Shelf, { foreignKey: "shelfId" });
  static spare = belongsTo(() => Shelf, { foreignKey: "spareShelfId", onReplace: "setNull" });
}

class Genre extends Schema("genres", { id: t.integer().primaryKey(), name: t.string() }) {}

class Entry extends Schema("entries", {
  id: t.integer().primaryKey(),
  catalogueId: t.integer(),
  genreId: t.integer(),
}) {
  static genre = belongsTo(() => Genre, { foreignKey: "genreId" });
}

class Catalogue extends Schema("catalogues", { id: t.integer().primaryKey() }) {
  static genres = manyToMany(() => Genre, {
    joinThrough: "catalogue_genres",
    joinKeys: { owner: "catalogue_id", target: "genre_id" },
    onReplace: "delete",
  });
  static entries = hasMany(() => Entry, { foreignKey: "catalogueId" });
  static through = hasMany(() => Genre, { through: ["entries", "genre"] });
}

class Loose extends Schema("loose", { id: t.integer().primaryKey() }) {
  static pages = hasMany(() => Plain, { foreignKey: "looseId", onReplace: "delete" });
}

class Plain extends Schema("plain", {
  id: t.integer().primaryKey(),
  looseId: t.integer(),
  body: t.string(),
}) {}

class Spot extends EmbeddedSchema({ lat: t.float(), lng: t.float() }) {}

class Venue extends EmbeddedSchema({
  name: t.string(),
  spot: t.embedOne(() => Spot).nullable(),
}) {
  static changeset(venue: Venue | typeof Venue, params: unknown) {
    return cast(venue, params, ["name"]).castEmbed("spot", {
      with: (spot, p) => cast(spot, p, ["lat", "lng"]),
    });
  }
}

class Slot extends EmbeddedSchema({
  id: t.uuid().primaryKey().autogenerate(),
  label: t.string(),
  at: t.timestamp().nullable(),
}) {
  static changeset(slot: Slot | typeof Slot, params: unknown) {
    return cast(slot, params, ["label", "at"]).validateRequired(["label"]);
  }
}

class Tagline extends EmbeddedSchema({ text: t.string() }) {
  static changeset(line: Tagline | typeof Tagline, params: unknown) {
    return cast(line, params, ["text"]);
  }
}

class Event extends Schema("events", {
  id: t.integer().primaryKey(),
  venue: t.embedOne(() => Venue).nullable(),
  reused: t.embedOne(() => Venue, { onReplace: "update" }).nullable(),
  slots: t.embedMany(() => Slot, { onReplace: "delete" }),
  strictSlots: t.embedMany(() => Slot),
  taglines: t.embedMany(() => Tagline),
}) {}

// --- castAssoc: the matching table ------------------------------------------------------

describe("castAssoc on a to-many association", () => {
  const p1 = loaded(Page, { id: 1, bookId: 7, text: "one" });
  const p2 = loaded(Page, { id: 2, bookId: 7, text: "two" });

  /** What castAssoc makes of `items` on a book holding `existing`, as [action, data id, text]. */
  function run(onReplace: OnReplace, existing: readonly object[], items: unknown) {
    const Book = bookWith(onReplace);
    const book = loaded(Book, { id: 7, title: "B" }, { pages: existing });
    const cs = cast(book, { pages: items }, []).castAssoc("pages") as AnyCs;
    const children = list((cs.changes as Record<string, unknown>).pages);
    return {
      cs,
      rows: children.map((child) => [
        child.action,
        (child.data as { id?: number } | null)?.id ?? null,
        (child.changes as Record<string, unknown>).text ?? null,
      ]),
    };
  }

  const cases: readonly {
    readonly name: string;
    readonly items: readonly Record<string, unknown>[];
    readonly existing: readonly object[];
    readonly expected: Partial<Record<OnReplace, unknown>>;
  }[] = [
    {
      name: "an item with the id of an existing child updates it",
      existing: [p1],
      items: [{ id: 1, text: "uno" }],
      expected: { error: [["update", 1, "uno"]], delete: [["update", 1, "uno"]] },
    },
    {
      name: "the id is cast with the key's type",
      existing: [p1],
      items: [{ id: "1", text: "uno" }],
      expected: { error: [["update", 1, "uno"]] },
    },
    {
      name: "an item without an id is a new record",
      existing: [],
      items: [{ text: "new" }],
      expected: { error: [["insert", null, "new"]], invalid: [["insert", null, "new"]] },
    },
    {
      name: "an unknown id is a new record",
      existing: [p1],
      items: [
        { id: 1, text: "uno" },
        { id: 99, text: "stray" },
      ],
      expected: {
        error: [
          ["update", 1, "uno"],
          ["insert", null, "stray"],
        ],
      },
    },
    {
      name: "a left-out child is deleted with delete and deleteIfExists",
      existing: [p1, p2],
      items: [{ id: 2, text: "dos" }],
      expected: {
        delete: [
          ["update", 2, "dos"],
          ["delete", 1, null],
        ],
        deleteIfExists: [
          ["update", 2, "dos"],
          ["delete", 1, null],
        ],
      },
    },
    {
      name: "a left-out child has its foreign key set to null with setNull",
      existing: [p1, p2],
      items: [{ id: 2, text: "dos" }],
      expected: {
        setNull: [
          ["update", 2, "dos"],
          ["update", 1, null],
        ],
      },
    },
  ];

  for (const each of cases) {
    for (const [mode, expected] of Object.entries(each.expected)) {
      test(`${each.name} (onReplace ${mode})`, () => {
        expect(run(mode as OnReplace, each.existing, each.items).rows).toEqual(expected);
      });
    }
  }

  test("setNull puts null on the foreign key of the left-out child", () => {
    const { cs } = run("setNull", [p1, p2], [{ id: 2, text: "two" }]);
    const children = list((cs.changes as Record<string, unknown>).pages);
    expect(children[1]?.changes).toEqual({ bookId: null });
  });

  test("onReplace error throws when a child is left out, and names the fix", () => {
    expect(() => run("error", [p1, p2], [{ id: 1 }])).toThrow(QueryError);
    expect(() => run("error", [p1], [])).toThrow(/onReplace is "error"/);
  });

  test("onReplace invalid adds is invalid on the association and keeps the new items", () => {
    const { cs, rows } = run("invalid", [p1, p2], [{ id: 1, text: "uno" }]);
    expect(cs.valid).toBe(false);
    expect(cs.errors.pages).toEqual([{ message: "is invalid", validation: "replace", meta: {} }]);
    expect(rows).toEqual([["update", 1, "uno"]]);
  });

  test("the same id twice makes the parent invalid, and both items keep their places", () => {
    const { cs, rows } = run(
      "delete",
      [p1],
      [
        { id: 1, text: "a" },
        { id: 1, text: "b" },
      ],
    );
    expect(rows).toEqual([
      ["update", 1, "a"],
      ["insert", null, "b"],
    ]);
    expect(cs.errors.pages).toEqual([{ message: "is invalid", validation: "duplicate", meta: { index: 1 } }]);
    expect(cs.valid).toBe(false);
  });

  test("items that change nothing record no change", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [p1, p2] });
    const cs = cast(book, { pages: [{ id: 1, text: "one" }, { id: 2 }] }, []).castAssoc("pages");
    expect(cs.changes).toEqual({});
    expect(cs.valid).toBe(true);
  });

  test("a different order of the same unchanged children is a change", () => {
    const { cs } = run("delete", [p1, p2], [{ id: 2 }, { id: 1 }]);
    expect(Object.keys(cs.changes)).toEqual(["pages"]);
  });

  test("params that are not a list of objects give is invalid", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [] });
    const notList = cast(book, { pages: { text: "x" } }, []).castAssoc("pages");
    expect(notList.errors.pages).toEqual([
      { message: "is invalid", validation: "cast", meta: { type: "list" } },
    ]);
    const notObjects = cast(book, { pages: ["x"] }, []).castAssoc("pages");
    expect(notObjects.errors.pages).toEqual([
      { message: "is invalid", validation: "cast", meta: { type: "object" } },
    ]);
    expect(notObjects.valid).toBe(false);
  });

  test("a key missing from the params changes nothing; required checks the current rows", () => {
    const Book = bookWith("delete");
    const empty = loaded(Book, { id: 7, title: "B" }, { pages: [] });
    expect(cast(empty, {}, []).castAssoc("pages").changes).toEqual({});
    expect(cast(empty, {}, []).castAssoc("pages", { required: true }).errorMessages()).toEqual({
      pages: ["can't be blank"],
    });
    const full = loaded(Book, { id: 7, title: "B" }, { pages: [p1] });
    expect(cast(full, {}, []).castAssoc("pages", { required: true }).valid).toBe(true);
    expect(cast(full, { pages: [] }, []).castAssoc("pages", { required: true }).errorMessages()).toEqual({
      pages: ["can't be blank"],
    });
  });

  test("a new parent has no children: every item is an insert", () => {
    const Book = bookWith("error");
    const cs = cast(Book, { title: "N", pages: [{ text: "a" }, { id: 4, text: "b" }] }, ["title"]).castAssoc(
      "pages",
    );
    expect(list(cs.changes.pages).map((child) => child.action)).toEqual(["insert", "insert"]);
  });

  test("with gets the row or the class, the item and its position; an invalid child makes the parent invalid", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [p1] });
    const calls: unknown[] = [];
    const cs = cast(book, { pages: [{ id: 1, text: "x" }, { text: "" }] }, []).castAssoc("pages", {
      with: (target, item, index) => {
        calls.push([target === Page ? "class" : (target as Page).id, item, index]);
        return Page.changeset(target, item);
      },
    });
    expect(calls).toEqual([
      [1, { id: 1, text: "x" }, 0],
      ["class", { text: "" }, 1],
    ]);
    expect(cs.valid).toBe(false);
    expect(cs.errors).toEqual({});
    expect(cs.errorMessages()).toEqual({ pages: [{}, { text: ["can't be blank"] }] });
  });

  test("a loaded parent needs the association preloaded as whole rows", () => {
    const Book = bookWith("delete");
    const bare = loaded(Book, { id: 7, title: "B" });
    expect(() => cast(bare, { pages: [] }, []).castAssoc("pages")).toThrow(NotLoadedError);
    const selected = loaded(Book, { id: 7, title: "B" }, { pages: [{ bookId: 7, text: "plain" }] });
    expect(() => cast(selected, { pages: [] }, []).castAssoc("pages")).toThrow(NotLoadedError);
  });

  test("misuse is refused with a QueryError or TypeError", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [] });
    expect(() => change(book).castAssoc("pages")).toThrow(/made with change\(\)/);
    expect(() => cast(book, {}, []).castAssoc("nope" as never)).toThrow(/no association "nope"/);
    expect(() => cast(book, {}, []).castAssoc("pages", { other: 1 } as never)).toThrow(/unknown option/);
    expect(() => cast(book, {}, []).castAssoc("pages", { required: "yes" } as never)).toThrow(/required/);
    expect(() => cast(book, {}, []).castAssoc("pages", { with: 3 } as never)).toThrow(/with must be/);
    expect(() => cast(book, {}, []).castAssoc("pages", 5 as never)).toThrow(/options must be an object/);
    expect(() => cast(book, { pages: [{}] }, []).castAssoc("pages", { with: () => "nope" as never })).toThrow(
      TypeError,
    );
    expect(() =>
      cast(book, { pages: [{}] }, []).castAssoc("pages", { with: () => change(Cover) as never }),
    ).toThrow(/must be of Page/);
    const plain = loaded(Loose, { id: 1 }, { pages: [] });
    expect(() => cast(plain, { pages: [{}] }, []).castAssoc("pages")).toThrow(/no static changeset function/);
    const catalogue = loaded(Catalogue, { id: 1 }, { through: [] });
    expect(() => cast(catalogue, {}, []).castAssoc("through")).toThrow(/has-through/);
    const event = loaded(Event, { id: 1, slots: [], strictSlots: [], taglines: [] });
    expect(() => cast(event, {}, []).castAssoc("venue" as never)).toThrow(/embed field/);
    expect(() => cast({ data: {}, types: { a: t.string() } }, {}, ["a"]).castAssoc("x" as never)).toThrow(
      /without a schema class/,
    );
  });
});

describe("castAssoc on a to-one association", () => {
  const blue = loaded(Cover, { id: 3, novelId: 1, colour: "blue" });

  function run(onReplace: OnReplace, current: object | null, item: unknown) {
    const Novel = novelWith(onReplace);
    const novel = loaded(Novel, { id: 1, title: "N" }, { cover: current });
    return cast(novel, { cover: item }, []).castAssoc("cover", {
      with: (cover, params) => cast(cover, params, ["colour"]),
    }) as AnyCs;
  }

  test("an item with the child's id updates it", () => {
    const cs = run("error", blue, { id: 3, colour: "red" });
    const child = cs.changes.cover as AnyCs;
    expect([child.action, child.data, child.changes]).toEqual(["update", blue, { colour: "red" }]);
  });

  test("an item without the id replaces the child by onReplace", () => {
    expect(() => run("error", blue, { colour: "red" })).toThrow(/onReplace is "error"/);
    const invalid = run("invalid", blue, { colour: "red" });
    expect(invalid.errors.cover).toEqual([{ message: "is invalid", validation: "replace", meta: {} }]);
    for (const mode of ["delete", "deleteIfExists"] as const) {
      const cs = run(mode, blue, { colour: "red" });
      expect((nestedOf(cs, "cover") as AnyCs).action).toBe("insert");
      expect(cs.valid).toBe(true);
    }
    // Cover.novelId is not nullable: setNull is refused here, not when the parent is saved.
    expect(() => run("setNull", blue, { colour: "red" })).toThrow(/Cover\.novelId is not nullable/);
    expect(() => run("setNull", blue, null)).toThrow(/is not nullable/);
  });

  test("onReplace update reuses the child whatever its id", () => {
    const child = run("update", blue, { id: 99, colour: "red" }).changes.cover as AnyCs;
    expect([child.action, child.data]).toEqual(["update", blue]);
  });

  test("null removes the child by onReplace; update refuses it", () => {
    expect(run("delete", blue, null).changes).toEqual({ cover: null });
    expect(() => run("update", blue, null)).toThrow(/cannot remove it/);
    expect(run("delete", null, null).changes).toEqual({});
  });

  test("no child yet: an item is an insert; required asks for a value", () => {
    expect((run("error", null, { colour: "green" }).changes.cover as AnyCs).action).toBe("insert");
    const Novel = novelWith("delete");
    const novel = loaded(Novel, { id: 1, title: "N" }, { cover: null });
    expect(
      cast(novel, { cover: null }, [])
        .castAssoc("cover", { with: (c, p) => cast(c, p, ["colour"]), required: true })
        .errorMessages(),
    ).toEqual({ cover: ["can't be blank"] });
  });

  test("an unchanged child records no change; a value that is not an object is invalid", () => {
    expect(run("error", blue, { id: 3, colour: "blue" }).changes).toEqual({});
    expect(run("error", blue, "red").errors.cover).toEqual([
      { message: "is invalid", validation: "cast", meta: { type: "object" } },
    ]);
  });
});

// --- putAssoc ------------------------------------------------------------------------------

describe("putAssoc", () => {
  const g1 = loaded(Genre, { id: 1, name: "crime" });
  const g2 = loaded(Genre, { id: 2, name: "poetry" });

  test("putting the rows already there is a no-op; a missing one is unlinked by onReplace", () => {
    const catalogue = loaded(Catalogue, { id: 1 }, { genres: [g1, g2] });
    expect(change(catalogue).putAssoc("genres", [g1, g2]).changes).toEqual({});
    const fewer = change(catalogue).putAssoc("genres", [loaded(Genre, { id: 2, name: "poetry" })]);
    const children = list(nestedOf(fewer, "genres"));
    expect(children.map((child) => [child.action, (child.data as Genre).id])).toEqual([
      ["update", 2],
      ["delete", 1],
    ]);
  });

  test("each kind of value becomes the right child", () => {
    const catalogue = loaded(Catalogue, { id: 1 }, { genres: [g1, g2] });
    const cs = change(catalogue).putAssoc("genres", [
      g1,
      change(Genre, { id: 5, name: "drama" }),
      { id: 2, name: "verse" },
      { id: 6, name: "satire" },
    ]);
    expect(
      list(nestedOf(cs, "genres")).map((child) => [
        child.action,
        (child.data as Genre | null)?.id ?? null,
        child.changes,
      ]),
    ).toEqual([
      ["update", 1, {}],
      ["insert", null, { id: 5, name: "drama" }],
      ["update", 2, { name: "verse" }],
      ["insert", null, { id: 6, name: "satire" }],
    ]);
  });

  test("the same row twice, a row of another schema and a value of the wrong kind are refused", () => {
    const catalogue = loaded(Catalogue, { id: 1 }, { genres: [] });
    expect(() => change(catalogue).putAssoc("genres", [g1, g1])).toThrow(/given twice/);
    expect(() =>
      change(catalogue).putAssoc("genres", [loaded(Shelf, { id: 1, room: "a" })] as never),
    ).toThrow(/must be a Genre/);
    expect(() => change(catalogue).putAssoc("genres", [3] as never)).toThrow(/plain object of its fields/);
    expect(() => change(catalogue).putAssoc("genres", g1 as never)).toThrow(
      'query.nestedNotArray: putAssoc("genres"): Catalogue.genres holds a list.',
    );
    expect(() => change(catalogue).putAssoc("genres", undefined as never)).toThrow(/undefined/);
    expect(() => change(catalogue).putAssoc("genres", [{ nope: 1 }] as never)).toThrow(
      /no field or association/,
    );
  });

  test("a plain object may hold the child's own associations", () => {
    const Book = bookWith("delete");
    const cs = change(Book).putAssoc("pages", [{ text: "p" }]);
    expect(list(cs.changes.pages)[0]?.changes).toEqual({ text: "p" });
  });

  test("belongsTo: a row, a new record, and null on a nullable or non-nullable foreign key", () => {
    const shelf = loaded(Shelf, { id: 4, room: "attic" });
    const fresh = change(Volume).putAssoc("shelf", shelf);
    expect((fresh.changes.shelf as AnyCs).action).toBe("update");
    expect((change(Volume).putAssoc("shelf", { room: "cellar" }).changes.shelf as AnyCs).action).toBe(
      "insert",
    );
    expect(change(Volume).putAssoc("shelf", null).errorMessages()).toEqual({ shelf: ["can't be blank"] });
    expect(change(Volume).putAssoc("spare", null).valid).toBe(true);
    const volume = loaded(Volume, { id: 1, shelfId: 4 }, { shelf });
    expect(change(volume).putAssoc("shelf", shelf).changes).toEqual({});
    expect(() => change(volume).putAssoc("shelf", loaded(Shelf, { id: 5, room: "x" }))).toThrow(/onReplace/);
  });

  test("onReplace update with a plain object updates the row there", () => {
    const Novel = novelWith("update");
    const blue = loaded(Cover, { id: 3, novelId: 1, colour: "blue" });
    const novel = loaded(Novel, { id: 1, title: "N" }, { cover: blue });
    const child = nestedOf(change(novel).putAssoc("cover", { colour: "red" }), "cover") as AnyCs;
    expect([child.action, child.data, child.changes]).toEqual(["update", blue, { colour: "red" }]);
  });
});

// --- buildAssoc -----------------------------------------------------------------------------

describe("buildAssoc", () => {
  test("makes a new child with the foreign key set from the parent", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" });
    const cs = buildAssoc(Book, book, "pages", { text: "hi" });
    expect([cs.data, cs.changes]).toEqual([null, { bookId: 7, text: "hi" }]);
    expect(buildAssoc(Book, book, "pages").changes).toEqual({ bookId: 7 });
  });

  test("refuses other kinds, other rows, and a parent without a key", () => {
    const Book = bookWith("delete");
    expect(() => buildAssoc(Volume, loaded(Volume, { id: 1, shelfId: 1 }), "shelf")).toThrow(/belongsTo/);
    expect(() => buildAssoc(Catalogue, loaded(Catalogue, { id: 1 }), "genres")).toThrow(/manyToMany/);
    expect(() => buildAssoc(Catalogue, loaded(Catalogue, { id: 1 }), "through")).toThrow(/has-through/);
    expect(() => buildAssoc(Book, loaded(Shelf, { id: 1, room: "r" }) as never, "pages")).toThrow(
      /must be a Book/,
    );
    expect(() => buildAssoc(Book, loaded(Book, { title: "no key" }), "pages")).toThrow(/no value for id/);
    expect(() => buildAssoc(Book, loaded(Book, { id: 1, title: "t" }), "nope" as never)).toThrow(
      /no association/,
    );
    expect(() =>
      buildAssoc({} as never, loaded(Book, { id: 1, title: "t" }) as never, "pages" as never),
    ).toThrow(/schema class first/);
  });
});

// --- embeds ---------------------------------------------------------------------------------

describe("castEmbed and putEmbed", () => {
  test("an embedded row is cast with the embed's changeset, nested embeds too", () => {
    const cs = cast(Event, { venue: { name: "Hall", spot: { lat: "59.9", lng: 10.7 } } }, []).castEmbed(
      "venue",
    );
    const venue = cs.changes.venue as AnyCs;
    expect(venue.action).toBe("insert");
    expect((venue.changes as Record<string, unknown>).spot).toBeInstanceOf(Object);
    const row = embedValue(cs.changes.venue, "built") as Venue;
    expect(row).toBeInstanceOf(Venue);
    expect(row.spot).toBeInstanceOf(Spot);
    expect(row.spot).toMatchObject({ lat: 59.9, lng: 10.7 });
  });

  test("a keyed list is matched by id; a left-out item is dropped with delete", () => {
    const morning = loaded(Slot, { id: "11111111-1111-4111-8111-111111111111", label: "morning", at: null });
    const evening = loaded(Slot, { id: "22222222-2222-4222-8222-222222222222", label: "evening", at: null });
    const event = loaded(Event, {
      id: 1,
      venue: null,
      slots: [morning, evening],
      strictSlots: [],
      taglines: [],
    });
    const cs = cast(event, { slots: [{ id: morning.id, label: "dawn" }, { label: "noon" }] }, []).castEmbed(
      "slots",
    );
    expect(list(cs.changes.slots).map((child) => child.action)).toEqual(["update", "insert", "delete"]);
    const rows = embedValue(cs.changes.slots, "built") as Slot[];
    expect(rows.map((slot) => slot.label)).toEqual(["dawn", "noon"]);
    expect(rows[0]?.id).toBe(morning.id);
    expect(rows[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => cast(event, { strictSlots: [] }, []).castEmbed("strictSlots")).not.toThrow();
    const strict = loaded(Event, { id: 1, venue: null, slots: [], strictSlots: [morning], taglines: [] });
    expect(() => cast(strict, { strictSlots: [] }, []).castEmbed("strictSlots")).toThrow(
      /onReplace is "error"/,
    );
  });

  test("a keyless list is replaced whole, and equal items record no change", () => {
    const line = loaded(Tagline, { text: "fresh" });
    const event = loaded(Event, { id: 1, venue: null, slots: [], strictSlots: [], taglines: [line] });
    expect(cast(event, { taglines: [{ text: "fresh" }] }, []).castEmbed("taglines").changes).toEqual({});
    const cs = cast(event, { taglines: [{ text: "new" }] }, []).castEmbed("taglines");
    expect((embedValue(cs.changes.taglines, "built") as Tagline[]).map((each) => each.text)).toEqual(["new"]);
  });

  test("onReplace update on an embedOne keeps the row and applies the changes", () => {
    const hall = loaded(Venue, { name: "Hall", spot: null });
    const event = loaded(Event, {
      id: 1,
      venue: null,
      reused: hall,
      slots: [],
      strictSlots: [],
      taglines: [],
    });
    const cs = cast(event, { reused: { name: "Arena" } }, []).castEmbed("reused");
    expect((nestedOf(cs, "reused") as AnyCs).action).toBe("update");
    expect(cs.getField("reused")).toMatchObject({ name: "Arena", spot: null });
    expect(cast(event, { reused: null }, []).castEmbed("reused").changes).toEqual({ reused: null });
    expect(() => cast(event, { venue: { name: "x" } }, []).castEmbed("reused" as never)).not.toThrow();
  });

  test("putEmbed takes plain objects, rows and changesets", () => {
    const cs = change(Event).putEmbed("slots", [
      { label: "a" },
      loaded(Slot, { id: "33333333-3333-4333-8333-333333333333", label: "b", at: null }),
      change(Slot, { label: "c" }),
    ]);
    expect(list(cs.changes.slots).map((child) => child.action)).toEqual(["insert", "update", "insert"]);
    expect(() => change(Event).putEmbed("id" as never, 1 as never)).toThrow(/not an embed field/);
    expect(() => change(Event).putEmbed("nope" as never, 1 as never)).toThrow(/no field "nope"/);
  });

  test("applyChanges and getField give embedded rows, never changesets", () => {
    const event = loaded(Event, { id: 1, venue: null, slots: [], strictSlots: [], taglines: [] });
    const cs = change(event).putEmbed("venue", { name: "Club" });
    expect(cs.applyChanges().venue).toBeInstanceOf(Venue);
    expect(cs.getField("venue")).toBeInstanceOf(Venue);
    expect(cs.fetchField("venue")?.value).toBeInstanceOf(Venue);
    expect(cs.getChange("venue")).toBe(cs.changes.venue);
  });

  test("missingEmbedded marks new items without a required value, at any depth", () => {
    const cs = change(Event).putEmbed("venue", { spot: { lat: 1 } } as never);
    const checked = missingEmbedded(cs as AnyCs);
    expect(checked?.errorMessages()).toEqual({
      venue: { name: ["can't be blank"], spot: { lng: ["can't be blank"] } },
    });
    expect(missingEmbedded(change(Event).putEmbed("venue", { name: "ok" }) as AnyCs)).toBeUndefined();
    const listed = change(Event).putEmbed("slots", [{ label: "fine" }, {} as never]);
    expect(missingEmbedded(listed as AnyCs)?.errorMessages()).toEqual({
      slots: [{}, { label: ["can't be blank"] }],
    });
  });

  test("embedChanges turns embed changes into rows and leaves other changes alone", () => {
    const cs = change(Event, { id: 2 }).putEmbed("venue", { name: "Club" });
    const changes = embedChanges(cs as AnyCs, "loaded");
    expect(changes.id).toBe(2);
    expect(changes.venue).toBeInstanceOf(Venue);
    const plain = change(Event, { id: 2 }) as AnyCs;
    expect(embedChanges(plain, "loaded")).toBe(plain.changes);
  });
});

// --- errors and validators ------------------------------------------------------------------

describe("nested errors and validators", () => {
  test("a parent's own error on a key with failing children is kept beside them", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [] });
    const cs = cast(book, { pages: [{ text: "" }] }, [])
      .castAssoc("pages")
      .addError("pages", "is too short");
    expect(cs.errorMessages()).toEqual({
      pages: { $errors: ["is too short"], $items: [{ text: ["can't be blank"] }] },
    });
  });

  test("issues of a validator whose path leads into a child land on that child", () => {
    const Book = bookWith("delete");
    const book = loaded(
      Book,
      { id: 7, title: "B" },
      { pages: [loaded(Page, { id: 1, bookId: 7, text: "x" })] },
    );
    const seen: unknown[] = [];
    const cs = cast(book, { pages: [{ id: 1, text: "one" }, { text: "two" }] }, [])
      .castAssoc("pages")
      .validate((values) => {
        seen.push(values);
        return [
          { path: ["pages", 1, "text"], message: "is too plain" },
          { path: ["pages", "0"], message: "needs a picture" },
          { path: ["pages", 5, "text"], message: "is lost" },
          { path: ["title"], message: "is bland" },
        ];
      });
    expect(seen).toEqual([
      {
        id: 7,
        title: "B",
        pages: [
          { id: 1, bookId: 7, text: "one" },
          { bookId: null, text: "two" },
        ],
      },
    ]);
    expect(cs.errorMessages()).toEqual({
      title: ["is bland"],
      $base: ["is lost"],
      pages: [{ $base: ["needs a picture"] }, { text: ["is too plain"] }],
    });
  });

  test("routing skips children that leave the relation, and reaches embeds and nested embeds", () => {
    const Book = bookWith("delete");
    const p1 = loaded(Page, { id: 1, bookId: 7, text: "x" });
    const p2 = loaded(Page, { id: 2, bookId: 7, text: "y" });
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [p1, p2] });
    const cs = cast(book, { pages: [{ id: 2 }] }, [])
      .castAssoc("pages")
      .validate(() => [{ path: ["pages", 0, "text"], message: "is short" }]);
    expect(list(nestedOf(cs, "pages")).map((child) => child.errorMessages())).toEqual([
      { text: ["is short"] },
      {},
    ]);

    const event = cast(Event, { venue: { name: "Hall", spot: { lat: 1, lng: 2 } } }, [])
      .castEmbed("venue")
      .validate(() => [{ path: ["venue", "spot", "lat"], message: "is off the map" }]);
    expect(event.errorMessages()).toEqual({ venue: { spot: { lat: ["is off the map"] } } });
  });

  test("scope changed applies inside the children too", () => {
    const Book = bookWith("delete");
    const book = loaded(
      Book,
      { id: 7, title: "B" },
      { pages: [loaded(Page, { id: 1, bookId: 7, text: "x" })] },
    );
    const cs = cast(book, { pages: [{ id: 1, text: "new" }] }, [])
      .castAssoc("pages")
      .validate(
        () => [
          { path: ["pages", 0, "text"], message: "kept" },
          { path: ["pages", 0, "bookId"], message: "dropped" },
        ],
        { scope: "changed" },
      );
    expect(cs.errorMessages()).toEqual({ pages: [{ text: ["kept"] }] });
  });

  test("a routed issue on a child field that already has an error is dropped; the child's other fields keep theirs", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [] });
    const cs = cast(book, { pages: [{ text: "" }, { text: "fine" }] }, [])
      .castAssoc("pages")
      .validate(() => [
        { path: ["pages", 0, "text"], message: "is dropped" },
        { path: ["pages", 0, "bookId"], message: "is kept" },
        { path: ["pages", 1, "text"], message: "is kept too" },
      ]);
    expect(cs.errorMessages()).toEqual({
      pages: [{ text: ["can't be blank"], bookId: ["is kept"] }, { text: ["is kept too"] }],
    });

    const event = cast(Event, { venue: { name: "", spot: { lat: "north", lng: 2 } } }, [])
      .castEmbed("venue")
      .validate(() => [
        { path: ["venue", "name"], message: "is dropped" },
        { path: ["venue", "spot", "lat"], message: "is dropped" },
        { path: ["venue", "spot", "lng"], message: "is kept" },
      ]);
    expect(event.errorMessages()).toEqual({
      venue: { name: ["can't be blank"], spot: { lat: ["is invalid"], lng: ["is kept"] } },
    });
  });

  test("an issue on a nested key itself is dropped when the key already has an error", () => {
    const venue = cast(Event, { venue: { name: "Hall" } }, [])
      .castEmbed("venue")
      .addError("venue", "is closed");
    const cs = venue.validate(() => [
      { path: ["venue"], message: "is dropped" },
      { path: ["venue", "name"], message: "is kept" },
    ]);
    expect(cs.errorMessages()).toEqual({ venue: { name: ["is kept"], $errors: ["is closed"] } });
    // Without an error on the key, the issue goes to the child's BASE.
    const open = cast(Event, { venue: { name: "Hall" } }, [])
      .castEmbed("venue")
      .validate(() => [{ path: ["venue"], message: "is kept" }]);
    expect(open.errorMessages()).toEqual({ venue: { $base: ["is kept"] } });

    const Novel = novelWith("delete");
    const novel = loaded(Novel, { id: 1, title: "N" }, { cover: null });
    const covered = cast(novel, { cover: { colour: "red" } }, [])
      .castAssoc("cover", { with: (c, p) => cast(c, p, ["colour"]) })
      .addError("cover", "is missing")
      .validate(() => [{ path: ["cover"], message: "is dropped" }]);
    expect(covered.errorMessages()).toEqual({ cover: ["is missing"] });
  });

  test("a nested change replaced by a valid one leaves the parent valid", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [] });
    const bad = cast(book, { pages: [{ text: "" }] }, []).castAssoc("pages");
    expect(bad.valid).toBe(false);
    const again = rebuild(bad, { changes: {} });
    expect(cast(again, { pages: [{ text: "ok" }] }, []).castAssoc("pages").valid).toBe(true);
    expect(change(book).putAssoc("pages", [{ text: "ok" }]).valid).toBe(true);
  });
});

// --- more embed and relation paths ------------------------------------------------------

class Stamp extends EmbeddedSchema({
  id: t.uuid().primaryKey().autogenerate(),
  note: t.string(),
  memo: t.string().virtual(),
  touchedAt: t.timestamp().autogenerate(() => new Date("2026-01-01T00:00:00.000Z")),
  seenAt: t.timestamp().nullable(),
}) {}

class Ledger extends Schema("ledgers", {
  id: t.integer().primaryKey(),
  stamps: t.embedMany(() => Stamp, { onReplace: "delete" }),
}) {}

describe("embedded rows", () => {
  test("a new item gets generated values; an updated one regenerates only what is generated on every write", () => {
    const fresh = change(Ledger).putEmbed("stamps", [{ note: "a", memo: "virtual" }]);
    const [row] = embedValue(fresh.changes.stamps, "built") as Stamp[];
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.memo).toBe("virtual");
    expect(row?.touchedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    const stored = loaded(Stamp, {
      id: "44444444-4444-4444-8444-444444444444",
      note: "n",
      touchedAt: new Date(0),
      seenAt: null,
    });
    const ledger = loaded(Ledger, { id: 1, stamps: [stored] });
    const unchanged = change(ledger).putEmbed("stamps", [change(stored)]);
    expect(unchanged.changes).toEqual({});
    const edited = change(ledger).putEmbed("stamps", [change(stored, { note: "m" })]);
    const [again] = embedValue(edited.changes.stamps, "built") as Stamp[];
    expect(again?.note).toBe("m");
    expect(again?.touchedAt).toEqual(new Date(0));
  });

  test("embedValue keeps values that are not changesets, and drops deleted items", () => {
    expect(embedValue(null, "built")).toBeNull();
    expect(embedValue([1, 2], "built")).toEqual([1, 2]);
    const stored = loaded(Stamp, {
      id: "55555555-5555-4555-8555-555555555555",
      note: "n",
      touchedAt: new Date(0),
    });
    const ledger = loaded(Ledger, { id: 1, stamps: [stored] });
    const cs = change(ledger).putEmbed("stamps", [{ note: "new" }]);
    expect((embedValue(cs.changes.stamps, "built") as Stamp[]).map((each) => each.note)).toEqual(["new"]);
    expect(embedValue([stored, cs.changes.stamps?.[0]], "built")).toHaveLength(2);
  });

  test("a schemaless changeset can hold an embed", () => {
    const cs = cast(
      { data: {}, types: { pin: t.embedOne(() => Spot).nullable() } },
      { pin: { lat: 1, lng: 2 } },
      [],
    ).castEmbed("pin", { with: (spot, params) => cast(spot, params, ["lat", "lng"]) });
    expect(cs.applyChanges().pin).toBeInstanceOf(Spot);
    expect(() => cast({ data: {}, types: { a: t.string() } }, {}, []).castEmbed("a" as never)).toThrow(
      /not an embed field/,
    );
  });

  test("names that are not an association or an embed get a message that says what they are", () => {
    const event = loaded(Event, { id: 1, venue: null, slots: [], strictSlots: [], taglines: [] });
    expect(() => change(event).putEmbed(5 as never, null as never)).toThrow(/name as a string/);
    const book = loaded(bookWith("delete"), { id: 1, title: "t" }, { pages: [] });
    expect(() => change(book).putEmbed("pages" as never, [] as never)).toThrow(
      /is an association of Book, not an embed/,
    );
    expect(() => change(book).putAssoc("title" as never, [] as never)).toThrow(/no association "title"/);
    expect(() => change(loaded(Shelf, { id: 1, room: "r" })).putAssoc("x" as never, null as never)).toThrow(
      /It has none/,
    );
  });
});

// --- review round 1 ----------------------------------------------------------------------

describe("review round 1: changesets", () => {
  test("setNull on a to-many association with a key that cannot be null is refused at cast", () => {
    class Holder extends Schema("holders", { id: t.integer().primaryKey() }) {
      static plain = hasMany(() => Plain, { foreignKey: "looseId", onReplace: "setNull" });
    }
    const holder = loaded(Holder, { id: 1 }, { plain: [loaded(Plain, { id: 2, looseId: 1, body: "b" })] });
    expect(() => change(holder).putAssoc("plain", [])).toThrow(/Plain\.looseId is not nullable/);
  });

  test("a parent whose routed issues were all dropped by its children stays valid", () => {
    const Book = bookWith("delete");
    const page = loaded(Page, { id: 1, bookId: 7, text: "same" });
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [page] });
    const cs = cast(book, { title: "v2", pages: [{ id: 1, text: "same" }, { text: "new" }] }, ["title"])
      .castAssoc("pages")
      .validate(() => [{ path: ["pages", 0, "text"], message: "is dropped" }], { scope: "changed" });
    expect(cs.errorMessages()).toEqual({});
    expect(cs.valid).toBe(true);
    const kept = cast(book, { pages: [{ id: 1, text: "other" }] }, [])
      .castAssoc("pages")
      .validate(() => [{ path: ["pages", 0, "text"], message: "is kept" }], { scope: "changed" });
    expect(kept.valid).toBe(false);
  });

  test("buildAssoc refuses values that give the foreign key another value", () => {
    const Book = bookWith("delete");
    const book = loaded(Book, { id: 7, title: "B" });
    expect(() => buildAssoc(Book, book, "pages", { bookId: 8, text: "x" })).toThrow(/sets bookId/);
    expect(buildAssoc(Book, book, "pages", { bookId: 7, text: "x" }).changes).toEqual({
      bookId: 7,
      text: "x",
    });
  });

  test("an updated embedded item regenerates what is generated on every write, keeps what is generated once", () => {
    class Entry extends EmbeddedSchema({ note: t.string(), ...timestamps() }) {}
    class Journal extends Schema("journals", {
      id: t.integer().primaryKey(),
      entries: t.embedMany(() => Entry),
    }) {}
    const old = new Date("2020-01-01T00:00:00.000Z");
    const entry = loaded(Entry, { note: "a", createdAt: old, updatedAt: old });
    const journal = loaded(Journal, { id: 1, entries: [entry] });
    const cs = change(journal).putEmbed("entries", [change(entry, { note: "b" })]);
    const [row] = embedValue(cs.changes.entries, "built") as Entry[];
    expect(row?.createdAt).toEqual(old);
    expect(row?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    const fresh = embedValue(
      change(Journal).putEmbed("entries", [{ note: "n" }]).changes.entries,
      "built",
    ) as Entry[];
    expect(fresh[0]?.createdAt.getTime()).toBe(fresh[0]?.updatedAt.getTime());
  });
});

describe("review round 1: more branches", () => {
  test("casting an association again with nothing changed removes the earlier change", () => {
    const Book = bookWith("delete");
    const page = loaded(Page, { id: 1, bookId: 7, text: "one" });
    const book = loaded(Book, { id: 7, title: "B" }, { pages: [page] });
    const first = cast(book, { pages: [{ id: 1, text: "two" }] }, []).castAssoc("pages");
    expect(Object.keys(first.changes)).toEqual(["pages"]);
    const again = cast(first, { pages: [{ id: 1, text: "one" }] }, []).castAssoc("pages");
    expect(again.changes).toEqual({});
  });

  test("a keyless embedded item is compared with the stored one using the fields' defaults", () => {
    class Line extends EmbeddedSchema({ text: t.string(), size: t.integer().default(1) }) {
      static changeset(line: Line | typeof Line, params: unknown) {
        return cast(line, params, ["text", "size"]);
      }
    }
    class Poster extends Schema("posters", {
      id: t.integer().primaryKey(),
      lines: t.embedMany(() => Line),
    }) {}
    const poster = loaded(Poster, { id: 1, lines: [loaded(Line, { text: "a", size: 1 })] });
    expect(cast(poster, { lines: [{ text: "a" }] }, []).castEmbed("lines").changes).toEqual({});
    expect(
      Object.keys(cast(poster, { lines: [{ text: "a", size: 2 }] }, []).castEmbed("lines").changes),
    ).toEqual(["lines"]);
  });
});

describe("new embedded rows: defaults, shared timestamps, stored nulls", () => {
  test("a new row takes each field's default, given as a value or as a function, and none is missing", () => {
    class Badge extends EmbeddedSchema({
      label: t.string().default("new"),
      level: t.integer().default(() => 3),
    }) {}
    class Member extends Schema("members", {
      id: t.integer().primaryKey(),
      badge: t.embedOne(() => Badge).nullable(),
    }) {}
    const cs = change(Member).putEmbed("badge", {} as never);
    const row = embedValue(cs.changes.badge, "built") as Badge;
    expect([row.label, row.level]).toEqual(["new", 3]);
    expect(missingEmbedded(cs as AnyCs)).toBeUndefined();
  });

  test("the timestamps of one new row are one value, even when the clock moves between them", () => {
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
    class Note extends EmbeddedSchema({
      text: t.string(),
      createdAt: t.timestamp().autogenerate(clock),
      updatedAt: t.timestamp().autogenerate(clock),
    }) {}
    class Board extends Schema("boards", {
      id: t.integer().primaryKey(),
      notes: t.embedMany(() => Note),
    }) {}
    const built = embedValue(change(Board).putEmbed("notes", [{ text: "n" }]).changes.notes, "built");
    const [row] = built as Note[];
    expect(row?.createdAt.getTime()).toBe(row?.updatedAt.getTime());
  });

  test("an empty string is no key: the item is a new row, even beside a stored row keyed by it", () => {
    class Code extends EmbeddedSchema({ code: t.string().primaryKey(), label: t.string() }) {}
    class Catalog extends Schema("catalogs", {
      id: t.integer().primaryKey(),
      codes: t.embedMany(() => Code, { onReplace: "delete" }),
    }) {}
    const stored = loaded(Code, { code: "", label: "a" });
    const catalog = loaded(Catalog, { id: 1, codes: [stored] });
    const put = change(catalog).putEmbed("codes", [{ code: "", label: "b" }] as never);
    const items = put.changes.codes as unknown as readonly AnyCs[];
    const matched = items.filter((item) => item.data === stored);
    expect(matched.map((item) => item.action)).toEqual(["delete"]);
    expect(items.filter((item) => item.data === null)).toHaveLength(1);
  });

  test("a keyless embedded item equal to the stored one is unchanged, even when its values are new objects", () => {
    class Mark extends EmbeddedSchema({ at: t.timestamp(), note: t.string() }) {
      static changeset(mark: Mark | typeof Mark, params: unknown) {
        return cast(mark, params, ["at", "note"]);
      }
    }
    class Diary extends Schema("diaries", { id: t.integer().primaryKey(), marks: t.embedMany(() => Mark) }) {}
    const when = new Date("2026-03-01T10:00:00.000Z");
    const diary = loaded(Diary, { id: 1, marks: [loaded(Mark, { at: when, note: "a" })] });
    const again = cast(diary, { marks: [{ at: "2026-03-01T10:00:00.000Z", note: "a" }] }, []).castEmbed(
      "marks",
    );
    expect(again.changes).toEqual({});
  });

  test("a change of the stored keyless embed is that row, not a replacement of it", () => {
    const venue = loaded(Venue, { name: "Old", spot: null });
    const event = loaded(Event, { id: 1, venue, slots: [], strictSlots: [], taglines: [] });
    // venue's onReplace is "error": a replacement would throw.
    expect(() => change(event).putEmbed("venue", change(venue, { name: "New" }) as never)).not.toThrow();
  });

  test("a keyed embedOne cast with another key is a new row, not an update of the stored one", () => {
    class Seat extends EmbeddedSchema({ id: t.uuid().primaryKey(), label: t.string() }) {
      static changeset(seat: Seat | typeof Seat, params: unknown) {
        return cast(seat, params, ["id", "label"]);
      }
    }
    class Hall extends Schema("halls", {
      id: t.integer().primaryKey(),
      seat: t.embedOne(() => Seat, { onReplace: "delete" }).nullable(),
    }) {}
    const stored = loaded(Seat, { id: "00000000-0000-4000-8000-000000000001", label: "a" });
    const hall = loaded(Hall, { id: 1, seat: stored });
    const other = "00000000-0000-4000-8000-000000000002";
    const cs = cast(hall, { seat: { id: other, label: "b" } }, []).castEmbed("seat");
    const child = cs.changes.seat as unknown as AnyCs;
    expect([child.action, child.data]).toEqual(["insert", null]);
    const same = cast(hall, { seat: { id: stored.id, label: "b" } }, []).castEmbed("seat");
    expect((same.changes.seat as unknown as AnyCs).data).toBe(stored);
  });

  test("a new child changeset put into a list matches no stored row", () => {
    const rows = [1, 2].map((n) =>
      loaded(Slot, { id: `00000000-0000-4000-8000-00000000000${n}`, label: `s${n}`, at: null }),
    );
    const event = loaded(Event, { id: 1, venue: null, slots: rows, strictSlots: [], taglines: [] });
    const fresh = change(Slot, { label: "new" });
    const put = change(event).putEmbed("slots", [fresh] as never);
    const actions = (put.changes.slots as unknown as readonly AnyCs[]).map((item) => item.action);
    expect(actions.filter((action) => action === "delete")).toHaveLength(2);
    expect(actions.filter((action) => action === "insert")).toHaveLength(1);
  });

  test("a stored row that holds null in a required field is reported when it changes", () => {
    const slot = loaded(Slot, { id: "00000000-0000-4000-8000-000000000001", label: null, at: null });
    const event = loaded(Event, { id: 1, venue: null, slots: [slot], strictSlots: [], taglines: [] });
    const cs = change(event).putEmbed("slots", [change(slot, { at: new Date(0) })] as never);
    expect(missingEmbedded(cs as AnyCs)?.errorMessages()).toEqual({ slots: [{ label: ["can't be blank"] }] });
  });
});

/** The parts of a changeset these tests read, untyped. */
interface AnyCsLike {
  readonly changes: Readonly<Record<string, unknown>>;
  readonly errors: Readonly<Record<string, unknown>>;
  readonly valid: boolean;
  readonly action: string | null;
}

describe("nested changes: validity, required, stored rows, keys and leaving rows", () => {
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
      expect(cs.errors.leaves).toStrictEqual([
        { message: "can't be blank", validation: "required", meta: {} },
      ]);
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
      const cs = change(volume([row])).putAssoc("leaves", [
        change(row).addError("text", "is taken"),
      ] as never);
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
      const given = cast(volume([]), { jacket: { colour: "red" } }, []).castAssoc("jacket", {
        required: true,
      });
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
      loaded(Hall, {
        id: 1,
        spot: loaded(Spot, { id: 5, label: "a" }),
        plate: loaded(Plate, { label: "p" }),
      });

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
      class Book extends Schema("books", {
        id: t.integer().primaryKey(),
        stamps: t.embedMany(() => Stamp),
      }) {}
      const stored = loaded(Book, { id: 1, stamps: [loaded(Stamp, { text: "ab", at: when })] });
      expect(Object.keys(cast(stored, { stamps: [{ text: "ab" }] }, []).castEmbed("stamps").changes)).toEqual(
        ["stamps"],
      );
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
});

describe("embedded rows, missingEmbedded, embedChanges and buildAssoc", () => {
  describe("buildAssoc", () => {
    test("builds the child of a has-one association, pointing at the parent", () => {
      const user = loaded(User, { id: 4, email: "a@b.c", role: "member", lockVersion: 1 });
      const profile = buildAssoc(User, user, "profile");
      expect(profile.changes).toMatchObject({ userId: 4 });
    });
  });

  class Badge extends EmbeddedSchema({
    label: t.string(),
    shown: t.string().virtual(),
    code: t.uuid().primaryKey().autogenerate(),
  }) {}
  class Member extends Schema("members", {
    id: t.integer().primaryKey(),
    title: t.string(),
    badge: t.embedOne(() => Badge, { onReplace: "delete" }).nullable(),
    badges: t.embedMany(() => Badge, { onReplace: "delete" }),
  }) {}
  const member = (badge: Badge | null, badges: readonly Badge[] = []) =>
    loaded(Member, { id: 1, title: "M", badge, badges });
  const badge = (label: string | null, code: string | null = "00000000-0000-4000-8000-000000000001") =>
    loaded(Badge, { label, code });

  describe("embedValue: embedded rows", () => {
    test("an unchanged stored item is the stored row; a changed one is a new built row", () => {
      const [kept, edited] = [badge("a"), badge("b", "00000000-0000-4000-8000-000000000002")];
      const cs = change(member(null, [kept as Badge, edited as Badge])).putEmbed("badges", [
        change(kept as Badge),
        change(edited as Badge, { label: "c" }),
      ] as never);
      const rows = embedValue(cs.changes.badges, "built") as Badge[];
      expect(rows[0]).toBe(kept);
      expect(stateOf(rows[1] as object)).toBe("built");
    });

    test("a virtual field is kept from the stored row, and a new row without it has none", () => {
      const stored = badge("a");
      (stored as unknown as { shown: string }).shown = "yes";
      const changed = embedValue(
        change(member(stored)).putEmbed("badge", change(stored, { label: "b" }) as never).changes.badge,
        "built",
      );
      expect((changed as Badge).shown).toBe("yes");
      const fresh = embedValue(
        change(member(null)).putEmbed("badge", { label: "n" } as never).changes.badge,
        "built",
      );
      expect((fresh as Badge).shown).toBeUndefined();
    });
  });

  describe("missingEmbedded", () => {
    test("keeps the other changes, marks the parent and the child invalid, with the required validation", () => {
      const cs = change(member(null), { title: "N" }).putEmbed("badge", {} as never) as unknown as AnyCsLike;
      const checked = missingEmbedded(cs as never) as unknown as AnyCsLike;
      expect(Object.keys(checked.changes)).toEqual(["title", "badge"]);
      expect(checked.valid).toBe(false);
      const child = checked.changes.badge as AnyCsLike;
      expect(child.valid).toBe(false);
      expect(child.errors.label).toStrictEqual([
        { message: "can't be blank", validation: "required", meta: {} },
      ]);
    });

    test("in a list: keeps the other changes, leaves the earlier list alone, and skips deleted items", () => {
      const broken = badge(null);
      const cs = change(member(null, [broken as Badge]), { title: "N" }).putEmbed("badges", [
        { label: "x", code: "00000000-0000-4000-8000-000000000009" },
        {},
      ] as never) as unknown as AnyCsLike;
      const itemBefore = (cs.changes.badges as readonly unknown[])[1];
      const checked = missingEmbedded(cs as never) as unknown as AnyCsLike;
      expect(Object.keys(checked.changes)).toEqual(["title", "badges"]);
      expect((cs.changes.badges as readonly unknown[])[1]).toBe(itemBefore);
      const items = checked.changes.badges as readonly AnyCsLike[];
      // The stored row left out is deleted: its null label is not reported.
      expect(items.map((item) => [item.action, Object.keys(item.errors)])).toEqual([
        ["insert", []],
        ["insert", ["label"]],
        ["delete", []],
      ]);
    });

    test("a null embed change, and a stored row with null in its generated key, are checked without fault", () => {
      expect(missingEmbedded(change(member(badge("a"))).putEmbed("badge", null) as never)).toBeUndefined();
      const keyless = loaded(Badge, { label: "a", code: null });
      const cs = change(member(keyless)).putEmbed("badge", change(keyless, { label: "b" }) as never);
      const checked = missingEmbedded(cs as never) as unknown as AnyCsLike;
      expect(Object.keys((checked.changes.badge as AnyCsLike).errors)).toEqual(["code"]);
    });

    test("a second embed with nothing missing keeps its change", () => {
      const cs = change(member(null))
        .putEmbed("badge", {} as never)
        .putEmbed("badges", [{ label: "x", code: "00000000-0000-4000-8000-000000000009" }] as never);
      const checked = missingEmbedded(cs as never) as unknown as AnyCsLike;
      expect(Array.isArray(checked.changes.badges)).toBe(true);
    });
  });

  describe("embedChanges", () => {
    test("an association change is left as it is; only embeds become rows", () => {
      const cs = change(Profile).putAssoc("user", { email: "e@x" } as never);
      const changes = embedChanges(cs as never, "built") as Record<string, unknown>;
      expect(changes.user).toBe((cs.changes as Record<string, unknown>).user);
    });
  });
});

describe("nested changes: keyless targets, odd params, custom key types, applied rows", () => {
  const actions = (cs: { readonly changes: object }, name: string): unknown[] =>
    ((cs.changes as Record<string, readonly AnyCs[] | undefined>)[name] ?? []).map((item) => item.action);

  test("a has-many to a schema without a primary key deletes a stored row left out", () => {
    class Note extends Schema(
      "keyless_notes",
      { listId: t.integer().nullable(), text: t.string() },
      { primaryKey: false },
    ) {}
    class Board extends Schema("keyless_boards", { id: t.integer().primaryKey() }) {
      static notes = hasMany(() => Note, { foreignKey: "listId", onReplace: "delete" });
    }
    const stored = loaded(Board, { id: 1 }, { notes: [loaded(Note, { listId: 1, text: "a" })] });
    expect(actions(change(stored).putAssoc("notes", []), "notes")).toEqual(["delete"]);
  });

  class Leaflet extends Schema("leaflets", {
    id: t.integer().primaryKey(),
    folderId: t.integer().nullable(),
    text: t.string(),
  }) {
    static changeset(leaflet: Leaflet | typeof Leaflet, params: unknown) {
      return cast(leaflet, params, ["id", "text"]);
    }
  }
  class Folder extends Schema("folders", { id: t.integer().primaryKey() }) {
    static leaflets = hasMany(() => Leaflet, { foreignKey: "folderId", onReplace: "delete" });
  }
  const folder = () => loaded(Folder, { id: 1 }, { leaflets: [] });

  test("options given as a list are refused", () => {
    expect(() => cast(folder(), { leaflets: [] }, []).castAssoc("leaflets", [] as never)).toThrow(
      /^query\.nestedOptions: /,
    );
  });

  test("items of the params that are null, undefined or not plain objects make the list invalid", () => {
    for (const item of [null, undefined, new Date(0)]) {
      const cs = cast(folder(), { leaflets: [item] }, []).castAssoc("leaflets");
      expect(cs.errors.leaflets?.map((error) => error.validation)).toEqual(["cast"]);
      expect(Object.keys(cs.changes)).toEqual([]);
    }
  });

  test("a value given to putAssoc that is not a plain object is refused", () => {
    expect(() => change(folder()).putAssoc("leaflets", [new Date(0)] as never)).toThrow(
      /^query\.nestedValue: /,
    );
  });

  test("a stored row put back is matched by its key, also for a key type whose cast refuses its own values", () => {
    const Code = defineType<bigint, string>({
      name: "code",
      db: { kind: "text" },
      cast: (input) =>
        typeof input === "string" && /^\d+$/.test(input)
          ? { success: true, data: BigInt(input) }
          : { success: false, message: "is not a code" },
      fromDb: (stored) => BigInt(stored),
      toDb: (value) => value.toString(),
    });
    class Coupon extends Schema("coupons", {
      code: t.type(Code).primaryKey(),
      shopId: t.integer().nullable(),
    }) {}
    class Shop extends Schema("shops", { id: t.integer().primaryKey() }) {
      static coupons = hasMany(() => Coupon, { foreignKey: "shopId", onReplace: "delete" });
    }
    const coupon = loaded(Coupon, { code: 7n, shopId: 1 });
    const stored = loaded(Shop, { id: 1 }, { coupons: [coupon] });
    expect(change(stored).putAssoc("coupons", [coupon]).changes).toEqual({});
  });

  class Pin extends EmbeddedSchema({ id: t.integer().primaryKey(), label: t.string() }) {
    static changeset(pin: Pin | typeof Pin, params: unknown) {
      return cast(pin, params, ["id", "label"]);
    }
  }
  class Note extends EmbeddedSchema({ text: t.string(), at: t.timestamp() }) {
    static changeset(note: Note | typeof Note, params: unknown) {
      return cast(note, params, ["text", "at"]);
    }
  }
  class Wall extends Schema("walls", {
    id: t.integer().primaryKey(),
    pins: t.embedMany(() => Pin, { onReplace: "delete" }),
    notes: t.embedMany(() => Note),
  }) {}
  /** A loaded wall with `changes` applied: its new embedded rows lack what was not given. */
  const appliedWall = (params: Readonly<Record<string, unknown>>, name: "pins" | "notes") =>
    cast(loaded(Wall, { id: 1, pins: [], notes: [] }), params, [])
      .castEmbed(name)
      .applyChanges();

  test("an applied new embedded row without its key matches no item without a key", () => {
    const wall = appliedWall({ pins: [{ label: "a" }] }, "pins");
    expect(actions(change(wall).putEmbed("pins", [{ label: "b" }] as never), "pins")).toEqual([
      "insert",
      "delete",
    ]);
    expect(actions(cast(wall, { pins: [{ id: "x", label: "b" }] }, []).castEmbed("pins"), "pins")).toEqual([
      "insert",
      "delete",
    ]);
  });

  test("an applied keyless embedded row without a required date is compared without fault", () => {
    const wall = appliedWall({ notes: [{ text: "a" }] }, "notes");
    const cs = cast(wall, { notes: [{ text: "a", at: "2026-01-01T00:00:00.000Z" }] }, []).castEmbed("notes");
    expect(Object.keys(cs.changes)).toEqual(["notes"]);
  });

  test("a stored row of a keyless list put back as its own changeset is written again", () => {
    class Chip extends EmbeddedSchema({ label: t.string().nullable() }) {}
    class Tray extends Schema("trays", { id: t.integer().primaryKey(), chips: t.embedMany(() => Chip) }) {}
    const chip = loaded(Chip, { label: null });
    const cs = change(loaded(Tray, { id: 1, chips: [chip] })).putEmbed("chips", [change(chip)] as never);
    expect(Object.keys(cs.changes)).toEqual(["chips"]);
  });

  test("an embedded field with a default and autogenerate takes the default on insert, a value on update", () => {
    const { updatedAt } = timestamps({ createdAt: false });
    const epoch = new Date(0);
    class Tab extends EmbeddedSchema({
      label: t.string(),
      code: t
        .string()
        .default("dflt")
        .autogenerate(() => "gen"),
      updatedAt: updatedAt.default(epoch),
    }) {}
    class Strip extends Schema("strips", { id: t.integer().primaryKey(), tabs: t.embedMany(() => Tab) }) {}
    const fresh = embedValue(
      (
        change(loaded(Strip, { id: 1, tabs: [] })).putEmbed("tabs", [{ label: "a" }] as never).changes as {
          tabs: unknown;
        }
      ).tabs,
      "built",
    ) as Tab[];
    expect(fresh[0]?.code).toBe("dflt");
    const tab = loaded(Tab, { label: "a", code: "c", updatedAt: epoch });
    const edited = embedValue(
      (
        change(loaded(Strip, { id: 1, tabs: [tab] })).putEmbed("tabs", [change(tab, { label: "b" })] as never)
          .changes as { tabs: unknown }
      ).tabs,
      "built",
    ) as Tab[];
    expect(edited[0]?.updatedAt).not.toBe(epoch);
  });
});
