// The security review of step 21: what cast() and the nested casts do with params an
// attacker wrote. Params come from a request body: keys such as __proto__ and
// constructor, getters, symbols, inherited properties, very many keys, very long values
// and deep nesting. Nothing here may change a prototype, assign a field that was not
// permitted, or take time or memory beyond what the size of the params explains.
//
// Sizes are bounded by counting work (property reads), not by timing it, so that the
// tests do not depend on the speed of the machine.
import { User } from "@egon-orm/test-support";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { embedValue } from "../../src/changeset/nested/embed.js";
import { indexOfKey, keyFinder } from "../../src/changeset/nested/relation.js";
import type { AnySchema, FieldMeta, Row } from "../../src/contracts/schema.js";
import { CastError, NotLoadedError, QueryError } from "../../src/errors.js";
import { cast, change, EmbeddedSchema, hasMany, hasOne, meta, Schema, t } from "../../src/index.js";

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

class Leaf extends Schema("leaves", {
  id: t.integer().primaryKey(),
  ownerId: t.integer(),
  name: t.string(),
}) {
  static changeset(leaf: Leaf | typeof Leaf, params: unknown) {
    return cast(leaf, params, ["name"]);
  }
}

class Owner extends Schema("owners", { id: t.integer().primaryKey(), title: t.string().nullable() }) {
  static leaves = hasMany(() => Leaf, { foreignKey: "ownerId", onReplace: "delete" });
}

class Note extends EmbeddedSchema({ text: t.string() }) {
  static changeset(note: Note | typeof Note, params: unknown) {
    return cast(note, params, ["text"]);
  }
}

class Board extends Schema("boards", {
  id: t.integer().primaryKey(),
  title: t.string().nullable(),
  doc: t.json().nullable(),
  tags: t.array(t.string()).nullable(),
  amount: t.decimal().nullable(),
  notes: t.embedMany(() => Note),
}) {}

/** Removes what a test put on Object.prototype. */
const planted: string[] = [];
function plant(key: string, value: unknown): void {
  planted.push(key);
  Object.defineProperty(Object.prototype, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}
afterEach(() => {
  for (const key of planted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
});

describe("prototype pollution", () => {
  test("__proto__, constructor and prototype keys of parsed JSON are inert", () => {
    const params = JSON.parse(
      '{"__proto__": {"role": "admin", "polluted": true}, "constructor": {"prototype": {"polluted": true}}, "prototype": {"polluted": true}, "email": "a@b.c"}',
    );
    const cs = cast(User, params, ["email", "role"]);
    expect(cs.changes).toEqual({ email: "a@b.c" });
    expect(Object.getPrototypeOf(cs.changes)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    // The changeset of a loaded row merges params: the copy keeps __proto__ as an own key.
    const again = cast(cs, params, ["email"]);
    expect(Object.getPrototypeOf(again.params)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.stringify(cs)).not.toContain("admin");
  });

  test("a permitted name that is not a field is refused, prototype members included", () => {
    for (const name of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => cast(User, {}, [name as never])).toThrow(QueryError);
    }
  });

  test("a schema field cannot be named __proto__, constructor or toJSON", () => {
    for (const name of ["__proto__", "constructor", "toJSON"]) {
      expect(() => Schema("odd", { id: t.integer().primaryKey(), [name]: t.string() })).toThrow();
    }
  });

  test("a property inherited from a polluted Object.prototype is not a param", () => {
    plant("role", "admin");
    plant("id", 1);
    expect(cast(User, {}, ["role"]).changes).toEqual({});
    expect(cast(User, { email: "a@b.c" }, ["email", "role"]).changes).toEqual({ email: "a@b.c" });
    // A nested item's key is read the same way: `{}` is a new leaf, not an update of leaf 1.
    const owner = loaded(Owner, { id: 7 }, { leaves: [loaded(Leaf, { id: 1, ownerId: 7, name: "one" })] });
    const cs = cast(owner, { leaves: [{ name: "new" }] }, []).castAssoc("leaves");
    const leaves = (cs.changes as { leaves?: readonly { action: string; data: unknown }[] }).leaves ?? [];
    expect(leaves.map((child) => [child.action, child.data === null])).toEqual([
      ["insert", true],
      ["delete", false],
    ]);
  });

  test("params that are not a plain object are refused: no inherited fields at all", () => {
    expect(() => cast(User, Object.create({ role: "admin" }), ["role"])).toThrow(CastError);
    class Body {
      role = "admin";
    }
    expect(() => cast(User, new Body(), ["role"])).toThrow(CastError);
    expect(() => cast(User, [["role", "admin"]], ["role"])).toThrow(CastError);
  });

  describe("a key planted on Object.prototype is no change, no error and no value", () => {
    const owner = () =>
      loaded(Owner, { id: 7, title: null }, { leaves: [loaded(Leaf, { id: 1, ownerId: 7, name: "one" })] });

    test("the same stored row cast again records no change", () => {
      plant("planted", "x");
      const cs = cast(owner(), { leaves: [{ id: 1, name: "one" }] }, []).castAssoc("leaves");
      expect(Object.keys(cs.changes)).toEqual([]);
    });

    test("a changeset that settles a relation stays valid", () => {
      plant("planted", "x");
      const cs = change(owner()).putAssoc("leaves", [{ id: 1, name: "two" }] as never);
      expect(cs.valid).toBe(true);
    });

    test("an unchanged embedded item stays the stored row", () => {
      plant("planted", "x");
      const [first, second] = [loaded(Note, { text: "a" }), loaded(Note, { text: "b" })];
      const board = loaded(Board, { id: 1, notes: [first, second] });
      const cs = change(board).putEmbed("notes", [
        change(first as Note),
        change(second as Note, { text: "c" }),
      ] as never);
      const rows = embedValue((cs.changes as { notes: unknown }).notes, "built") as Note[];
      expect(rows[0]).toBe(first);
    });

    test("a validator does not see it", () => {
      plant("planted", "x");
      let seen: object = {};
      cast(Owner, { title: "t" }, ["title"]).validate((values) => {
        seen = values as object;
      });
      expect(Object.hasOwn(seen, "planted")).toBe(false);
    });

    test("routed issues that the child drops leave the parent valid", () => {
      plant("planted", "x");
      const cs = change(owner())
        .putAssoc("leaves", [{ id: 1, name: "two" }] as never)
        .validate(() => [{ path: ["leaves", 0, "ownerId"], message: "is odd" }], { scope: "changed" });
      expect(cs.valid).toBe(true);
    });

    test("a field's name planted with the value given is still a change of a new record", () => {
      plant("title", "x");
      expect(cast(Owner, { title: "x" }, ["title"]).changes).toEqual({ title: "x" });
    });

    test("an association's name planted as loaded and empty is still not preloaded", () => {
      plant("leaves", []);
      const bare = loaded(Owner, { id: 7, title: null });
      expect(() => change(bare).putAssoc("leaves", [])).toThrow(NotLoadedError);
    });

    test("a to-one association's name planted as null is still not preloaded", () => {
      class Lamp extends Schema("lamps", { id: t.integer().primaryKey(), deskId: t.integer().nullable() }) {}
      class Desk extends Schema("desks", { id: t.integer().primaryKey() }) {
        static lamp = hasOne(() => Lamp, { foreignKey: "deskId", onReplace: "delete" });
      }
      plant("lamp", null);
      expect(() => change(loaded(Desk, { id: 1 })).putAssoc("lamp", null)).toThrow(NotLoadedError);
    });
  });
});

describe("mass assignment", () => {
  test("only permitted fields change; associations, embeds and virtual fields need their own call", () => {
    const params = { email: "a@b.c", role: "admin", id: 99, passwordHash: "x", lockVersion: 5, posts: [{}] };
    const cs = cast(User, params, ["email"]);
    expect(cs.changes).toEqual({ email: "a@b.c" });
    // A nested relation is read only by castAssoc / castEmbed, never by cast().
    expect(() => cast(Board, { notes: [{ text: "x" }] }, ["notes" as never])).toThrow(QueryError);
    expect(cast(Board, { notes: [{ text: "x" }] }, []).changes).toEqual({});
  });

  test("getters: only permitted keys are read, each once; a throwing getter's own error surfaces", () => {
    const reads: string[] = [];
    const params = {
      get email() {
        reads.push("email");
        return "a@b.c";
      },
      get role() {
        reads.push("role");
        throw new Error("never read");
      },
    };
    expect(cast(User, params, ["email"]).changes).toEqual({ email: "a@b.c" });
    expect(reads).toEqual(["email"]);
    expect(() => cast(User, params, ["role"])).toThrow("never read");
  });

  test("symbol keys are ignored, and values that are not of the field's type are cast errors", () => {
    const sym = Symbol("email");
    expect(cast(User, { [sym]: "a@b.c" }, ["email"]).changes).toEqual({});
    let called = 0;
    const sneaky = {
      valueOf: () => {
        called++;
        return 1;
      },
      toString: () => {
        called++;
        return "a@b.c";
      },
      [Symbol.toPrimitive]: () => {
        called++;
        return 1;
      },
    };
    for (const field of ["email", "age", "role", "createdAt"] as const) {
      const cs = cast(User, { [field]: sneaky }, [field]);
      expect(cs.valid).toBe(false);
    }
    expect(cast(User, { email: sym }, ["email"]).valid).toBe(false);
    expect(called).toBe(0);
  });
});

describe("size: work grows with what is permitted, not with what is sent", () => {
  /** Params of `size` keys behind a proxy that counts how they are read. */
  function counted(size: number, extra: Readonly<Record<string, unknown>>) {
    const target: Record<string, unknown> = {};
    for (let i = 0; i < size; i++) target[`k${i}`] = i;
    Object.assign(target, extra);
    const count = { get: 0, own: 0, keys: 0 };
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        count.get++;
        return Reflect.get(t, key, receiver);
      },
      getOwnPropertyDescriptor(t, key) {
        count.own++;
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      ownKeys(t) {
        count.keys++;
        return Reflect.ownKeys(t);
      },
    });
    return { proxy, count };
  }

  test("cast() of a million keys reads only the permitted ones", () => {
    const { proxy, count } = counted(1_000_000, { email: "a@b.c" });
    const cs = cast(User, proxy, ["email", "name"]);
    expect(cs.changes).toEqual({ email: "a@b.c" });
    expect(count.keys).toBe(0);
    expect(count.get).toBeLessThanOrEqual(2);
    expect(count.own).toBeLessThanOrEqual(2);
  });

  test("long values are refused before they are parsed, or parsed in one pass", () => {
    const digits = "9".repeat(5_000_000);
    expect(cast(User, { age: digits }, ["age"]).valid).toBe(false);
    expect(cast(User, { id: digits }, ["id"]).valid).toBe(false);
    // A decimal has no length limit, and its grammar has no backtracking (see redos.test.ts).
    expect(cast(Board, { amount: `${digits}.${digits}` }, ["amount"]).valid).toBe(true);
    expect(cast(Board, { amount: `${digits}x` }, ["amount"]).valid).toBe(false);
  });

  test("a JSON document deeper than 500 levels is refused without exhausting the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const cs = cast(Board, { doc: deep }, ["doc"]);
    expect(cs.valid).toBe(false);
    let ok: unknown = 1;
    for (let i = 0; i < 400; i++) ok = { a: ok };
    expect(cast(Board, { doc: ok }, ["doc"]).valid).toBe(true);
  });

  test("castAssoc matches many items against many loaded children with a linear number of key reads", () => {
    const m = 4_000;
    const n = 8_000;
    let reads = 0;
    // Each loaded child counts the reads of its key.
    const existing = Array.from({ length: m }, (_, i) => {
      const row = loaded(Leaf, { id: i + 1, ownerId: 1, name: "old" });
      return new Proxy(row, {
        get(target, key, receiver) {
          if (key === "id") reads++;
          return Reflect.get(target, key, receiver);
        },
      });
    });
    const owner = loaded(Owner, { id: 1 }, { leaves: existing });
    // Half the items update existing children, half are new: every lookup is made.
    const items = Array.from({ length: n }, (_, i) => ({ id: i < m / 2 ? i + 1 : m + i + 1, name: "new" }));
    const cs = cast(owner, { leaves: items }, []).castAssoc("leaves");
    const children = (cs.changes as { leaves: readonly { action: string }[] }).leaves;
    expect(children.filter((child) => child.action === "update")).toHaveLength(m / 2);
    expect(children.filter((child) => child.action === "insert")).toHaveLength(n - m / 2);
    expect(children.filter((child) => child.action === "delete")).toHaveLength(m / 2);
    // One scan per item would read m * n = 32,000,000 keys.
    expect(reads).toBeLessThan(20 * (m + n));
  });

  test("castEmbed of many items is linear too, and keeps their order", () => {
    const notes = Array.from({ length: 50_000 }, (_, i) => ({ text: `n${i}` }));
    const cs = cast(Board, { notes }, []).castEmbed("notes");
    const children = (cs.changes as { notes: readonly { changes: { text: string } }[] }).notes;
    expect(children).toHaveLength(50_000);
    expect(children[49_999]?.changes.text).toBe("n49999");
  });
});

describe("keyFinder finds what a scan finds", () => {
  const leafKey = [meta(Leaf).fieldsByName.get("id") as FieldMeta];
  // A composite key of two integers, and a key whose type does not compare with Object.is.
  class Pair extends Schema("pairs", { a: t.integer().primaryKey(), b: t.string().primaryKey() }) {}
  class Priced extends Schema("priced", { price: t.decimal().primaryKey() }) {}
  const pairKey = meta(Pair).primaryKey;
  const priceKey = meta(Priced).primaryKey;

  const value = fc.oneof(
    fc.integer({ min: -3, max: 40 }),
    fc.constantFrom(-0, 0, Number.NaN, null),
    fc.constantFrom("1", "x", ""),
  );

  test("one key field, many rows (indexed), few rows (scanned)", () => {
    fc.assert(
      fc.property(fc.array(value, { maxLength: 60 }), fc.array(value, { maxLength: 20 }), (ids, probes) => {
        const rows = ids.map((id) => ({ id }));
        const find = keyFinder(rows, leafKey);
        for (const probe of probes) {
          if (probe === null) continue;
          expect(find([probe])).toBe(indexOfKey(rows, leafKey, [probe]));
        }
      }),
      { numRuns: 1_000 },
    );
  });

  test("a composite key", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(value, value), { minLength: 16, maxLength: 60 }),
        fc.array(fc.tuple(value, value), { maxLength: 20 }),
        (pairs, probes) => {
          const rows = pairs.map(([a, b]) => ({ a, b }));
          const find = keyFinder(rows, pairKey);
          for (const [a, b] of probes) {
            if (a === null || b === null) continue;
            expect(find([a, b])).toBe(indexOfKey(rows, pairKey, [a, b]));
          }
        },
      ),
      { numRuns: 1_000 },
    );
  });

  test("a key type with its own equality is scanned: 1.50 finds 1.5", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ price: `${i}.5` }));
    expect(keyFinder(rows, priceKey)(["3.50"])).toBe(3);
    // Without a key nothing is matched (keyOf gives no key); the finder agrees with the scan anyway.
    expect(keyFinder(rows, [])([])).toBe(indexOfKey(rows, [], []));
  });
});
