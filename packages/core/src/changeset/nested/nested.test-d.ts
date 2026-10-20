// Type tests for nested changes: the names and values castAssoc, putAssoc, castEmbed and
// putEmbed take, the with function, the types of nested changes, buildAssoc, and embed
// fields in rows, inserts and query expressions.
import { describe, expectTypeOf, test } from "vitest";
import type { InsertShape, Row } from "../../contracts/schema.js";
import {
  belongsTo,
  buildAssoc,
  type Changeset,
  cast,
  change,
  EmbeddedSchema,
  type Expr,
  from,
  hasMany,
  hasOne,
  manyToMany,
  Schema,
  t,
} from "../../index.js";

class Mark extends Schema("marks", {
  id: t.integer().primaryKey().dbGenerated(),
  sheetId: t.integer(),
  score: t.integer(),
}) {
  static changeset(mark: Mark | typeof Mark, params: unknown) {
    return cast(mark, params, ["score"]);
  }
}

/** No static changeset: `with` is required. */
class Remark extends Schema("remarks", {
  id: t.integer().primaryKey().dbGenerated(),
  sheetId: t.integer(),
  text: t.string(),
}) {}

class Badge extends Schema("badges", { id: t.integer().primaryKey().dbGenerated(), label: t.string() }) {}

class Pupil extends Schema("pupils", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {}

class Corner extends EmbeddedSchema({ x: t.float(), y: t.float() }) {}

class Margin extends EmbeddedSchema({
  side: t.string(),
  scan: t.binary().nullable(),
  notes: t.array(t.string()).nullable(),
  width: t.integer().nullable(),
  corner: t.embedOne(() => Corner).nullable(),
}) {
  static changeset(margin: Margin | typeof Margin, params: unknown) {
    return cast(margin, params, ["side", "width"]);
  }
}

class Sheet extends Schema("sheets", {
  id: t.integer().primaryKey().dbGenerated(),
  pupilId: t.integer(),
  title: t.string(),
  margin: t.embedOne(() => Margin).nullable(),
  corners: t.embedMany(() => Corner, { onReplace: "delete" }),
  meta: t.json<{ pages: number }>().nullable(),
}) {
  static marks = hasMany(() => Mark, { foreignKey: "sheetId", onReplace: "delete" });
  static remarks = hasMany(() => Remark, { foreignKey: "sheetId" });
  static pupil = belongsTo(() => Pupil, { foreignKey: "pupilId" });
  static cover = hasOne(() => Badge, { foreignKey: "id" });
  static badges = manyToMany(() => Badge, {
    joinThrough: "sheet_badges",
    joinKeys: { owner: "sheet_id", target: "badge_id" },
    onReplace: "delete",
  });
}

declare const sheet: Sheet;
declare const params: unknown;
declare const mark: Mark;
declare const badge: Badge;
declare const pupil: Pupil;

describe("castAssoc", () => {
  test("takes the association names of the class, and only those", () => {
    const cs = cast(Sheet, params, ["title"]);
    expectTypeOf(cs.castAssoc("marks")).toEqualTypeOf(cs);
    // @ts-expect-error not an association
    cs.castAssoc("title");
    // @ts-expect-error not an association
    cs.castAssoc("nope");
  });

  test("with defaults to the target's static changeset; without one it is required", () => {
    const cs = cast(Sheet, params, ["title"]);
    cs.castAssoc("marks", { required: true });
    cs.castAssoc("remarks", {
      with: (remark, item, index) => {
        expectTypeOf(remark).toEqualTypeOf<Remark | typeof Remark>();
        expectTypeOf(item).toEqualTypeOf<Readonly<Record<string, unknown>>>();
        expectTypeOf(index).toEqualTypeOf<number>();
        return cast(remark, item, ["text"]);
      },
    });
    // @ts-expect-error Remark has no static changeset: pass with
    cs.castAssoc("remarks");
    // @ts-expect-error with must make a changeset of the target
    cs.castAssoc("marks", { with: (_target: typeof Mark, item: unknown) => cast(Badge, item, ["label"]) });
    // @ts-expect-error a with function that takes only the class cannot be called with a row
    cs.castAssoc("marks", { with: (target: typeof Mark, item: unknown) => cast(target, item, ["score"]) });
  });

  test("a changeset made from a row alone takes any name", () => {
    const cs = cast(sheet, params, ["title"]);
    cs.castAssoc("marks");
    cs.castAssoc("anything");
  });
});

describe("putAssoc", () => {
  test("a list for to-many, one value or null for to-one; rows, changesets or plain objects", () => {
    const cs = change(Sheet);
    cs.putAssoc("marks", [mark, change(Mark, { score: 1 }), { score: 2 }]);
    cs.putAssoc("badges", [badge, { label: "gold" }]);
    cs.putAssoc("pupil", pupil);
    cs.putAssoc("pupil", null);
    cs.putAssoc("cover", { label: "c" });
    // @ts-expect-error a to-many association takes a list
    cs.putAssoc("marks", mark);
    // @ts-expect-error a to-one association takes one value
    cs.putAssoc("pupil", [pupil]);
    // @ts-expect-error a key that is not a field, in a literal
    cs.putAssoc("marks", [{ label: "x" }]);
    // @ts-expect-error a field of the wrong type in a plain object
    cs.putAssoc("marks", [{ score: "high" }]);
  });
});

describe("castEmbed and putEmbed", () => {
  test("take the embed fields of the class, and only those", () => {
    const cs = cast(Sheet, params, ["title"]);
    cs.castEmbed("margin");
    cs.castEmbed("corners", { with: (corner, item) => cast(corner, item, ["x", "y"]) });
    // @ts-expect-error not an embed field
    cs.castEmbed("title");
    // @ts-expect-error a JSON field is not an embed
    cs.castEmbed("meta");
    // @ts-expect-error Corner has no static changeset
    cs.castEmbed("corners");
    cs.putEmbed("margin", { side: "left" });
    cs.putEmbed("margin", null);
    cs.putEmbed("corners", [{ x: 1, y: 2 }]);
    // @ts-expect-error a list of embeds takes an array
    cs.putEmbed("corners", { x: 1, y: 2 });
    // @ts-expect-error a field of the wrong type
    cs.putEmbed("margin", { side: 3 });
  });
});

describe("the types of nested changes", () => {
  test("an association's change is its child changesets; a field's change is its value", () => {
    const cs = cast(Sheet, params, ["title"]).castAssoc("marks");
    expectTypeOf(cs.changes.marks).toEqualTypeOf<readonly Changeset<typeof Mark, boolean>[] | undefined>();
    expectTypeOf(cs.changes.pupil).toEqualTypeOf<Changeset<typeof Pupil, boolean> | null | undefined>();
    expectTypeOf(cs.changes.title).toEqualTypeOf<string | undefined>();
    expectTypeOf(cs.changes.margin).toEqualTypeOf<
      Margin | Changeset<typeof Margin, boolean> | null | undefined
    >();
    expectTypeOf(cs.changes.corners).toEqualTypeOf<
      Corner[] | readonly Changeset<typeof Corner, boolean>[] | undefined
    >();
    expectTypeOf(cs.getField("margin")).toEqualTypeOf<Margin | null>();
  });

  test("a changeset made from a row alone still fits where one of the class is expected", () => {
    const takesClass = (cs: Changeset<typeof Sheet>) => cs;
    takesClass(change(sheet));
  });
});

describe("buildAssoc", () => {
  test("is a changeset of a new record of the target, with its values typed", () => {
    const cs = buildAssoc(Sheet, sheet, "marks", { score: 3 });
    expectTypeOf(cs).toEqualTypeOf<Changeset<typeof Mark, true>>();
    expectTypeOf(cs).not.toBeAny();
    // @ts-expect-error not a field of Mark
    buildAssoc(Sheet, sheet, "marks", { nope: 1 });
    // @ts-expect-error not an association
    buildAssoc(Sheet, sheet, "title");
  });
});

describe("embed fields", () => {
  test("are rows of the embedded class in a row, and optional where they have a default on insert", () => {
    expectTypeOf<Row<typeof Sheet>["margin"]>().toEqualTypeOf<Margin | null>();
    expectTypeOf<Row<typeof Sheet>["corners"]>().toEqualTypeOf<Corner[]>();
    expectTypeOf<InsertShape<typeof Sheet>>().toEqualTypeOf<{
      pupilId: number;
      title: string;
      id?: number;
      margin?: Margin | null;
      corners?: Corner[];
      meta?: { pages: number } | null;
    }>();
  });

  test("field() reads a typed field of an embedded row in a query", () => {
    from(Sheet, "s").where(({ s }) => {
      expectTypeOf(s.margin.field("side")).toEqualTypeOf<Expr<string | null, Record<never, never>>>();
      expectTypeOf(s.margin.field("width")).toEqualTypeOf<Expr<number | null, Record<never, never>>>();
      expectTypeOf(s.margin.field("corner").field("x")).toEqualTypeOf<
        Expr<number | null, Record<never, never>>
      >();
      // @ts-expect-error not a field of Margin
      s.margin.field("top");
      // @ts-expect-error bytes are not read by field()
      s.margin.field("scan");
      // @ts-expect-error lists are not read by field()
      s.margin.field("notes");
      // @ts-expect-error a list of embeds has no single field
      s.corners.field("x");
      // @ts-expect-error a text column is not an embed
      s.title.field("length");
      return s.margin.field("side").eq("left");
    });
  });
});
