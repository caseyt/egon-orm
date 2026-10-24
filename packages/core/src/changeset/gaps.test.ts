// Step 21 (changeset gaps): behaviours that mutation testing showed no test covered, each
// checked against the mutant it kills. Grouped by the function they exercise.
import { Post, Profile, User, UserSettings } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { belongsTo, EmbeddedSchema, hasMany, meta, Schema, stateOf, t } from "../schema/index.js";
import { cast, change, rebuild, withAction } from "./changeset.js";
import { buildAssoc } from "./nested/build.js";
import { embedChanges, embedValue, missingEmbedded } from "./nested/embed.js";

/** The parts of a changeset these tests read, untyped. */
interface AnyCsLike {
  readonly changes: Readonly<Record<string, unknown>>;
  readonly errors: Readonly<Record<string, unknown>>;
  readonly valid: boolean;
  readonly action: string | null;
}

/** A row of `schema` as a query would return it. */
function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

class Session extends Schema("sessions", {
  id: t.integer().primaryKey(),
  startsAt: t.timestamp(),
  endsAt: t.timestamp().nullable(),
  tags: t.array(t.string()),
  mode: t.string().virtual().default("plain"),
}) {}

const iso = "2026-04-01T09:00:00.000Z";
const stored = () => loaded(Session, { id: 1, startsAt: new Date(iso), endsAt: null, tags: ["a"] });

describe("comparing a change with the current value", () => {
  test("a value over a null or missing current value is a change, whatever the type", () => {
    expect(cast(stored(), { endsAt: iso }, ["endsAt"]).changes).toEqual({ endsAt: new Date(iso) });
    expect(cast(Session, { startsAt: iso }, ["startsAt"]).changes).toEqual({ startsAt: new Date(iso) });
    expect(cast(stored(), { startsAt: null }, ["startsAt"]).changes).toEqual({});
  });

  test("null over a stored value is a change, whatever the type", () => {
    const ended = loaded(Session, { id: 1, startsAt: new Date(iso), endsAt: new Date(iso), tags: [] });
    expect(cast(ended, { endsAt: null }, ["endsAt"]).changes).toEqual({ endsAt: null });
  });

  test("a loaded row's virtual field is compared with the row's value, not with the default", () => {
    expect(cast(stored(), { mode: "plain" }, ["mode"]).changes).toEqual({ mode: "plain" });
  });
});

describe("validateRequired", () => {
  test("an empty list is a value, not blank", () => {
    expect(cast(stored(), { tags: [] }, ["tags"]).validateRequired(["tags"]).valid).toBe(true);
  });

  test("one message per field: a second failing validation adds none", () => {
    const twice = cast(User, {}, []).validateRequired(["email"]).validateLength("email", { min: 3 });
    expect(twice.errors.email).toHaveLength(1);
  });
});

describe("merge", () => {
  const row = () => loaded(User, { id: 1, email: "a@b.c", role: "member", lockVersion: 1 });

  test("keeps two errors that differ only in their constraint", () => {
    const user = row();
    const taken = (constraint: string) =>
      rebuild(change(user), {
        errors: { email: [{ message: "has already been taken", constraint, meta: {} }] },
        valid: false,
      });
    expect(taken("unique").merge(taken("foreign")).errors.email).toHaveLength(2);
    expect(taken("unique").merge(taken("unique")).errors.email).toHaveLength(1);
  });

  test("takes an action from either side, the same action on both, and refuses two different ones", () => {
    const user = row();
    const none = change(user);
    const update = withAction(change(user), "update");
    expect(none.merge(update).action).toBe("update");
    expect(update.merge(none).action).toBe("update");
    expect(update.merge(withAction(change(user), "update")).action).toBe("update");
    expect(() => update.merge(withAction(change(user), "delete"))).toThrow(QueryError);
  });
});

class Card extends Schema("cards", {
  id: t.integer().primaryKey(),
  code: t.string().nullable(),
  kind: t.string().nullable(),
  score: t.integer().nullable(),
  labels: t.array(t.string()).nullable(),
  notes: t.array(t.json()).nullable(),
  pin: t.string().nullable(),
}) {}
const card = () =>
  loaded(Card, { id: 1, code: "a", kind: "x", score: 1, labels: ["a"], notes: [], pin: "1" });

describe("validations skip null, as they skip a missing value", () => {
  test("format, inclusion, exclusion, subset, number and length take null as no value", () => {
    const cleared = cast(card(), { code: null, kind: null, score: null, labels: null }, [
      "code",
      "kind",
      "score",
      "labels",
    ]);
    const checked = cleared
      .validateFormat("code", /^[a-z]+$/)
      .validateInclusion("kind", ["y"])
      .validateExclusion("kind", ["x"])
      .validateSubset("labels", ["b"])
      .validateNumber("score", { greaterThan: 5 })
      .validateLength("code", { min: 3 });
    expect(checked.errors).toEqual({});
    expect(checked.valid).toBe(true);
  });
});

describe("validateRequired with one name", () => {
  test("a single field name reports one error, not one per character", () => {
    expect(cast(User, {}, []).validateRequired("email").errors.email).toHaveLength(1);
  });
});

describe("validateSubset", () => {
  test("elements are compared by value, so equal objects are in the set", () => {
    const cs = cast(card(), { notes: [{ a: 1 }] }, ["notes"]).validateSubset("notes", [{ a: 1 }] as never);
    expect(cs.valid).toBe(true);
  });

  test("its entry in validations() names it subset, with its values", () => {
    const cs = cast(card(), { labels: ["a"] }, ["labels"]).validateSubset("labels", ["a", "b"]);
    expect(cs.validations).toStrictEqual([["labels", { validation: "subset", values: ["a", "b"] }]]);
  });
});

describe("validateLength", () => {
  test("is is checked like min and max", () => {
    expect(() => cast(card(), {}, []).validateLength("code", { is: -1 })).toThrow(QueryError);
    expect(() => cast(card(), {}, []).validateLength("code", { is: 1.5 })).toThrow(QueryError);
  });
});

describe("validateConfirmation", () => {
  test("a changeset made by change() has no params, and reports nothing", () => {
    const cs = change(card(), { pin: "2" }).validateConfirmation("pin");
    expect(cs.valid).toBe(true);
    expect(cs.errors).toEqual({});
  });
});

describe("validateChange", () => {
  test("a failing check makes the changeset invalid; each outcome is recorded as change", () => {
    const failing = cast(card(), { code: "b" }, ["code"]).validateChange("code", () => ["is wrong"]);
    expect(failing.valid).toBe(false);
    expect(failing.validations).toStrictEqual([["code", { validation: "change" }]]);
    const passing = cast(card(), { code: "b" }, ["code"]).validateChange("code", () => []);
    expect(passing.valid).toBe(true);
    expect(passing.validations).toStrictEqual([["code", { validation: "change" }]]);
  });
});

describe("reading an embed change", () => {
  test("getField and fetchField give the embedded row as a built row", () => {
    const user = loaded(User, { id: 1, email: "a@b.c", role: "member", lockVersion: 1 });
    const cs = change(user).putEmbed("settings", { theme: "dark" } as never);
    expect(stateOf(cs.getField("settings") as object)).toBe("built");
    expect(stateOf(cs.fetchField("settings")?.value as object)).toBe("built");
  });
});

describe("constraint default names with a key of two columns", () => {
  class Pair extends Schema("pairs", {
    orgId: t.uuid().primaryKey(),
    userId: t.integer().primaryKey(),
  }) {
    static grants = hasMany(() => Grant, { foreignKey: ["orgId", "userId"] });
  }
  class Grant extends Schema("grants", {
    id: t.integer().primaryKey(),
    orgId: t.uuid(),
    userId: t.integer(),
  }) {
    static pair = belongsTo(() => Pair, { foreignKey: ["orgId", "userId"] });
  }

  test("the columns are joined with underscores", () => {
    expect(change(Grant).assocConstraint("pair").constraints[0]?.name).toBe("grants_org_id_user_id_fkey");
    expect(change(Pair).noAssocConstraint("grants").constraints[0]?.name).toBe("grants_org_id_user_id_fkey");
  });
});

describe("optimisticLock", () => {
  test("a field with no current value is refused; a custom incrementer works on any type", () => {
    expect(() => change(Card).optimisticLock("id")).toThrow(/has no value to compare/);
    const locked = change(card()).optimisticLock("code", (value) => `${String(value)}x`);
    expect(locked.filters).toEqual({ code: "a" });
  });
});

describe("validateNumber equalTo", () => {
  test("a value above the limit is not equal to it", () => {
    expect(cast(card(), { score: 11 }, ["score"]).validateNumber("score", { equalTo: 10 }).valid).toBe(false);
  });
});

describe("a validator given a value of the wrong type", () => {
  test("refuses it with a QueryError", () => {
    const scored = cast(card(), { score: 5 }, ["score"]);
    expect(() => scored.validateFormat("score" as never, /x/)).toThrow(QueryError);
    expect(() => scored.validateLength("score" as never, { min: 1 })).toThrow(QueryError);
  });
});

describe("validateChange results", () => {
  test("null and an empty list are no issues", () => {
    const cs = cast(card(), { code: "b" }, ["code"]);
    expect(cs.validateChange("code", () => null as never).valid).toBe(true);
    expect(cs.validateChange("code", () => []).valid).toBe(true);
  });
});

describe("applyChanges", () => {
  test("without a schema class, the data's value wins over the field's default", () => {
    const search = change({ data: { q: "held" }, types: { q: t.string().default("dflt") } });
    expect(search.applyChanges()).toEqual({ q: "held" });
  });

  test("without a schema class, an embed the data holds stays when it has no change", () => {
    const settings = loaded(UserSettings, { theme: "dark", emailNotifications: true });
    const prefs = change({
      data: { s: settings },
      types: { s: t.embedOne(() => UserSettings, { onReplace: "update" }) },
    });
    expect(prefs.applyChanges().s).toBe(settings);
    const put = prefs.putEmbed("s", { theme: "light" } as never).applyChanges().s;
    expect(stateOf(put as object)).toBe("built");
  });

  test("an embed change becomes a built row", () => {
    const user = loaded(User, { id: 1, email: "a@b.c", role: "member", lockVersion: 1 });
    const applied = change(user)
      .putEmbed("settings", { theme: "dark" } as never)
      .applyChanges();
    expect(stateOf(applied.settings as object)).toBe("built");
  });
});

describe("casting again", () => {
  test("null for a required field twice reports it once", () => {
    const first = cast(User, { email: null }, ["email"]);
    expect(cast(first, { email: null }, ["email"]).errors.email).toHaveLength(1);
  });
});

describe("change()", () => {
  test("refuses an embed field, which putEmbed changes", () => {
    const user = loaded(User, { id: 1, email: "a@b.c", role: "member", lockVersion: 1 });
    expect(() => change(user, { settings: { theme: "dark" } } as never)).toThrow(/^query\.changeEmbed: /);
  });
});

describe("changesets without a schema class", () => {
  test("two changesets of the same data and types are of the same record, and merge", () => {
    const source = { data: { q: "a" }, types: { q: t.string(), page: t.integer() } };
    const merged = change(source, { q: "b" }).merge(change(source, { page: 2 }));
    expect(merged.changes).toEqual({ q: "b", page: 2 });
  });

  test("an unknown field name is refused with a QueryError", () => {
    const search = change({ data: {}, types: { q: t.string() } });
    expect(() => search.putChange("nope" as never, "x" as never)).toThrow(QueryError);
  });
});

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

describe("embedded rows", () => {
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

test("the fixtures: Post exists for the shared imports", () => {
  expect(meta(Post).name).toBe("Post");
});
