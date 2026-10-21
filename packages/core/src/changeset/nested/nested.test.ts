// Unit tests for nested changesets: castAssoc, castEmbed, putAssoc, putEmbed and
// buildAssoc build child changesets with the right actions; rows left out follow
// onReplace; errors stay on the children and are traversed; nothing touches a database.
import { describe, expect, test } from "vitest";
import type { AnySchema, OnReplace, Row } from "../../contracts/schema.js";
import { NotLoadedError, QueryError } from "../../errors.js";
import {
  belongsTo,
  EmbeddedSchema,
  hasMany,
  hasOne,
  manyToMany,
  meta,
  Schema,
  t,
  timestamps,
} from "../../index.js";
import { type Changeset, cast, change, rebuild } from "../changeset.js";
import { buildAssoc } from "./build.js";
import { embedChanges, embedValue, missingEmbedded } from "./embed.js";

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
    expect(() => change(catalogue).putAssoc("genres", g1 as never)).toThrow("query.nestedNotArray: putAssoc(\"genres\"): Catalogue.genres holds a list.");
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
