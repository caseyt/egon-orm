import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { META, ROW } from "../contracts/schema.js";
import { formatStruct, formatValue, REDACTED, redactFields } from "./inspect.js";

const SECRET = "s3cr3t-value";

describe("redactFields", () => {
  test("replaces the redacted values and keeps the rest, in the same order", () => {
    const row = { id: 1, email: "a@b.c", passwordHash: SECRET, token: SECRET };
    const out = redactFields(row, new Set(["passwordHash", "token"]));
    expect(out).toEqual({ id: 1, email: "a@b.c", passwordHash: REDACTED, token: REDACTED });
    expect(Object.keys(out)).toEqual(["id", "email", "passwordHash", "token"]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test("returns a copy and leaves the input alone", () => {
    const row = { passwordHash: SECRET };
    const out = redactFields(row, new Set(["passwordHash"]));
    expect(out).not.toBe(row);
    expect(row.passwordHash).toBe(SECRET);
  });

  test("redacts a key even when its value is null or undefined", () => {
    expect(redactFields({ a: null, b: undefined }, new Set(["a", "b"]))).toEqual({
      a: REDACTED,
      b: REDACTED,
    });
  });

  test("ignores redacted keys that are absent, inherited or symbol-keyed", () => {
    const base = { inherited: SECRET };
    const row = Object.assign(Object.create(base) as Record<string | symbol, unknown>, {
      id: 1,
      [Symbol("s")]: 2,
    });
    expect(redactFields(row, new Set(["inherited", "missing"]))).toEqual({ id: 1 });
  });

  test("with nothing redacted it is a shallow copy", () => {
    const nested = { deep: true };
    const out = redactFields({ nested }, new Set());
    expect(out).toEqual({ nested });
    expect(out.nested).toBe(nested);
  });
});

describe("an own __proto__ key (as JSON.parse produces)", () => {
  const parsed = (): object =>
    JSON.parse('{"id":1,"__proto__":{"isAdmin":true},"token":"s3cr3t-value"}') as object;

  test("redactFields keeps it as an own key and leaves the copy's prototype alone", () => {
    const out = redactFields(parsed(), new Set(["token"]));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { isAdmin?: unknown }).isAdmin).toBeUndefined();
    expect(Object.keys(out)).toEqual(["id", "__proto__", "token"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ isAdmin: true });
    expect(JSON.stringify(out)).toBe('{"id":1,"__proto__":{"isAdmin":true},"token":"**redacted**"}');
  });

  test("it can itself be redacted", () => {
    const redacted = redactFields(parsed(), new Set(["__proto__"]));
    expect(Object.getOwnPropertyDescriptor(redacted, "__proto__")?.value).toBe(REDACTED);
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });

  test("the formatters print it as an ordinary key", () => {
    expect(formatValue(parsed())).toBe('{ id: 1, __proto__: { isAdmin: true }, token: "s3cr3t-value" }');
    expect(formatStruct("Row", parsed(), new Set(["token"]))).toBe(
      "Row { id: 1, __proto__: { isAdmin: true }, token: **redacted** }",
    );
  });
});

describe("formatValue", () => {
  test.each([
    ["ada", '"ada"'],
    ['say "hi"\n', '"say \\"hi\\"\\n"'],
    ["", '""'],
    [42, "42"],
    [-0, "-0"],
    [0, "0"],
    [1.5, "1.5"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [10n, "10n"],
    [true, "true"],
    [false, "false"],
    [undefined, "undefined"],
    [null, "null"],
    [Symbol("tag"), "Symbol(tag)"],
    [new Date(0), "1970-01-01T00:00:00.000Z"],
    [new Date(Number.NaN), "Invalid Date"],
    [new Uint8Array([1, 2, 3]), "<Uint8Array 3 bytes>"],
    [Buffer.from("abcd"), "<Buffer 4 bytes>"],
    [[], "[]"],
    [[1, "a", null], '[1, "a", null]'],
    [{}, "{}"],
    [{ id: 1, tags: ["a", "b"] }, '{ id: 1, tags: ["a", "b"] }'],
    [{ "not an identifier": 1, $ok: 2, _x: 3 }, '{ "not an identifier": 1, $ok: 2, _x: 3 }'],
    [Object.create(null), "{}"],
    [Object.assign(Object.create(null) as object, { a: 1 }), "{ a: 1 }"],
  ])("%o -> %s", (value, expected) => {
    expect(formatValue(value)).toBe(expected);
  });

  test("names functions and classes", () => {
    function named() {}
    expect(formatValue(named)).toBe("[Function: named]");
    expect(formatValue(() => {})).toBe("[Function]");
    class Point {
      x = 1;
      y = 2;
    }
    expect(formatValue(new Point())).toBe("Point { x: 1, y: 2 }");
    class Empty {}
    expect(formatValue(new Empty())).toBe("Empty {}");
    expect(formatValue(new Map([[1, 2]]))).toBe("Map {}");
  });

  test("falls back to Object for a prototype without a usable constructor", () => {
    expect(formatValue(Object.create({ constructor: undefined }))).toBe("Object {}");
    expect(formatValue(Object.assign(Object.create({ constructor: {} }) as object, { a: 1 }))).toBe(
      "Object { a: 1 }",
    );
  });

  test("cuts long strings and says how long they were", () => {
    const long = "x".repeat(101);
    expect(formatValue(long)).toBe(`"${"x".repeat(100)}"… (101 characters)`);
    expect(formatValue("x".repeat(100))).toBe(`"${"x".repeat(100)}"`);
  });

  test("shows at most 20 entries of an array or an object", () => {
    const array = Array.from({ length: 23 }, (_, i) => i);
    expect(formatValue(array)).toBe(`[${array.slice(0, 20).join(", ")}, … 3 more]`);
    expect(formatValue(array.slice(0, 20))).toBe(`[${array.slice(0, 20).join(", ")}]`);
    const object = Object.fromEntries(array.map((i) => [`k${i}`, i]));
    expect(formatValue(object)).toBe(
      `{ ${array
        .slice(0, 20)
        .map((i) => `k${i}: ${i}`)
        .join(", ")}, … 3 more }`,
    );
  });

  test("abbreviates below three levels of nesting", () => {
    class Leaf {
      v = 1;
    }
    expect(formatValue({ a: { b: { c: { d: 1 } } } })).toBe("{ a: { b: { c: [Object] } } }");
    expect(formatValue([[[[1]]]])).toBe("[[[[Array]]]]");
    expect(formatValue({ a: { b: { c: new Leaf() } } })).toBe("{ a: { b: { c: [Leaf] } } }");
    expect(formatValue({ a: { b: { c: 1, d: "s", e: null } } })).toBe(
      '{ a: { b: { c: 1, d: "s", e: null } } }',
    );
  });

  test("marks cycles, and shows a shared object every time it appears", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(formatValue(cyclic)).toBe('{ name: "loop", self: [Circular] }');
    const ring: unknown[] = [];
    ring.push(ring);
    expect(formatValue(ring)).toBe("[[Circular]]");
    const shared = { n: 1 };
    expect(formatValue([shared, shared])).toBe("[{ n: 1 }, { n: 1 }]");
    expect(formatValue({ a: shared, b: [shared] })).toBe("{ a: { n: 1 }, b: [{ n: 1 }] }");
  });

  test("does not call toString, toJSON or valueOf defined by the value", () => {
    const hostile = {
      toString() {
        throw new Error("toString called");
      },
      toJSON() {
        throw new Error("toJSON called");
      },
      valueOf() {
        throw new Error("valueOf called");
      },
    };
    expect(formatValue(hostile)).toBe(
      "{ toString: [Function: toString], toJSON: [Function: toJSON], valueOf: [Function: valueOf] }",
    );
  });

  test("shows an accessor as [Getter] without running it", () => {
    let ran = false;
    const value = {
      id: 1,
      get boom(): never {
        ran = true;
        throw new Error("getter called");
      },
    };
    expect(formatValue(value)).toBe("{ id: 1, boom: [Getter] }");
    expect(formatValue([value])).toBe("[{ id: 1, boom: [Getter] }]");
    const list: unknown[] = [1];
    Object.defineProperty(list, 1, {
      get: () => {
        ran = true;
        return 2;
      },
      enumerable: true,
    });
    expect(formatValue(list)).toBe("[1, [Getter]]");
    expect(ran).toBe(false);
  });

  test("shows the holes of a sparse array as undefined", () => {
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[2] = 3;
    expect(formatValue(sparse)).toBe("[1, undefined, 3]");
  });

  test("does not run a toISOString, a name getter or a constructor getter that the value defines", () => {
    const calls: string[] = [];
    const date = new Date(0);
    Object.defineProperty(date, "toISOString", {
      value: () => {
        calls.push("toISOString");
        return "secret";
      },
    });
    Object.defineProperty(date, "getTime", {
      value: () => {
        calls.push("getTime");
        return 1;
      },
    });
    expect(formatValue(date)).toBe("1970-01-01T00:00:00.000Z");

    class Sneaky {
      static get name(): string {
        calls.push("name");
        return "Leaked";
      }
      x = 1;
    }
    expect(formatValue(new Sneaky())).toBe("Object { x: 1 }");

    const proto = {};
    Object.defineProperty(proto, "constructor", {
      get: () => {
        calls.push("constructor");
        return Date;
      },
    });
    expect(formatValue(Object.create(proto))).toBe("Object {}");

    function fn() {}
    Object.defineProperty(fn, "name", {
      get: () => {
        calls.push("fn name");
        return "x";
      },
    });
    expect(formatValue(fn)).toBe("[Function]");

    const bytes = new Uint8Array(3);
    Object.defineProperty(bytes, "byteLength", {
      get: () => {
        calls.push("byteLength");
        return 99;
      },
    });
    expect(formatValue(bytes)).toBe("<Uint8Array 3 bytes>");
    expect(formatValue(new DataView(new ArrayBuffer(2)))).toBe("DataView {}");
    expect(calls).toEqual([]);
  });

  test("copes with a typed array without a class and a Proxy that changes its mind", () => {
    const bare = new Uint8Array(2);
    Object.setPrototypeOf(bare, null);
    expect(formatValue(bare)).toBe("<TypedArray 2 bytes>");

    // Lists the key "a" (and confirms it to Object.keys), then denies having it.
    let asked = 0;
    const fickle = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor: (target, key) =>
          typeof key === "symbol" || asked++ === 0
            ? Reflect.getOwnPropertyDescriptor(target, key)
            : undefined,
      },
    );
    expect(formatValue(fickle)).toBe("{ a: undefined }");
  });

  test("renders a Proxy whose traps throw as [unprintable]", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    expect(formatValue(proxy)).toBe("[unprintable]");
    expect(formatValue({ nested: [proxy] })).toBe("[unprintable]");
    expect(formatStruct("Row", proxy, new Set())).toBe("Row [unprintable]");
  });

  test("never throws and always returns a string, whatever it is given", () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withDate: true,
          withTypedArray: true,
          withMap: true,
          withSet: true,
          withNullPrototype: true,
        }),
        (value) => {
          expect(typeof formatValue(value)).toBe("string");
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("formatStruct", () => {
  test("renders the name and the fields, with redacted values hidden", () => {
    const row = { id: 1, email: "a@b.c", passwordHash: SECRET };
    const text = formatStruct("User", row, new Set(["passwordHash"]));
    expect(text).toBe('User { id: 1, email: "a@b.c", passwordHash: **redacted** }');
    expect(text).not.toContain(SECRET);
  });

  test("renders an empty record", () => {
    expect(formatStruct("Empty", {}, new Set())).toBe("Empty {}");
  });

  test("quotes keys that are not identifiers", () => {
    expect(formatStruct("Row", { "odd key": 1 }, new Set())).toBe('Row { "odd key": 1 }');
  });

  test("formats nested values like formatValue, one level down", () => {
    const row = { settings: { theme: { dark: { deep: true } } }, tags: ["a"], at: new Date(0) };
    expect(formatStruct("User", row, new Set())).toBe(
      'User { settings: { theme: { dark: [Object] } }, tags: ["a"], at: 1970-01-01T00:00:00.000Z }',
    );
  });

  test("marks a reference back to the record itself", () => {
    const row: Record<string, unknown> = { id: 1 };
    row.self = row;
    expect(formatStruct("Node", row, new Set())).toBe("Node { id: 1, self: [Circular] }");
  });

  test("does not read the value of a redacted field", () => {
    let read = false;
    const row = {
      id: 1,
      get passwordHash(): string {
        read = true;
        return SECRET;
      },
    };
    expect(formatStruct("User", row, new Set(["passwordHash"]))).toBe(
      "User { id: 1, passwordHash: **redacted** }",
    );
    expect(read).toBe(false);
  });

  test("a field that is an accessor shows as [Getter]; the others still render", () => {
    const row = {
      id: 1,
      get broken(): never {
        throw new Error("getter called");
      },
      name: "ada",
    };
    expect(formatStruct("User", row, new Set())).toBe('User { id: 1, broken: [Getter], name: "ada" }');
  });

  test("no redacted value ever appears in the output", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.string({ minLength: 8 }), { minKeys: 1 }),
        (values) => {
          const keys = Object.keys(values);
          const redacted = new Set(keys.filter((_, i) => i % 2 === 0));
          const text = formatStruct("Row", values, redacted);
          const visible = keys.filter((key) => !redacted.has(key)).map((key) => values[key]);
          for (const key of redacted) {
            const secret = values[key] as string;
            // A redacted value may only show up if a visible field holds the same text.
            if (!visible.some((v) => (v as string).includes(secret))) {
              expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// --- Rows of schemas, faked the way step 04 builds them: the base class returned by
// `Schema()` holds the metadata under META, and the user's class extends it. ---

function schemaBase(fields: readonly { name: string; redact: boolean }[]): new () => object {
  const Base = function Base() {} as unknown as new () => object;
  Object.defineProperty(Base, META, { value: { fields } });
  return Base;
}
const USER_FIELDS = [
  { name: "id", redact: false },
  { name: "email", redact: false },
  { name: "passwordHash", redact: true },
];
class User extends schemaBase(USER_FIELDS) {
  constructor(
    readonly id: number,
    readonly email: string,
    readonly passwordHash: string,
  ) {
    super();
  }
}
class Post extends schemaBase([
  { name: "id", redact: false },
  { name: "secretNote", redact: true },
  { name: "author", redact: false },
]) {
  constructor(
    readonly id: number,
    readonly secretNote: string,
    readonly author: unknown,
  ) {
    super();
  }
}

describe("redaction of rows, at any depth", () => {
  const user = new User(1, "a@b.c", "s3cret-hash");

  test("formatValue hides a row's redacted fields without being told", () => {
    expect(formatValue(user)).toBe('User { id: 1, email: "a@b.c", passwordHash: **redacted** }');
  });

  test("a row nested in a plain record is still redacted (the reviewer's case)", () => {
    const text = formatStruct("Post", { id: 1, author: user }, new Set());
    expect(text).toBe('Post { id: 1, author: User { id: 1, email: "a@b.c", passwordHash: **redacted** } }');
    expect(text).not.toContain("s3cret-hash");
  });

  test("a row nested in a row, in an array and in a changeset-like record is redacted", () => {
    const post = new Post(7, "do not print", user);
    expect(formatValue(post)).toBe(
      'Post { id: 7, secretNote: **redacted**, author: User { id: 1, email: "a@b.c", passwordHash: **redacted** } }',
    );
    const changeset = { action: "update", data: post, changes: { title: "x" }, rows: [user, user] };
    const text = formatStruct("Changeset", changeset, new Set());
    expect(text).not.toContain("s3cret-hash");
    expect(text).not.toContain("do not print");
    expect(text).toContain('rows: [User { id: 1, email: "a@b.c", passwordHash: **redacted** }, User {');
  });

  test("formatStruct on a row hides the schema's redacted fields even when the caller names none", () => {
    expect(formatStruct("User", user, new Set())).toBe(
      'User { id: 1, email: "a@b.c", passwordHash: **redacted** }',
    );
    expect(formatStruct("User", user, new Set(["email"]))).toBe(
      "User { id: 1, email: **redacted**, passwordHash: **redacted** }",
    );
  });

  test("a redacted field's value is not read", () => {
    let read = false;
    class Guarded extends schemaBase([{ name: "token", redact: true }]) {}
    const row = new Guarded();
    Object.defineProperty(row, "token", {
      enumerable: true,
      get: () => {
        read = true;
        return "x";
      },
    });
    expect(formatValue(row)).toBe("Guarded { token: **redacted** }");
    expect(read).toBe(false);
  });

  test("metadata that is not plain data redacts EVERYTHING: redaction fails closed", () => {
    const meta = {
      fields: [
        { name: "id", redact: false },
        { name: "passwordHash", redact: true },
      ],
    };
    let ran = false;
    // The reviewer's case: a lazily built meta behind a static getter.
    const LazyBase = function LazyBase() {} as unknown as new () => object;
    Object.defineProperty(LazyBase, META, {
      get: () => {
        ran = true;
        return meta;
      },
    });
    class LazyUser extends LazyBase {
      id = 1;
      passwordHash = "S3CRET";
    }
    class GetterFields {
      static readonly [META] = {
        get fields() {
          ran = true;
          return meta.fields;
        },
      };
      id = 1;
      passwordHash = "S3CRET";
    }
    class GetterMembers {
      static readonly [META] = {
        fields: [
          { name: "id", redact: false },
          {
            name: "passwordHash",
            get redact() {
              ran = true;
              return true;
            },
          },
        ],
      };
      id = 1;
      passwordHash = "S3CRET";
    }
    class GetterName {
      static readonly [META] = {
        fields: [
          {
            get name() {
              ran = true;
              return "passwordHash";
            },
            redact: true,
          },
        ],
      };
      passwordHash = "S3CRET";
    }
    const allHidden = "{ id: **redacted**, passwordHash: **redacted** }";
    expect(formatValue(new LazyUser())).toBe(`LazyUser ${allHidden}`);
    expect(formatValue(new GetterFields())).toBe(`GetterFields ${allHidden}`);
    expect(formatValue(new GetterMembers())).toBe(`GetterMembers ${allHidden}`);
    expect(formatValue(new GetterName())).toBe("GetterName { passwordHash: **redacted** }");
    // Nested, and through formatStruct, and again (from the cache).
    expect(formatValue({ post: 1, authors: [new LazyUser()] })).not.toContain("S3CRET");
    expect(formatStruct("LazyUser", new LazyUser(), new Set())).toBe(`LazyUser ${allHidden}`);
    expect(formatStruct("Row", { user: new GetterMembers() }, new Set())).not.toContain("S3CRET");
    expect(formatValue(new GetterMembers())).toBe(`GetterMembers ${allHidden}`);
    expect(ran).toBe(false);
  });

  test("malformed metadata also redacts everything, and does not throw", () => {
    class NoFields {
      static readonly [META] = {};
      x = 1;
    }
    class NotAnObject {
      static readonly [META] = "meta";
      z = 3;
    }
    class NullMeta {
      static readonly [META] = null;
      n = 4;
    }
    const odd = (fields: unknown): object => {
      class Odd {
        static readonly [META] = { fields };
        y = 2;
      }
      return new Odd();
    };
    expect(formatValue(new NoFields())).toBe("NoFields { x: **redacted** }");
    expect(formatValue(new NotAnObject())).toBe("NotAnObject { z: **redacted** }");
    expect(formatValue(new NullMeta())).toBe("NullMeta { n: **redacted** }");
    for (const fields of [
      "fields",
      [null],
      [3],
      [{ name: 5, redact: true }],
      [{ redact: true }],
      [{ name: "y", redact: "yes" }],
      [{ name: "y" }],
    ]) {
      expect(formatValue(odd(fields))).toBe("Odd { y: **redacted** }");
    }
    // Well-formed metadata with nothing redacted prints everything.
    expect(formatValue(odd([]))).toBe("Odd { y: 2 }");
    expect(formatValue(odd([{ name: "y", redact: false }]))).toBe("Odd { y: 2 }");
  });

  // Three shapes that are still `instanceof` a schema class but whose immediate prototype
  // does not name it (review round 3, finding 35).
  test("a row is recognised along the whole prototype chain", () => {
    const hidden = '{ id: 1, email: "a@b.c", passwordHash: **redacted** }';
    let ran = false;

    // 1. `constructor` deleted from the class's prototype.
    class NoConstructor extends schemaBase(USER_FIELDS) {
      id = 1;
      email = "a@b.c";
      passwordHash = "S3CRET";
    }
    Reflect.deleteProperty(NoConstructor.prototype, "constructor");
    expect(new NoConstructor()).toBeInstanceOf(NoConstructor);
    expect(formatValue(new NoConstructor())).toBe(`Object ${hidden}`);

    // 2. `constructor` replaced by an accessor, which must not run.
    class AccessorConstructor extends schemaBase(USER_FIELDS) {
      id = 1;
      email = "a@b.c";
      passwordHash = "S3CRET";
    }
    Object.defineProperty(AccessorConstructor.prototype, "constructor", {
      get: () => {
        ran = true;
        return Object;
      },
    });
    expect(formatValue(new AccessorConstructor())).toBe(`Object ${hidden}`);
    expect(formatStruct("User", new AccessorConstructor(), new Set())).toBe(`User ${hidden}`);

    // 3. An extra prototype layer between the object and the class's prototype.
    const layered = Object.assign(Object.create(Object.create(User.prototype)) as object, {
      id: 1,
      email: "a@b.c",
      passwordHash: "S3CRET",
    });
    expect(layered).toBeInstanceOf(User);
    expect(formatValue(layered)).toBe(`Object ${hidden}`);
    expect(formatValue({ nested: [layered] })).not.toContain("S3CRET");
    expect(ran).toBe(false);
  });

  test("an object with the ROW marker but no findable schema has every value redacted", () => {
    const orphan = {
      id: 1,
      passwordHash: "S3CRET",
      [ROW]: { state: "loaded", source: "users", schema: undefined },
    };
    expect(formatValue(orphan)).toBe("{ id: **redacted**, passwordHash: **redacted** }");
    expect(formatStruct("Row", orphan, new Set())).toBe(
      "Row { id: **redacted**, passwordHash: **redacted** }",
    );
    const detached = Object.assign(Object.create(null) as object, orphan);
    Object.defineProperty(detached, ROW, { value: orphan[ROW] });
    expect(formatValue(detached)).not.toContain("S3CRET");
    // A real row carries the marker too and is redacted field by field, as before.
    const row = Object.assign(new User(1, "a@b.c", "s3cret-hash"), { [ROW]: orphan[ROW] });
    expect(formatValue(row)).toBe('User { id: 1, email: "a@b.c", passwordHash: **redacted** }');
  });

  test("a plain object holding field values is NOT recognised: the caller passes the names", () => {
    const changes = { email: "a@b.c", passwordHash: "s3cret-hash" };
    expect(formatValue(changes)).toContain("s3cret-hash");
    expect(formatStruct("changes", changes, new Set(["passwordHash"]))).not.toContain("s3cret-hash");
  });

  test("no redacted value appears in the output, whatever the nesting", () => {
    // Every secret is a unique token, so finding one in the output is a leak.
    let counter = 0;
    const secret = (): string => `SECRET${counter++}X`;
    const secrets: string[] = [];
    const makeUser = (): User => {
      const token = secret();
      secrets.push(token);
      return new User(counter, `user${counter}@example.com`, token);
    };
    const tree: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
      node: fc.oneof(
        { depthSize: "small", maxDepth: 5 },
        fc.constant(null).map(() => makeUser()),
        fc.tuple(tie("node")).map(([author]) => {
          const token = secret();
          secrets.push(token);
          return new Post(counter, token, author);
        }),
        fc.array(tie("node"), { maxLength: 3 }),
        fc.dictionary(fc.stringMatching(/^[a-z]{1,5}$/), tie("node"), { maxKeys: 3 }),
      ),
    })).node;
    fc.assert(
      fc.property(tree, (value) => {
        secrets.length = 0;
        const built = value;
        const outputs = [formatValue(built), formatStruct("Top", { value: built, list: [built] }, new Set())];
        for (const text of outputs) {
          for (const token of secrets) expect(text).not.toContain(token);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
