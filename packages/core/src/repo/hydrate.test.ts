// Unit tests for row hydration: the decoder of every output-plan shape, generated and
// interpreted, and a property test that the two always build the same values.
import { Comment, Membership, Post, Profile, Tag, User } from "@egon-orm/test-support";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { typeOverridesFrom } from "../adapter/codecs.js";
import type { CompiledQuery, OutputPlan, RowDecoder } from "../contracts/adapter.js";
import { ROW, type SchemaMeta } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { CastError } from "../errors.js";
import { meta, Schema, t } from "../schema/index.js";
import { defineType } from "../types/define.js";
import { bigintType, integerType, stringType } from "../types/index.js";
import {
  buildDecoder,
  type CodecSource,
  canGenerate,
  decodeRows,
  decoderFor,
  generateDecoder,
  generationAllowed,
  interpretDecoder,
} from "./hydrate.js";

/** No driver fixes: every type's own conversions apply. */
const codecs: CodecSource = { typeOverrides: () => undefined };

type RowLeaf = Extract<OutputPlan, { readonly kind: "row" }>;

/** A row leaf reading `meta`'s columns from `c<offset>`, `c<offset+1>`, … */
function rowLeaf(schemaMeta: SchemaMeta, offset: number, extra: Partial<RowLeaf> = {}): RowLeaf {
  const aliases = schemaMeta.persisted.map((_, i) => `c${offset + i}`);
  const key = schemaMeta.primaryKey.map((field) => aliases[schemaMeta.persisted.indexOf(field)] as string);
  return {
    kind: "row",
    meta: schemaMeta,
    aliases,
    key,
    schema: undefined,
    nullable: false,
    preloads: [],
    ...extra,
  };
}

/** A raw result row for `meta` from `c<offset>`: the given values by field name, the rest null. */
function rawRow(
  schemaMeta: SchemaMeta,
  offset: number,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  schemaMeta.persisted.forEach((field, i) => {
    out[`c${offset + i}`] = Object.hasOwn(values, field.name) ? values[field.name] : null;
  });
  return out;
}

const both = (plan: OutputPlan): readonly [string, RowDecoder][] => [
  ["generated", generateDecoder(plan, codecs)],
  ["interpreted", interpretDecoder(plan, codecs)],
];

/** Counts calls; wraps the value so a conversion is visible. */
const counted = vi.fn((stored: unknown) => `<${String(stored)}>`);
const Wrapped = defineType<string, string>({
  name: "wrapped",
  db: { kind: "text" },
  cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
  fromDb: (stored) => counted(stored),
  toDb: (value) => value,
});

const USER = meta(User);
const POST = meta(Post);

describe("value leaves", () => {
  test.for(["generated", "interpreted"] as const)("a column without a type is read as it is (%s)", (kind) => {
    const plan: OutputPlan = { kind: "value", alias: "c0", type: undefined };
    const decode = kind === "generated" ? generateDecoder(plan, codecs) : interpretDecoder(plan, codecs);
    const value = { any: "object" };
    expect(decode({ c0: value }, [])).toBe(value);
    expect(decode({ c0: null }, [])).toBeNull();
  });

  test("a type whose conversion is the identity is not called", () => {
    // The string type's fromDb is IDENTITY: the decoder reads the column and returns it.
    const plan: OutputPlan = { kind: "value", alias: "c0", type: stringType() as AnyFieldType };
    for (const [, decode] of both(plan)) expect(decode({ c0: "x" }, [])).toBe("x");
    expect(generateDecoder(plan, codecs).toString()).not.toContain("f0");
  });

  test("a converting type is applied to non-null values only", () => {
    counted.mockClear();
    const plan: OutputPlan = { kind: "value", alias: "c0", type: Wrapped as AnyFieldType };
    for (const [, decode] of both(plan)) {
      expect(decode({ c0: "a" }, [])).toBe("<a>");
      expect(decode({ c0: null }, [])).toBeNull();
    }
    expect(counted).toHaveBeenCalledTimes(2);
  });

  test("the adapter's driver fix is composed with the type's conversion", () => {
    // As a dialect declares it: the driver sends int8 as text.
    const withFix: CodecSource = {
      typeOverrides: typeOverridesFrom({ bigint: { fromDb: (value) => BigInt(value as string) } }),
    };
    const plan: OutputPlan = {
      kind: "value",
      alias: "c0",
      type: bigintType({ mode: "number" }) as AnyFieldType,
    };
    expect(generateDecoder(plan, withFix)({ c0: "42" }, [])).toBe(42);
    expect(interpretDecoder(plan, withFix)({ c0: "42" }, [])).toBe(42);
  });

  test("a conversion that fails throws its error", () => {
    const plan: OutputPlan = {
      kind: "value",
      alias: "c0",
      type: bigintType({ mode: "number" }) as AnyFieldType,
    };
    for (const [, decode] of both(plan)) expect(() => decode({ c0: 2n ** 60n }, [])).toThrow(CastError);
  });

  test("a constant comes from the executed query's constants", () => {
    const plan: OutputPlan = { kind: "constant", index: 1 };
    for (const [, decode] of both(plan)) expect(decode({}, ["a", "b"])).toBe("b");
  });
});

describe("objects and tuples", () => {
  const plan: OutputPlan = {
    kind: "object",
    keys: ["z", "a", "nested", "pair"],
    values: [
      { kind: "value", alias: "c0", type: undefined },
      { kind: "constant", index: 0 },
      {
        kind: "object",
        keys: ["deep"],
        values: [{ kind: "value", alias: "c1", type: Wrapped as AnyFieldType }],
      },
      {
        kind: "tuple",
        items: [
          { kind: "value", alias: "c2", type: undefined },
          { kind: "value", alias: "c0", type: undefined },
        ],
      },
    ],
  };

  test.for(["generated", "interpreted"] as const)(
    "keep their keys in order and build fresh values (%s)",
    (kind) => {
      const decode = kind === "generated" ? generateDecoder(plan, codecs) : interpretDecoder(plan, codecs);
      const row = { c0: 1, c1: "x", c2: null };
      const a = decode(row, ["k"]) as Record<string, unknown>;
      const b = decode(row, ["k"]) as Record<string, unknown>;
      expect(a).toStrictEqual({ z: 1, a: "k", nested: { deep: "<x>" }, pair: [null, 1] });
      expect(Object.keys(a)).toEqual(["z", "a", "nested", "pair"]);
      expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
      expect(Array.isArray(a.pair)).toBe(true);
      expect(a).not.toBe(b);
      expect(a.nested).not.toBe(b.nested);
    },
  );

  test("a key named __proto__ is an own property, not the prototype", () => {
    const proto: OutputPlan = {
      kind: "object",
      keys: ["__proto__", "b"],
      values: [
        { kind: "value", alias: "c0", type: undefined },
        { kind: "value", alias: "c1", type: undefined },
      ],
    };
    for (const [, decode] of both(proto)) {
      const value = decode({ c0: { polluted: true }, c1: 2 }, []) as Record<string, unknown>;
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.keys(value)).toEqual(["__proto__", "b"]);
      expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ polluted: true });
    }
  });

  test("names from the plan cannot become code", () => {
    const hostile = 'x"]; globalThis.hacked = true; ["';
    // A template literal's interpolation, and a backslash, as plain text.
    const interpolation = `\`$${"{"}globalThis.hacked = 1}\``;
    const backslash = `\`$${"{"}1}\`\\`;
    const separators = "\u2028line\u2029";
    const plan2: OutputPlan = {
      kind: "object",
      keys: [hostile, interpolation, separators],
      values: [
        { kind: "value", alias: hostile, type: undefined },
        { kind: "value", alias: backslash, type: undefined },
        { kind: "value", alias: separators, type: undefined },
      ],
    };
    const decode = generateDecoder(plan2, codecs);
    const row = { [hostile]: 1, [backslash]: 2, [separators]: 3 };
    expect(decode(row, [])).toEqual({ [hostile]: 1, [interpolation]: 2, [separators]: 3 });
    expect((globalThis as { hacked?: unknown }).hacked).toBeUndefined();
  });
});

describe("row leaves", () => {
  const ada = {
    id: 1,
    email: "ada@example.com",
    name: "Ada",
    age: 36,
    role: "admin",
    passwordHash: null,
    settings: null,
    lockVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  test.for(["generated", "interpreted"] as const)(
    "build instances of the class, marked loaded (%s)",
    (kind) => {
      const plan = rowLeaf(USER, 0, { schema: "tenant_1" });
      const decode = kind === "generated" ? generateDecoder(plan, codecs) : interpretDecoder(plan, codecs);
      const user = decode(rawRow(USER, 0, ada), []) as User;
      expect(user).toBeInstanceOf(User);
      expect(user.displayName).toBe("Ada");
      expect(user.password).toBeUndefined();
      expect(Object.keys(user)).toEqual(USER.fields.map((field) => field.name));
      const marker = (user as unknown as { [ROW]: unknown })[ROW];
      expect(marker).toBe(USER.rowMeta("loaded", "tenant_1"));
      // Two rows share one marker.
      expect((decode(rawRow(USER, 0, ada), []) as unknown as { [ROW]: unknown })[ROW]).toBe(marker);
    },
  );

  test("a nullable leaf is null when its key columns are all null, a row otherwise", () => {
    const plan = rowLeaf(meta(Membership), 0, { nullable: true });
    for (const [, decode] of both(plan)) {
      expect(decode({ c0: null, c1: null, c2: "member" }, [])).toBeNull();
      const half = decode({ c0: "org", c1: null, c2: null }, []);
      expect(half).toBeInstanceOf(Membership);
      expect((half as Membership).userId).toBeNull();
    }
  });

  test("a nullable leaf of a keyless schema is null only when every column is null", () => {
    class Note extends Schema(
      "notes",
      { body: t.string().nullable(), tag: t.string().nullable() },
      { primaryKey: false },
    ) {}
    const plan = rowLeaf(meta(Note), 0, { nullable: true });
    expect(plan.key).toEqual([]);
    for (const [, decode] of both(plan)) {
      expect(decode({ c0: null, c1: null }, [])).toBeNull();
      expect(decode({ c0: null, c1: "x" }, [])).toBeInstanceOf(Note);
    }
  });

  test("a non-nullable leaf is a row even with every column null", () => {
    const plan = rowLeaf(meta(Tag), 0);
    for (const [, decode] of both(plan)) expect(decode({ c0: null, c1: null }, [])).toBeInstanceOf(Tag);
  });

  test("field conversions are applied, null skipped", () => {
    class Coded extends Schema("coded", { id: t.integer().primaryKey(), code: t.type(Wrapped).nullable() }) {}
    const plan = rowLeaf(meta(Coded), 0);
    for (const [, decode] of both(plan)) {
      expect((decode({ c0: 1, c1: "a" }, []) as Coded).code).toBe("<a>");
      expect((decode({ c0: 1, c1: null }, []) as Coded).code).toBeNull();
    }
  });

  test("join preloads put the child of this row in place; separate ones start empty", () => {
    const posts = rowLeaf(POST, USER.persisted.length, { nullable: true });
    const plan = rowLeaf(USER, 0, {
      preloads: [
        { assoc: "posts", cardinality: "many", row: posts },
        { assoc: "profile", cardinality: "one", row: rowLeaf(meta(Profile), 100, { nullable: true }) },
        { assoc: "memberships", cardinality: "many", row: undefined },
        { assoc: "orgs", cardinality: "one", row: undefined },
      ],
    });
    const post = { id: 5, authorId: 1, title: "T", createdAt: new Date(0), updatedAt: new Date(0) };
    for (const [, decode] of both(plan)) {
      const withChild = decode(
        {
          ...rawRow(USER, 0, ada),
          ...rawRow(POST, USER.persisted.length, post),
          ...rawRow(meta(Profile), 100, {}),
        },
        [],
      ) as Record<string, unknown>;
      expect(withChild).toBeInstanceOf(User);
      expect(Object.keys(withChild).slice(-4)).toEqual(["posts", "profile", "memberships", "orgs"]);
      expect(withChild.posts).toHaveLength(1);
      expect((withChild.posts as unknown[])[0]).toBeInstanceOf(Post);
      expect(withChild.profile).toBeNull();
      expect(withChild.memberships).toEqual([]);
      expect(withChild.orgs).toBeNull();
      const without = decode(
        {
          ...rawRow(USER, 0, ada),
          ...rawRow(POST, USER.persisted.length, {}),
          ...rawRow(meta(Profile), 100, { id: 9, userId: 1 }),
        },
        [],
      ) as Record<string, unknown>;
      expect(without.posts).toEqual([]);
      expect(without.profile).toBeInstanceOf(Profile);
    }
  });

  test("a nested join preload: comments of the joined post", () => {
    const offset = USER.persisted.length;
    const comments = rowLeaf(meta(Comment), 200, { nullable: true });
    const posts = rowLeaf(POST, offset, {
      nullable: true,
      preloads: [{ assoc: "comments", cardinality: "many", row: comments }],
    });
    const plan = rowLeaf(USER, 0, { preloads: [{ assoc: "posts", cardinality: "many", row: posts }] });
    const raw = {
      ...rawRow(USER, 0, ada),
      ...rawRow(POST, offset, { id: 5, authorId: 1 }),
      ...rawRow(meta(Comment), 200, { id: 7, postId: 5, body: "hi" }),
    };
    const [generated, interpreted] = both(plan).map(([, decode]) => decode(raw, []));
    expect(generated).toStrictEqual(interpreted);
    const post = ((generated as Record<string, unknown>).posts as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >;
    expect((post.comments as unknown[])[0]).toBeInstanceOf(Comment);
  });
});

describe("building and caching", () => {
  test("decoderFor builds the decoder once and keeps it on the plan", () => {
    const plan: CompiledQuery = {
      sql: "select 1",
      slots: [],
      output: { kind: "value", alias: "c0", type: undefined },
      schema: undefined,
      decoder: undefined,
    };
    const decoder = decoderFor(plan, codecs, true);
    expect(plan.decoder).toBe(decoder);
    expect(decoderFor(plan, codecs, false)).toBe(decoder);
  });

  test("decoderFor refuses a plan without an output", () => {
    const plan: CompiledQuery = {
      sql: "select 1",
      slots: [],
      output: undefined,
      schema: undefined,
      decoder: undefined,
    };
    expect(() => decoderFor(plan, codecs, true)).toThrow(TypeError);
  });

  test("code generation is detected, and its absence too", () => {
    expect(canGenerate((body) => new Function(body) as () => unknown)).toBe(true);
    expect(
      canGenerate(() => {
        throw new EvalError("Code generation from strings disallowed for this context");
      }),
    ).toBe(false);
    expect(canGenerate(() => () => false)).toBe(false);
  });

  test("buildDecoder generates code only when asked to and allowed", () => {
    const plan: OutputPlan = { kind: "value", alias: "c0", type: undefined };
    expect(generationAllowed()).toBe(true);
    expect(buildDecoder(plan, codecs, true).name).toBe("decode");
    expect(buildDecoder(plan, codecs, false).name).not.toBe("decode");
  });

  test("buildDecoder with codegen off never calls new Function", () => {
    const original = globalThis.Function;
    const spy = vi.fn();
    globalThis.Function = new Proxy(original, {
      construct(target, args) {
        spy();
        return Reflect.construct(target, args);
      },
    });
    try {
      buildDecoder(rowLeaf(USER, 0), codecs, false);
    } finally {
      globalThis.Function = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test("code generation is probed only when a decoder is generated, and once", async () => {
    vi.resetModules();
    const original = globalThis.Function;
    const constructed = vi.fn();
    globalThis.Function = new Proxy(original, {
      construct(target, args) {
        constructed(args[args.length - 1]);
        return Reflect.construct(target, args);
      },
    });
    try {
      const fresh = await import("./hydrate.js");
      fresh.buildDecoder(rowLeaf(USER, 0), codecs, false);
      expect(constructed).not.toHaveBeenCalled();
      fresh.buildDecoder(rowLeaf(USER, 0), codecs, true);
      // The probe, then the decoder.
      expect(constructed.mock.calls.map(([body]) => body === "return true")).toEqual([true, false]);
      fresh.buildDecoder(rowLeaf(USER, 0), codecs, true);
      expect(constructed).toHaveBeenCalledTimes(3);
    } finally {
      globalThis.Function = original;
    }
  });

  test("decodeRows decodes into a fresh array", () => {
    const decode = generateDecoder(
      { kind: "value", alias: "c0", type: integerType() as AnyFieldType },
      codecs,
    );
    const rows = [{ c0: 1 }, { c0: 2 }];
    const out = decodeRows(rows, decode, []);
    expect(out).toEqual([1, 2]);
    expect(out).not.toBe(rows);
    expect(decodeRows([], decode, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Generated and interpreted decoders are equivalent
// ---------------------------------------------------------------------------

/** Every value the decoders can build, written out with prototypes, key order and row markers. */
function describeValue(value: unknown, markers: Map<unknown, number>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return ["array", value.map((item) => describeValue(item, markers))];
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  const entries = Object.keys(value).map((key) => [
    key,
    describeValue((value as Record<string, unknown>)[key], markers),
  ]);
  const marker = (value as { [ROW]?: unknown })[ROW];
  let markerId: number | undefined;
  if (marker !== undefined) {
    markerId = markers.get(marker);
    if (markerId === undefined) {
      markerId = markers.size;
      markers.set(marker, markerId);
    }
  }
  return [proto?.constructor?.name ?? "null", entries, markerId];
}

const SCHEMAS: readonly SchemaMeta[] = [
  USER,
  POST,
  meta(Membership),
  meta(Tag),
  meta(Comment),
  meta(Profile),
];
const CONVERTERS: readonly (AnyFieldType | undefined)[] = [
  undefined,
  stringType() as AnyFieldType,
  Wrapped as AnyFieldType,
];

interface Generated {
  readonly plan: OutputPlan;
  readonly aliases: readonly string[];
}

/** A row leaf of `schemaMeta` over fresh aliases. */
function rowOf(
  schemaMeta: SchemaMeta,
  nullable: boolean,
  next: () => string,
): Generated & { readonly plan: RowLeaf } {
  const aliases = schemaMeta.persisted.map(() => next());
  const key = schemaMeta.primaryKey.map((field) => aliases[schemaMeta.persisted.indexOf(field)] as string);
  return {
    plan: { kind: "row", meta: schemaMeta, aliases, key, schema: undefined, nullable, preloads: [] },
    aliases,
  };
}

/**
 * Names that are dangerous in generated code or in an object literal: quotes, backticks,
 * an interpolation, a backslash, line breaks and the two JavaScript line separators,
 * `__proto__`, `constructor`, code-like text, the empty string.
 */
const HOSTILE: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  'a"b',
  "a'b",
  "`x`",
  `$${"{"}globalThis.hacked = 1}`,
  "\\",
  "line\nbreak",
  "\u2028",
  "\u2029",
  '"]; globalThis.hacked = 1; //',
  "}; return 1; {",
  "",
  "toString",
  "hasOwnProperty",
];

/** A random output plan over fresh aliases. */
function planArbitrary(): fc.Arbitrary<(next: () => string) => Generated> {
  const leaf = fc.oneof(
    fc.constantFrom(...CONVERTERS).map((type) => (next: () => string): Generated => {
      const alias = next();
      return { plan: { kind: "value", alias, type }, aliases: [alias] };
    }),
    fc.nat({ max: 3 }).map((index) => (): Generated => ({ plan: { kind: "constant", index }, aliases: [] })),
    fc
      .record({
        schema: fc.nat({ max: SCHEMAS.length - 1 }),
        nullable: fc.boolean(),
        preload: fc.constantFrom("none", "separate", "join"),
        child: fc.record({ schema: fc.nat({ max: SCHEMAS.length - 1 }), nullable: fc.boolean() }),
      })
      .map(({ schema, nullable, preload, child }) => (next: () => string): Generated => {
        const made = rowOf(SCHEMAS[schema] as SchemaMeta, nullable, next);
        const first = [...made.plan.meta.assocs().values()][0];
        if (preload === "none" || first === undefined) return made;
        const cardinality =
          first.kind === "hasMany" || first.kind === "manyToMany" ? ("many" as const) : ("one" as const);
        if (preload === "separate") {
          return {
            plan: { ...made.plan, preloads: [{ assoc: first.name, cardinality, row: undefined }] },
            aliases: made.aliases,
          };
        }
        const joined = rowOf(SCHEMAS[child.schema] as SchemaMeta, child.nullable, next);
        return {
          plan: { ...made.plan, preloads: [{ assoc: first.name, cardinality, row: joined.plan }] },
          aliases: [...made.aliases, ...joined.aliases],
        };
      }),
  );
  const tree = fc.letrec((tie) => ({
    node: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("object"), tie("tuple")),
    object: fc
      .array(fc.tuple(fc.oneof(fc.constantFrom(...HOSTILE), fc.string({ maxLength: 6 })), tie("node")), {
        maxLength: 4,
      })
      .map((entries) => (next: () => string): Generated => {
        const seen = new Set<string>();
        const keys: string[] = [];
        const values: OutputPlan[] = [];
        const aliases: string[] = [];
        for (const [key, make] of entries as [string, (n: () => string) => Generated][]) {
          if (seen.has(key)) continue;
          seen.add(key);
          const built = make(next);
          keys.push(key);
          values.push(built.plan);
          aliases.push(...built.aliases);
        }
        return { plan: { kind: "object", keys, values }, aliases };
      }),
    tuple: fc.array(tie("node"), { maxLength: 3 }).map((items) => (next: () => string): Generated => {
      const built = (items as ((n: () => string) => Generated)[]).map((make) => make(next));
      return {
        plan: { kind: "tuple", items: built.map((each) => each.plan) },
        aliases: built.flatMap((each) => each.aliases),
      };
    }),
  }));
  return tree.node as fc.Arbitrary<(next: () => string) => Generated>;
}

/** What a decoder did with a row: its value, or the error it threw (by class and message). */
function outcome(
  decode: RowDecoder,
  row: Readonly<Record<string, unknown>>,
  constants: readonly unknown[],
): { readonly failed: boolean; readonly value: unknown } {
  try {
    return { failed: false, value: decode(row, constants) };
  } catch (error) {
    return { failed: true, value: error instanceof Error ? [error.name, error.message] : error };
  }
}

describe("generated and interpreted decoders are equivalent", () => {
  test("on random plans and rows", () => {
    fc.assert(
      fc.property(
        planArbitrary(),
        fc.array(fc.oneof(fc.constant(null), fc.integer(), fc.string(), fc.boolean()), {
          minLength: 64,
          maxLength: 64,
        }),
        fc.array(fc.anything(), { minLength: 4, maxLength: 4 }),
        fc.nat({ max: HOSTILE.length - 1 }),
        (make, cells, constants, shift) => {
          // The first aliases are the hostile names, in a random rotation; then c<n>.
          let n = 0;
          const next = (): string => {
            const i = n++;
            return i < HOSTILE.length ? (HOSTILE[(i + shift) % HOSTILE.length] as string) : `c${i}`;
          };
          const { plan, aliases } = make(next);
          // Own properties only, `__proto__` included.
          const row = Object.fromEntries(aliases.map((alias, i) => [alias, cells[i % cells.length]]));
          const generated = outcome(generateDecoder(plan, codecs), row, constants);
          const interpreted = outcome(interpretDecoder(plan, codecs), row, constants);
          expect(generated.failed).toBe(interpreted.failed);
          // Not toStrictEqual: it compares `constructor` properties by identity, and a key named
          // "constructor" holds two equal but distinct objects. describeValue checks prototypes.
          expect(generated.value).toEqual(interpreted.value);
          const markers = new Map<unknown, number>();
          expect(describeValue(generated.value, markers)).toEqual(describeValue(interpreted.value, markers));
          expect((globalThis as { hacked?: unknown }).hacked).toBeUndefined();
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
