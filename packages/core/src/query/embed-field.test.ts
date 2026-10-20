// Unit tests for `field()`, the typed path into an embedded row: the SQL it compiles to,
// its type and redaction, and what it refuses.
import { describe, expect, test } from "vitest";
import { createCompiler } from "../compiler/compiler.js";
import { postgresDialect } from "../compiler/dialect.js";
import { QueryError } from "../errors.js";
import { EmbeddedSchema, from, Schema, t } from "../index.js";

class Geo extends EmbeddedSchema({ lat: t.float(), lng: t.float() }) {}

class Place extends EmbeddedSchema({
  city: t.string(),
  zip: t.string().nullable().column("postal"),
  since: t.timestamp().nullable(),
  floors: t.integer(),
  code: t.string().redact(),
  geo: t.embedOne(() => Geo).nullable(),
  meta: t.json<{ a: number }>().nullable(),
  ghost: t.string().virtual(),
}) {}

class Venue extends Schema("venues", {
  id: t.integer().primaryKey(),
  place: t.embedOne(() => Place).nullable(),
  places: t.embedMany(() => Place),
  doc: t.json<{ city: string }>().nullable(),
}) {}

function sql(query: { readonly ast: unknown }): { sql: string; params: readonly unknown[] } {
  const plan = createCompiler(postgresDialect).compile(query.ast as never, "all", undefined);
  return {
    sql: plan.sql,
    params: (query as unknown as { readonly ast: { readonly params: readonly unknown[] } }).ast.params,
  };
}

describe("field() on an embed", () => {
  test("a text field reads #>> with its key bound", () => {
    const q = from(Venue, "v")
      .where(({ v }) => v.place.field("city").eq("Oslo"))
      .select(({ v }) => v.id);
    expect(sql(q)).toEqual({
      sql: 'select "v"."id" as "c0" from "venues" as "v" where "v"."place" #>> array[$1] = $2',
      params: ["city", "Oslo"],
    });
  });

  test("other types are cast from the text, the stored key is the field's column", () => {
    const q = from(Venue, "v").select(({ v }) => ({
      floors: v.place.field("floors"),
      zip: v.place.field("zip"),
      since: v.place.field("since"),
    }));
    expect(sql(q).sql).toBe(
      'select cast("v"."place" #>> array[$1] as integer) as "c0", "v"."place" #>> array[$2] as "c1", cast("v"."place" #>> array[$3] as timestamptz) as "c2" from "venues" as "v"',
    );
    expect(sql(q).params).toEqual(["floors", "postal", "since"]);
  });

  test("a nested embed or JSON field reads #> so that field() chains", () => {
    const q = from(Venue, "v").select(({ v }) => v.place.field("geo").field("lat"));
    expect(sql(q).sql).toBe(
      'select cast("v"."place" #> array[$1] #>> array[$2] as double precision) as "c0" from "venues" as "v"',
    );
    expect(from(Venue, "v").select(({ v }) => v.place.field("meta")).ast).toBeDefined();
  });

  test("a redacted embedded field makes the compared value redacted", () => {
    let redact = false;
    from(Venue, "v").where(({ v }) => {
      const condition = v.place.field("code").eq("secret");
      redact = v.place.field("code").redact;
      return condition;
    });
    expect(redact).toBe(true);
  });

  test("a list of embeds, plain JSON, another type and an unknown or virtual field are refused", () => {
    from(Venue, "v").where(({ v }) => {
      expect(() => (v.places as never as { field(name: string): unknown }).field("city")).toThrow(
        /list of embedded rows/,
      );
      expect(() => (v.doc as never as { field(name: string): unknown }).field("city")).toThrow(QueryError);
      expect(() => (v.id as never as { field(name: string): unknown }).field("city")).toThrow(
        /of the type integer/,
      );
      expect(() => v.place.field("nope" as never)).toThrow(/no stored field "nope"/);
      expect(() => v.place.field("ghost" as never)).toThrow(/no stored field "ghost"/);
      expect(() => v.place.field(3 as never)).toThrow(/no stored field 3/);
      return v.id.eq(1);
    });
  });
});
