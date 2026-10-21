import { inspect } from "node:util";
import { describe, expect, test, vi } from "vitest";
import type { AnySchema, FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { META, ROW } from "../contracts/schema.js";
import { SchemaDefinitionError } from "../errors.js";
import { formatValue } from "../internal/inspect.js";
import { integerType, jsonType, stringType, timestampType } from "../types/index.js";
import {
  belongsTo,
  EmbeddedSchema,
  fieldNames,
  hasMany,
  isRow,
  isSchema,
  meta,
  primaryKeyOf,
  Schema,
  stateOf,
  t,
  timestamps,
} from "./index.js";

class User extends Schema("users", {
  id: t.integer().primaryKey(),
  email: t.string(),
  name: t.string().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  loginCount: t.integer().default(0),
  password: t.string().virtual(),
  passwordHash: t.string().redact().column("pw_hash"),
  settings: t.json<{ theme: string }>().nullable(),
  lockVersion: t.integer().default(1),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  get displayName(): string {
    return this.name ?? this.email;
  }

  greet(greeting: string): string {
    return `${greeting}, ${this.displayName}`;
  }
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey(),
  authorId: t.integer(),
  title: t.string(),
  secret: t.string().nullable().redact(),
}) {
  static author = belongsTo(() => User);
}

const NOW = new Date("2026-10-13T00:00:00.000Z");
/** The values of a `users` row, in the order of the stored fields. */
const USER_VALUES = [1, "ada@example.com", null, "member", 3, "$2b$hash", { theme: "dark" }, 1, NOW, NOW];

function loadedUser(values: readonly unknown[] = USER_VALUES): User {
  const m = meta(User);
  return m.create(values, m.rowMeta("loaded", undefined)) as User;
}

function loadedPost(id: number, secret: string | null = "s3cret"): Post {
  const m = meta(Post);
  return m.create([id, 1, `Post ${id}`, secret], m.rowMeta("loaded", undefined)) as Post;
}

/** `toJSON` is on every row's prototype; the row types list fields only. */
const toJSON = (row: object): unknown => (row as { toJSON(): unknown }).toJSON();

const field = (schema: AnySchema, name: string): FieldMeta => {
  const found = meta(schema).fieldsByName.get(name);
  if (found === undefined) throw new Error(`no field ${name}`);
  return found;
};

describe("metadata", () => {
  test("describes the table, the fields in declaration order and the key", () => {
    const m = meta(User);
    expect(m.name).toBe("User");
    expect(m.source).toBe("users");
    expect(m.schema).toBeUndefined();
    expect(m.fields.map((f) => f.name)).toEqual([
      "id",
      "email",
      "name",
      "role",
      "loginCount",
      "password",
      "passwordHash",
      "settings",
      "lockVersion",
      "createdAt",
      "updatedAt",
    ]);
    expect(m.fields.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(m.persisted.map((f) => f.name)).toEqual(
      m.fields.map((f) => f.name).filter((n) => n !== "password"),
    );
    expect(m.primaryKey).toEqual([field(User, "id")]);
    expect([...m.fieldsByName.keys()]).toEqual(m.fields.map((f) => f.name));
    expect(m.fieldsByName.get("email")).toBe(m.fields[1]);
    expect(m.embeds).toEqual([]);
  });

  test("a field with no modifier", () => {
    expect(field(User, "email")).toEqual({
      name: "email",
      column: "email",
      type: stringType(),
      nullable: false,
      primaryKey: false,
      virtual: false,
      redact: false,
      writable: "always",
      dbGenerated: false,
      default: undefined,
      autogenerate: undefined,
      index: 1,
    });
  });

  test("each modifier shows in the field's metadata", () => {
    expect(field(User, "name").nullable).toBe(true);
    expect(field(User, "password").virtual).toBe(true);
    expect(field(User, "passwordHash")).toMatchObject({ redact: true, column: "pw_hash" });
    expect(field(User, "role").default).toEqual({ kind: "value", value: "member" });
    expect(field(User, "settings").type).toBe(jsonType());
    expect(field(User, "createdAt")).toMatchObject({ column: "created_at", type: timestampType() });
    expect(field(User, "createdAt").autogenerate?.on).toBe("insert");
    expect(field(User, "updatedAt").autogenerate?.on).toBe("insertAndUpdate");

    class Every extends Schema("every", {
      id: t.uuid().primaryKey().autogenerate(),
      seen: t.integer().dbGenerated(),
      frozen: t.string().writable("insert"),
      computed: t.string().writable("never"),
    }) {}
    expect(field(Every, "id")).toMatchObject({ primaryKey: true, dbGenerated: false });
    expect(field(Every, "id").autogenerate?.on).toBe("insert");
    expect(field(Every, "seen").dbGenerated).toBe(true);
    expect(field(Every, "frozen").writable).toBe("insert");
    expect(field(Every, "computed").writable).toBe("never");
  });

  test("a nullable field has no default of its own: the database's default still applies on insert", () => {
    expect(field(User, "name").default).toBeUndefined();
  });

  test("a default is exposed as a value or as a function that gives a fresh value per call", () => {
    class Draft extends Schema("drafts", {
      id: t.integer().primaryKey(),
      views: t.integer().default(0),
      tags: t.json<string[]>().default(() => []),
    }) {}
    expect(field(Draft, "views").default).toEqual({ kind: "value", value: 0 });
    const tags = field(Draft, "tags").default;
    if (tags?.kind !== "fn") throw new Error("expected a function default");
    expect(tags.fn()).toEqual([]);
    expect(tags.fn()).not.toBe(tags.fn());
  });

  test("a key is a value you supply unless .dbGenerated() says otherwise, whatever its type", () => {
    const key = (builder: Parameters<typeof Schema>[1][string]): FieldMeta =>
      field(Schema("k", { id: builder }), "id");
    expect(key(t.integer().primaryKey()).dbGenerated).toBe(false);
    expect(key(t.bigint().primaryKey()).dbGenerated).toBe(false);
    expect(key(t.float().primaryKey()).dbGenerated).toBe(false);
    expect(key(t.string().primaryKey()).dbGenerated).toBe(false);
    expect(key(t.integer().primaryKey().dbGenerated()).dbGenerated).toBe(true);
    expect(key(t.bigint({ mode: "number" }).primaryKey().dbGenerated()).dbGenerated).toBe(true);
    expect(key(t.uuid().primaryKey().dbGenerated()).dbGenerated).toBe(true);
    const generated = key(
      t
        .integer()
        .primaryKey()
        .autogenerate(() => 1),
    );
    expect(generated.dbGenerated).toBe(false);
    expect(generated.autogenerate).toBeDefined();
  });

  test("each part of a composite key is supplied unless it says .dbGenerated()", () => {
    class PostTag extends Schema("posts_tags", {
      postId: t.integer().primaryKey(),
      tagId: t.integer().primaryKey(),
    }) {}
    expect(meta(PostTag).primaryKey.map((f) => f.dbGenerated)).toEqual([false, false]);
    class Versioned extends Schema("versions", {
      id: t.integer().primaryKey().dbGenerated(),
      version: t.integer().primaryKey(),
    }) {}
    expect(meta(Versioned).primaryKey.map((f) => f.dbGenerated)).toEqual([true, false]);
  });

  test("several key fields form a composite key, in declaration order", () => {
    class Membership extends Schema("memberships", {
      orgId: t.uuid().primaryKey(),
      userId: t.integer().primaryKey(),
      role: t.string(),
    }) {}
    expect(meta(Membership).primaryKey.map((f) => f.name)).toEqual(["orgId", "userId"]);
  });

  test("a table without a key is declared with { primaryKey: false }", () => {
    class Event extends Schema("events", { name: t.string() }, { primaryKey: false }) {}
    expect(meta(Event).primaryKey).toEqual([]);
  });

  test("the metadata and everything in it is frozen", () => {
    const m = meta(User);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.fields)).toBe(true);
    expect(Object.isFrozen(m.persisted)).toBe(true);
    expect(Object.isFrozen(m.primaryKey)).toBe(true);
    expect(Object.isFrozen(m.embeds)).toBe(true);
    for (const f of m.fields) expect(Object.isFrozen(f)).toBe(true);
  });

  test("META, fields, name and redact are own data properties, as the redaction-aware formatter needs", () => {
    const base = Object.getPrototypeOf(User) as object;
    for (const holder of [base, User]) {
      const descriptor = Object.getOwnPropertyDescriptor(holder, META);
      expect(descriptor).toMatchObject({ enumerable: false, writable: false, configurable: false });
      const m = descriptor?.value as SchemaMeta;
      expect(Object.getOwnPropertyDescriptor(m, "fields")).toHaveProperty("value");
      for (const f of m.fields) {
        expect(Object.getOwnPropertyDescriptor(f, "name")).toHaveProperty("value");
        expect(Object.getOwnPropertyDescriptor(f, "redact")).toHaveProperty("value");
      }
    }
    expect(formatValue(loadedUser())).toContain("passwordHash: **redacted**");
    expect(formatValue(loadedUser())).not.toContain("$2b$hash");
  });

  test("every field's metadata has the same members in the same order", () => {
    const keys = Object.keys(field(User, "id"));
    for (const f of [...meta(User).fields, ...meta(Post).fields]) expect(Object.keys(f)).toEqual(keys);
  });

  test("the class exposes the field builders it was defined with", () => {
    expect(Object.keys(User.fields)).toEqual(meta(User).fields.map((f) => f.name));
    expect(Object.isFrozen(User.fields)).toBe(true);
    expect(fieldNames(User)).toEqual(Object.keys(User.fields));
    expect(fieldNames(User)).toBe(fieldNames(User));
    expect(Object.isFrozen(fieldNames(User))).toBe(true);
  });
});

describe("column names", () => {
  test("are the snake_case form of the field name by default", () => {
    class Account extends Schema("accounts", {
      id: t.integer().primaryKey(),
      firstName: t.string(),
      userID: t.integer(),
      address2Line: t.string(),
    }) {}
    expect(meta(Account).fields.map((f) => f.column)).toEqual([
      "id",
      "first_name",
      "user_id",
      "address2_line",
    ]);
    expect(
      meta(
        Schema("a", { id: t.integer().primaryKey(), firstName: t.string() }, { naming: "snake_case" }),
      ).fields.map((f) => f.column),
    ).toEqual(["id", "first_name"]);
  });

  test("column() overrides one field", () => {
    expect(field(User, "passwordHash").column).toBe("pw_hash");
  });

  test('naming: "camelCase" keeps the field names', () => {
    class Legacy extends Schema(
      "Legacy",
      { id: t.integer().primaryKey(), firstName: t.string(), other: t.string().column("x") },
      { naming: "camelCase" },
    ) {}
    expect(meta(Legacy).fields.map((f) => f.column)).toEqual(["id", "firstName", "x"]);
  });

  test("naming may be a function", () => {
    class Shouting extends Schema(
      "shouting",
      { id: t.integer().primaryKey(), firstName: t.string() },
      { naming: (name) => name.toUpperCase() },
    ) {}
    expect(meta(Shouting).fields.map((f) => f.column)).toEqual(["ID", "FIRSTNAME"]);
  });

  test("a virtual field has no column of its own and does not take part in the duplicate check", () => {
    class Signup extends Schema("signups", {
      id: t.integer().primaryKey(),
      passwordConfirmation: t.string().virtual(),
      password_confirmation: t.string(),
    }) {}
    expect(field(Signup, "passwordConfirmation").column).toBe("passwordConfirmation");
    expect(meta(Signup).persisted.map((f) => f.column)).toEqual(["id", "password_confirmation"]);
  });
});

describe("schema options", () => {
  test("schema is the database schema, and built rows carry it", () => {
    class Invoice extends Schema("invoices", { id: t.integer().primaryKey() }, { schema: "billing" }) {}
    expect(meta(Invoice).schema).toBe("billing");
    expect(meta(Invoice).rowMeta("built", meta(Invoice).schema)).toEqual({
      state: "built",
      source: "invoices",
      schema: "billing",
    });
    expect(meta(Schema("x", { id: t.integer().primaryKey() }, { schema: undefined })).schema).toBeUndefined();
  });
});

describe("definition errors", () => {
  const id = t.integer().primaryKey();

  test("a table name is required", () => {
    expect(() => Schema("", { id })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.tableName: Schema() was given an empty string as the table name. Pass the table name as a non-empty string: Schema("users", { ... }). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-tablename]`,
    );
    expect(() => Schema({ id } as never, {})).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.tableName: Schema() was given an object as the table name. Pass the table name as a non-empty string: Schema("users", { ... }). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-tablename]`,
    );
  });

  test("the fields are an object of field types", () => {
    expect(() => Schema("users", null as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.fieldsNotObject: Schema("users"): the fields must be an object from field name to type, such as { id: t.integer().primaryKey() }, but got null. Pass the fields as the second argument of Schema() (or the first of EmbeddedSchema()), an object whose values are field types made with t. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-fieldsnotobject]`,
    );
    expect(() => Schema("users", "id" as never)).toThrow(SchemaDefinitionError);
    expect(() => Schema("users", { id, email: "string" as never })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.notFieldType: Schema("users"): field "email" is not a field type. Declare it with t, as in email: t.string(). Associations are static members of the class, not fields. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-notfieldtype]`,
    );
    expect(() =>
      Schema("users", { id, posts: hasMany(() => Post, { foreignKey: "authorId" }) as never }),
    ).toThrow(/Associations are static members/);
  });

  test("a primary key is required unless the table is declared without one", () => {
    expect(() => Schema("events", { name: t.string() })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.noPrimaryKey: Schema("events"): no field is the primary key. Add .primaryKey() to the key field, as in id: t.integer().primaryKey(), or pass { primaryKey: false } as the third argument for a table without one. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-noprimarykey]`,
    );
    expect(() => Schema("events", {})).toThrow(SchemaDefinitionError);
    expect(() => Schema("events", { id }, { primaryKey: false })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.keylessWithKey: Schema("events"): { primaryKey: false } says the table has no key, but the field "id" is declared with .primaryKey(). Remove one of the two. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-keylesswithkey]`,
    );
    expect(() => Schema("events", { id }, { primaryKey: true as never })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.primaryKeyOption: Schema("events"): primaryKey can only be false, for a table without a key. A key is declared on its field: id: t.integer().primaryKey(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-primarykeyoption]`,
    );
  });

  test("two fields cannot share a column", () => {
    expect(() =>
      Schema("users", { id, firstName: t.string(), first_name: t.string() }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.columnTaken: Schema("users"): the fields "firstName" and "first_name" are both stored in the column "first_name". Give one of them another column with .column("…"). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-columntaken]`,
    );
    expect(() => Schema("users", { id, a: t.string().column("x"), b: t.string().column("x") })).toThrow(
      /"a" and "b" are both stored in the column "x"/,
    );
  });

  test("reserved field names are refused", () => {
    expect(() => Schema("users", { id, toJSON: t.string() })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.reservedName: Schema("users"): field "toJSON" has a reserved name. A field cannot be named "constructor", "__proto__" or "toJSON", or start with "$". Rename it, and keep the column with .column("toJSON"). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-reservedname]`,
    );
    expect(() => Schema("users", { id, constructor: t.string() })).toThrow(
      /field "constructor" has a reserved name/,
    );
    expect(() => Schema("users", { id, $loaded: t.string() })).toThrow(
      /field "\$loaded" has a reserved name/,
    );
    expect(() => Schema("users", { id, "": t.string() })).toThrow(/field "" has a reserved name/);
    expect(() => Schema("users", { id, ...timestamps({ createdAt: "__proto__" }) })).toThrow(
      /field "__proto__" has a reserved name/,
    );
    expect(() => Schema("users", JSON.parse('{"__proto__": 1}') as never)).toThrow(SchemaDefinitionError);
  });

  test("modifiers that contradict each other are refused", () => {
    expect(() =>
      Schema("users", { id: t.integer().nullable().primaryKey() }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.nullableKey: Schema("users"): field "id" is a primary key and nullable. A key always has a value: remove .nullable(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-nullablekey]`,
    );
    expect(() =>
      Schema("users", { id, x: t.string().virtual().dbGenerated() }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.virtualStored: Schema("users"): field "x" is virtual, so it is never stored: it cannot also be a primary key, database-generated or autogenerated. Remove .virtual() or the other modifier. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-virtualstored]`,
    );
    expect(() => Schema("users", { id: t.string().virtual().primaryKey() })).toThrow(/is virtual/);
    expect(() => Schema("users", { id, x: t.uuid().virtual().autogenerate() })).toThrow(/is virtual/);
    expect(() =>
      Schema("users", { id, x: t.uuid().dbGenerated().autogenerate() }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.generatedTwice: Schema("users"): field "x" is both database-generated and autogenerated. Only one side can produce the value: remove .dbGenerated() or .autogenerate(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-generatedtwice]`,
    );
    expect(() =>
      Schema("users", {
        id: t
          .integer()
          .primaryKey()
          .dbGenerated()
          .autogenerate(() => 1),
      }),
    ).toThrow(/both database-generated and autogenerated/);
    expect(() =>
      Schema("users", { id, x: t.string().default(null as never) }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.nullDefault: Schema("users"): field "x" has the default null but is not nullable. Add .nullable(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-nulldefault]`,
    );
  });

  test("an embed cannot be a key or virtual", () => {
    class Address extends EmbeddedSchema({ city: t.string() }) {}
    expect(() =>
      Schema("users", { id: t.embedOne(() => Address).primaryKey() }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.embedModifier: Schema("users"): field "id" is an embed, which cannot be a primary key or virtual. Remove .primaryKey() or .virtual() from the embed field. An embed is stored in its parent's JSON column; give the embedded schema its own key field if its items need one. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-embedmodifier]`,
    );
    expect(() => Schema("users", { id, address: t.embedOne(() => Address).virtual() })).toThrow(
      /is an embed/,
    );
  });

  test("wrong options are refused", () => {
    expect(() => Schema("users", { id }, "billing" as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.optionsNotObject: Schema("users"): the options must be an object, but got a string. Pass the options as an object, such as { schema: "tenant_1" }, or leave them out. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-optionsnotobject]`,
    );
    expect(() => Schema("users", { id }, null as never)).toThrow(SchemaDefinitionError);
    expect(() => Schema("users", { id }, { schema: "" })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.schemaOption: Schema("users"): schema must be the name of the database schema, as a non-empty string. Pass the database schema's name, as in { schema: "tenant_1" }, or leave the option out for the connection's default. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-schemaoption]`,
    );
    expect(() => Schema("users", { id }, { schema: 1 as never })).toThrow(SchemaDefinitionError);
    expect(() =>
      Schema("users", { id }, { naming: "kebab-case" as never }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.namingOption: Schema("users"): naming must be "snake_case", "camelCase" or a function from field name to column name. Pass naming: "snake_case" (the default for tables), naming: "camelCase", or a function such as (field) => field.toLowerCase(). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-namingoption]`,
    );
    expect(() => Schema("users", { id }, { naming: (() => "") as never })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.namingResult: Schema("users"): the naming function returned an empty string for the field "id". It must return the column name. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-namingresult]`,
    );
    expect(() => Schema("users", { id }, { naming: (() => 1) as never })).toThrow(SchemaDefinitionError);
  });

  test("every definition error is a SchemaDefinitionError with its code", () => {
    try {
      Schema("events", { name: t.string() });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaDefinitionError);
      expect((error as SchemaDefinitionError).code).toBe("schemaDefinition");
    }
  });
});

describe("there is no public constructor", () => {
  const construct = (schema: unknown, ...args: unknown[]): object =>
    new (schema as new (...a: unknown[]) => object)(...args);

  test("calling it throws, pointing at changesets", () => {
    expect(() => construct(User)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.noConstructor: User has no public constructor: a row comes only from the database. Describe a new record with a changeset instead: cast(User, params, [...]) or change(User, values). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-noconstructor]`,
    );
    expect(() => construct(User, { email: "a@b.c" })).toThrow(SchemaDefinitionError);
  });

  test("the class that Schema() returns says so by its table when it has no name", () => {
    const Anonymous = Schema("events", { id: t.integer().primaryKey() });
    expect(() => construct(Anonymous)).toThrow(/has no public constructor/);
    const Unnamed = (() => class extends Schema("things", { id: t.integer().primaryKey() }) {})();
    expect(() => construct(Unnamed)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.noConstructor: Schema("things") has no public constructor: a row comes only from the database. Describe a new record with a changeset instead: cast(Schema("things"), params, [...]) or change(Schema("things"), values). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-noconstructor]`,
    );
  });

  test("a subclass constructor cannot get past it", () => {
    class Sneaky extends Schema("sneaky", { id: t.integer().primaryKey() }) {
      constructor() {
        super(undefined as never);
      }
    }
    expect(() => construct(Sneaky)).toThrow(/Sneaky has no public constructor/);
  });

  test("rows are made without running a constructor or a field initialiser", () => {
    let ran = 0;
    class Counted extends Schema("counted", { id: t.integer().primaryKey() }) {
      initialised = ++ran;
    }
    const m = meta(Counted);
    const row = m.create([1], m.rowMeta("loaded", undefined)) as Counted;
    expect(ran).toBe(0);
    expect(Object.keys(row)).toEqual(["id"]);
    expect(row).toBeInstanceOf(Counted);
  });
});

describe("a class member with a field's name", () => {
  // TypeScript already refuses such a member in a class body; plain JavaScript, or a
  // member added to the prototype, still gets here.
  test("is refused when the class is first used, so no row can lose the field", () => {
    for (const codegen of [true, false]) {
      class G extends Schema("g", { id: t.integer().primaryKey(), name: t.string() }, { codegen }) {}
      Object.defineProperty(G.prototype, "name", { get: () => "from getter" });
      expect(() => meta(G)).toThrow(SchemaDefinitionError);
    }
    class M extends Schema("m", { id: t.integer().primaryKey(), email: t.string() }) {}
    Object.defineProperty(M.prototype, "email", { value: () => "method", writable: true });
    expect(() => meta(M)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.memberShadowsField: M defines "email" as a getter, method or property of the class, and "email" is also a field. A row holds each field as its own property, so the class member would hide it or make it impossible to set. Rename the member. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-membershadowsfield]`,
    );
  });

  test("is refused when inherited from a class in between", () => {
    class Base extends Schema("b", { id: t.integer().primaryKey(), label: t.string() }) {}
    class Mid extends Base {}
    Object.defineProperty(Mid.prototype, "label", { get: () => "x" });
    class Leaf extends Mid {}
    expect(meta(Base).name).toBe("Base");
    expect(() => meta(Leaf)).toThrow(/Leaf defines "label"/);
  });
});

describe("the row factory", () => {
  test("makes an instance of the class with every field as an own property, in declaration order", () => {
    const user = loadedUser();
    expect(user).toBeInstanceOf(User);
    expect(Object.getPrototypeOf(user)).toBe(User.prototype);
    expect(user.constructor).toBe(User);
    expect(Object.keys(user)).toEqual(meta(User).fields.map((f) => f.name));
    expect({ ...user }).toMatchObject({
      id: 1,
      email: "ada@example.com",
      name: null,
      role: "member",
      loginCount: 3,
      password: undefined,
      passwordHash: "$2b$hash",
      settings: { theme: "dark" },
      lockVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("a virtual field is an own property that starts undefined", () => {
    const user = loadedUser();
    expect(Object.hasOwn(user, "password")).toBe(true);
    expect(user.password).toBeUndefined();
  });

  test("the row marker is the last own property, the only symbol, and holds the given metadata", () => {
    const m = meta(User);
    const rowMeta = m.rowMeta("loaded", "tenant_1");
    const user = m.create(USER_VALUES, rowMeta);
    expect(Reflect.ownKeys(user).at(-1)).toBe(ROW);
    expect(Object.getOwnPropertySymbols(user)).toEqual([ROW]);
    expect((user as { [ROW]: unknown })[ROW]).toBe(rowMeta);
    expect(JSON.stringify(user)).not.toContain("egon");
    const seen: string[] = [];
    for (const key in user) seen.push(key);
    expect(seen).toEqual(m.fields.map((f) => f.name));
  });

  test("getters and methods of the class work on rows", () => {
    const user = loadedUser();
    expect(user.displayName).toBe("ada@example.com");
    expect(user.greet("Hello")).toBe("Hello, ada@example.com");
    user.name = "Ada";
    expect(user.displayName).toBe("Ada");
  });

  test("does not apply defaults and does not convert values", () => {
    const m = meta(User);
    const user = m.create([], m.rowMeta("built", undefined)) as User;
    expect(user.role).toBeUndefined();
    expect(user.loginCount).toBeUndefined();
    expect(Object.keys(user)).toEqual(m.fields.map((f) => f.name));
  });

  test("the generated function and the loop make identical rows", () => {
    const fields = {
      id: t.integer().primaryKey(),
      email: t.string(),
      password: t.string().virtual(),
      'quoted"name\\with\nodd characters': t.string().nullable(),
      note: t.string().nullable(),
    };
    class Generated extends Schema("things", fields) {
      static owner = belongsTo(() => User, { foreignKey: "id" });
    }
    class Looped extends Schema("things", fields, { codegen: false }) {
      static owner = belongsTo(() => User, { foreignKey: "id" });
    }
    expect((meta(Generated) as unknown as { codegen: boolean }).codegen).toBe(true);
    expect((meta(Looped) as unknown as { codegen: boolean }).codegen).toBe(false);
    const values = [7, "a@b.c", "odd", null];
    const owner = loadedUser();
    for (const [a, b] of [
      [
        meta(Generated).create(values, meta(Generated).rowMeta("loaded", "s")),
        meta(Looped).create(values, meta(Looped).rowMeta("loaded", "s")),
      ],
      [
        meta(Generated).createWith(["owner"])(values, [owner], meta(Generated).rowMeta("deleted", undefined)),
        meta(Looped).createWith(["owner"])(values, [owner], meta(Looped).rowMeta("deleted", undefined)),
      ],
    ] as const) {
      expect(Reflect.ownKeys(a)).toEqual(Reflect.ownKeys(b));
      expect({ ...a }).toEqual({ ...b });
      for (const key of Reflect.ownKeys(a)) {
        expect(Object.getOwnPropertyDescriptor(a, key)).toEqual(Object.getOwnPropertyDescriptor(b, key));
      }
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(inspect(a).replace("Generated", "X")).toBe(inspect(b).replace("Looped", "X"));
    }
    expect(Object.keys(meta(Generated).create(values, meta(Generated).rowMeta("loaded", "s")))).toEqual(
      Object.keys(fields),
    );
  });

  test("a field name can never become code in the generated function", () => {
    const marker = "__egonInjected";
    const name = `x"]; globalThis.${marker} = true; this["y`;
    class Odd extends Schema("odd", { id: t.integer().primaryKey(), [name]: t.string() }) {}
    const row = meta(Odd).create([1, "v"], meta(Odd).rowMeta("loaded", undefined));
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(Object.keys(row)).toEqual(["id", name]);
    expect((row as Record<string, unknown>)[name]).toBe("v");
  });

  test("where code cannot be generated, schemas fall back to the loop", async () => {
    vi.resetModules();
    vi.stubGlobal("Function", function Blocked() {
      throw new EvalError("Refused to evaluate a string as JavaScript");
    });
    try {
      const restricted = await import("./index.js");
      class Thing extends restricted.Schema("things", {
        id: restricted.t.integer().primaryKey(),
        name: restricted.t.string(),
      }) {}
      const m = restricted.meta(Thing);
      // Asked for a generated function and refused: the loop is used.
      expect((m as unknown as { codegen: boolean }).codegen).toBe(true);
      expect((m as unknown as { maker: unknown }).maker).toBeUndefined();
      const row = m.create([1, "a"], m.rowMeta("loaded", undefined)) as Thing;
      expect(row).toBeInstanceOf(Thing);
      expect({ ...row }).toMatchObject({ id: 1, name: "a" });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("rowMeta", () => {
  test("returns one shared frozen object per state and database schema", () => {
    const m = meta(User);
    const loaded = m.rowMeta("loaded", undefined);
    expect(loaded).toEqual({ state: "loaded", source: "users", schema: undefined });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(m.rowMeta("loaded", undefined)).toBe(loaded);
    expect(m.rowMeta("deleted", undefined)).toEqual({ state: "deleted", source: "users", schema: undefined });
    expect(m.rowMeta("built", undefined)).toEqual({ state: "built", source: "users", schema: undefined });
    expect(m.rowMeta("built", undefined)).not.toBe(loaded);
    const tenant = m.rowMeta("loaded", "tenant_1");
    expect(tenant).toEqual({ state: "loaded", source: "users", schema: "tenant_1" });
    expect(m.rowMeta("loaded", "tenant_1")).toBe(tenant);
    expect(m.rowMeta("loaded", "tenant_2")).not.toBe(tenant);
    expect(Object.keys(loaded)).toEqual(Object.keys(tenant));
  });

  test("every row of one result points at the same object", () => {
    const a = loadedUser();
    const b = loadedUser();
    expect((a as unknown as { [ROW]: unknown })[ROW]).toBe((b as unknown as { [ROW]: unknown })[ROW]);
  });

  test("does not grow without bound when every tenant has a database schema", () => {
    class Tenant extends Schema("tenant_things", { id: t.integer().primaryKey() }) {}
    const m = meta(Tenant);
    const first = m.rowMeta("loaded", "tenant_0");
    for (let i = 1; i < 5000; i++) m.rowMeta("loaded", `tenant_${i}`);
    // Dropped and made again: equal, and usable, though no longer the same object.
    expect(m.rowMeta("loaded", "tenant_0")).toEqual(first);
    expect(m.rowMeta("loaded", "tenant_0")).not.toBe(first);
    expect(m.rowMeta("loaded", "tenant_4999")).toBe(m.rowMeta("loaded", "tenant_4999"));
  });
});

describe("createWith", () => {
  test("adds the loaded associations after the fields, before the row marker", () => {
    const m = meta(User);
    const posts = [loadedPost(1), loadedPost(2)];
    const user = m.createWith(["posts"])(USER_VALUES, [posts], m.rowMeta("loaded", undefined)) as User & {
      posts: Post[];
    };
    expect(user).toBeInstanceOf(User);
    expect(Reflect.ownKeys(user)).toEqual([...m.fields.map((f) => f.name), "posts", ROW]);
    expect(user.posts).toBe(posts);
    expect(user.displayName).toBe("ada@example.com");
  });

  test("an equal list gives the same factory; a different list or order gives another", () => {
    class Pair extends Schema("pairs", { id: t.integer().primaryKey(), aId: t.integer(), bId: t.integer() }) {
      static a = belongsTo(() => User);
      static b = belongsTo(() => User);
    }
    const m = meta(Pair);
    expect(m.createWith(["a", "b"])).toBe(m.createWith(["a", "b"]));
    expect(m.createWith(["a", "b"])).not.toBe(m.createWith(["b", "a"]));
    expect(m.createWith(["a"])).not.toBe(m.createWith(["a", "b"]));
    expect(m.createWith([])).toBe(m.createWith([]));
    const row = m.createWith(["b", "a"])([1, 2, 3], ["B", "A"], m.rowMeta("loaded", undefined));
    expect(Object.keys(row)).toEqual(["id", "aId", "bId", "b", "a"]);
    expect(row).toMatchObject({ a: "A", b: "B" });
    const none = m.createWith([])([1, 2, 3], [], m.rowMeta("loaded", undefined));
    expect(Reflect.ownKeys(none)).toEqual(
      Reflect.ownKeys(m.create([1, 2, 3], m.rowMeta("loaded", undefined))),
    );
  });

  test("refuses a name that is not an association, or one given twice", () => {
    const m = meta(User);
    expect(() => m.createWith(["email"])).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.createWithUnknown: User has no association "email". It has: posts. Preload only associations the schema declares. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-createwithunknown]`,
    );
    expect(() => m.createWith(["posts", "posts"])).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.createWithTwice: User: the association "posts" is listed twice in createWith(). List each association once. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-createwithtwice]`,
    );
    expect(() => meta(Schema("lonely", { id: t.integer().primaryKey() })).createWith(["x"])).toThrow(
      /It has: none/,
    );
  });
});

describe("toJSON", () => {
  test("is a plain object of the fields, without the redacted ones", () => {
    const user = loadedUser();
    const json = toJSON(user) as Record<string, unknown>;
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(json).toEqual({
      id: 1,
      email: "ada@example.com",
      name: null,
      role: "member",
      loginCount: 3,
      password: undefined,
      settings: { theme: "dark" },
      lockVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect("passwordHash" in json).toBe(false);
    expect(JSON.parse(JSON.stringify(user))).toEqual({
      id: 1,
      email: "ada@example.com",
      name: null,
      role: "member",
      loginCount: 3,
      settings: { theme: "dark" },
      lockVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  test("lives on the prototype, not on each row", () => {
    const user = loadedUser();
    expect(Object.hasOwn(user, "toJSON")).toBe(false);
    expect((user as unknown as { toJSON: unknown }).toJSON).toBe(
      (loadedPost(1) as unknown as { toJSON: unknown }).toJSON,
    );
    expect(Object.keys(Object.getPrototypeOf(User.prototype) as object)).toEqual([]);
  });

  test("includes preloaded associations and redacts at every level", () => {
    const m = meta(User);
    const post = meta(Post).createWith(["author"])(
      [1, 1, "Post 1", "s3cret"],
      [loadedUser()],
      meta(Post).rowMeta("loaded", undefined),
    );
    const user = m.createWith(["posts"])(
      USER_VALUES,
      [[post, loadedPost(2)]],
      m.rowMeta("loaded", undefined),
    );
    const json = toJSON(user) as { posts: Record<string, unknown>[] };
    expect(json.posts).toEqual([
      {
        id: 1,
        authorId: 1,
        title: "Post 1",
        author: expect.not.objectContaining({ passwordHash: expect.anything() }),
      },
      { id: 2, authorId: 1, title: "Post 2" },
    ]);
    expect(Object.getPrototypeOf(json.posts[0])).toBe(Object.prototype);
    const text = JSON.stringify(user);
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("$2b$hash");
    expect(JSON.parse(text).posts[0].author.email).toBe("ada@example.com");
  });

  test("leaves values that are not rows as they are", () => {
    const user = loadedUser();
    const json = toJSON(user) as Record<string, unknown>;
    expect(json.settings).toBe(user.settings);
    expect(json.createdAt).toBe(NOW);
  });

  test("a class may define its own toJSON, which nested serialisation honours", () => {
    class Custom extends Schema("custom", { id: t.integer().primaryKey(), secret: t.string().redact() }) {
      toJSON(): Record<string, unknown> {
        return { custom: this.id };
      }
    }
    class Holder extends Schema("holders", { id: t.integer().primaryKey(), customId: t.integer() }) {
      static custom = belongsTo(() => Custom);
    }
    const custom = meta(Custom).create([5, "x"], meta(Custom).rowMeta("loaded", undefined));
    const holder = meta(Holder).createWith(["custom"])(
      [1, 5],
      [custom],
      meta(Holder).rowMeta("loaded", undefined),
    );
    expect(JSON.stringify(holder)).toBe('{"id":1,"customId":5,"custom":{"custom":5}}');
    const broken = meta(Holder).createWith(["custom"])(
      [1, 5],
      [
        Object.assign(Object.create(null) as object, {
          [ROW]: meta(Custom).rowMeta("loaded", undefined),
          id: 9,
        }),
      ],
      meta(Holder).rowMeta("loaded", undefined),
    ) as { toJSON(): { custom: unknown } };
    expect(broken.toJSON().custom).toMatchObject({ id: 9 });
  });
});

describe("inspect", () => {
  test("shows the class name and the fields, with redacted values masked", () => {
    expect(inspect(loadedUser(), { breakLength: Number.POSITIVE_INFINITY })).toBe(
      "User { id: 1, email: 'ada@example.com', name: null, role: 'member', loginCount: 3, password: undefined, passwordHash: **redacted**, settings: { theme: 'dark' }, lockVersion: 1, createdAt: 2026-10-13T00:00:00.000Z, updatedAt: 2026-10-13T00:00:00.000Z }",
    );
    expect(inspect(loadedUser())).not.toContain("$2b$hash");
    expect(inspect(loadedUser())).not.toContain("Symbol(egon.row)");
  });

  test("redacts at every level of a preloaded tree", () => {
    const m = meta(User);
    const user = m.createWith(["posts"])(USER_VALUES, [[loadedPost(1)]], m.rowMeta("loaded", undefined));
    const text = inspect({ wrapped: [user] }, { depth: 10 });
    expect(text).toContain("secret: **redacted**");
    expect(text).toContain("passwordHash: **redacted**");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("$2b$hash");
    expect(text).toContain("Post {");
  });

  test("honours the depth it is given", () => {
    const user = loadedUser();
    expect(inspect({ a: { b: { c: user } } })).toContain("c: [User]");
    expect(inspect(user, { depth: 0 })).toContain("settings: [Object]");
    expect(inspect(user, { depth: null })).toContain("theme: 'dark'");
    expect(inspect([user], { depth: 0 })).toBe("[ [User] ]");
  });

  test("without an inspect function to delegate to, formats the row itself", () => {
    const user = loadedUser();
    const custom = (user as unknown as Record<symbol, (depth: number, options: object) => string>)[
      Symbol.for("nodejs.util.inspect.custom")
    ];
    const text = custom?.call(user, 2, {});
    expect(text).toContain('User { id: 1, email: "ada@example.com"');
    expect(text).toContain("passwordHash: **redacted**");
    expect(text).not.toContain("$2b$hash");
  });

  test("names a row whose class has no name", () => {
    const Anonymous = (() => class extends Schema("things", { id: t.integer().primaryKey() }) {})();
    const row = meta(Anonymous).create([1], meta(Anonymous).rowMeta("loaded", undefined));
    expect(inspect(row)).toBe("Row { id: 1 }");
  });
});

describe("a class gets metadata of its own", () => {
  test("the first meta() call binds it; later calls return the same object", () => {
    class Thing extends Schema("things", { id: t.integer().primaryKey() }) {}
    const base = Object.getPrototypeOf(Thing) as AnySchema;
    expect(Object.hasOwn(Thing, META)).toBe(false);
    const m = meta(Thing);
    expect(Object.hasOwn(Thing, META)).toBe(true);
    expect(Thing[META]).toBe(m);
    expect(meta(Thing)).toBe(m);
    expect(m.name).toBe("Thing");
    expect(meta(base)).not.toBe(m);
    expect(meta(base).name).toBe('Schema("things")');
    expect(meta(base).fields).toBe(m.fields);
    expect(meta(base).rowMeta("loaded", undefined)).toBe(m.rowMeta("loaded", undefined));
  });

  test("the class that Schema() returns can be used without extending it", () => {
    const Event = Schema("events", { id: t.integer().primaryKey(), name: t.string() });
    const m = meta(Event);
    expect(m.name).toBe('Schema("events")');
    const row = m.create([1, "signup"], m.rowMeta("loaded", undefined));
    expect(row).toBeInstanceOf(Event);
    expect(JSON.stringify(row)).toBe('{"id":1,"name":"signup"}');
    expect(m.assocs().size).toBe(0);
  });

  test("two classes on one base are two schemas with the same fields", () => {
    const Base = Schema("things", { id: t.integer().primaryKey() });
    class A extends Base {
      get kind(): string {
        return "a";
      }
    }
    class B extends Base {
      get kind(): string {
        return "b";
      }
    }
    const a = meta(A).create([1], meta(A).rowMeta("loaded", undefined)) as A;
    const b = meta(B).create([1], meta(B).rowMeta("loaded", undefined)) as B;
    expect([a.kind, b.kind]).toEqual(["a", "b"]);
    expect(a).not.toBeInstanceOf(B);
    expect(meta(A).name).toBe("A");
    expect(meta(B).name).toBe("B");
  });

  test("a class that extends a schema class inherits its fields and associations and adds its own", () => {
    class Admin extends User {
      static audits = hasMany(() => Post, { foreignKey: "authorId" });
      get isAdmin(): boolean {
        return true;
      }
    }
    const m = meta(Admin);
    expect(m.name).toBe("Admin");
    expect(m.source).toBe("users");
    expect(m.fields).toBe(meta(User).fields);
    expect([...m.assocs().keys()]).toEqual(["posts", "audits"]);
    expect(m.assocs().get("posts")?.owner).toBe(Admin);
    expect([...meta(User).assocs().keys()]).toEqual(["posts"]);
    const admin = m.create(USER_VALUES, m.rowMeta("loaded", undefined)) as Admin;
    expect(admin).toBeInstanceOf(Admin);
    expect(admin).toBeInstanceOf(User);
    expect(admin.isAdmin).toBe(true);
    expect(admin.displayName).toBe("ada@example.com");
    expect(inspect(admin)).toMatch(/^Admin \{/);
  });

  test("a static member of the subclass hides an inherited association of the same name", () => {
    class Quiet extends User {
      static override posts = 42 as never;
    }
    expect([...meta(Quiet).assocs().keys()]).toEqual([]);
  });

  test("an anonymous class takes the name of what it extends", () => {
    const Anonymous = (() => class extends Schema("things", { id: t.integer().primaryKey() }) {})();
    expect(meta(Anonymous).name).toBe('Schema("things")');
  });

  test("metadata put on a class by hand is returned as it is", () => {
    const fake = { name: "Fake" } as unknown as SchemaMeta;
    const Fake = Object.assign(function Fake() {}, { [META]: fake, fields: {} });
    expect(meta(Fake as unknown as AnySchema)).toBe(fake);
  });

  test("what is not a schema class is refused", () => {
    expect(() => meta(Date as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.notSchemaClass: Expected a schema class (a class that extends Schema(...) or EmbeddedSchema(...)), but got the function Date. Pass the class you declared with class User extends Schema("users", { ... }) {}, not an instance, a row or a plain object. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-notschemaclass]`,
    );
    expect(() => meta(loadedUser() as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.notSchemaClass: Expected a schema class (a class that extends Schema(...) or EmbeddedSchema(...)), but got an object. Pass the class you declared with class User extends Schema("users", { ... }) {}, not an instance, a row or a plain object. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-notschemaclass]`,
    );
    expect(() => meta(undefined as never)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.notSchemaClass: Expected a schema class (a class that extends Schema(...) or EmbeddedSchema(...)), but got undefined. Pass the class you declared with class User extends Schema("users", { ... }) {}, not an instance, a row or a plain object. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-notschemaclass]`,
    );
    expect(() => meta(null as never)).toThrow(SchemaDefinitionError);
    expect(() => meta("users" as never)).toThrow(SchemaDefinitionError);
    const Inherits = Object.assign(function Inherits() {}, { [META]: { name: "Fake" } });
    const Child = Object.setPrototypeOf(function Child() {}, Inherits) as unknown;
    expect(() => meta(Child as never)).toThrow(SchemaDefinitionError);
    expect(() => fieldNames(Date as never)).toThrow(SchemaDefinitionError);
  });
});

describe("embedded schemas", () => {
  class Address extends EmbeddedSchema({
    street: t.string(),
    postCode: t.string().nullable(),
    secret: t.string().nullable().redact(),
  }) {
    get line(): string {
      return `${this.street} ${this.postCode ?? ""}`.trim();
    }
  }
  class Phone extends EmbeddedSchema({ id: t.uuid().primaryKey().autogenerate(), number: t.string() }) {}
  class Contact extends Schema("contacts", {
    id: t.integer().primaryKey(),
    address: t.embedOne(() => Address).nullable(),
    phones: t.embedMany(() => Phone, { onReplace: "delete" }).column("phone_list"),
  }) {}

  test("an embedded schema has fields and no table, needs no key, and keeps field names as JSON keys", () => {
    const m = meta(Address);
    expect(m.name).toBe("Address");
    expect(m.source).toBeNull();
    expect(m.schema).toBeUndefined();
    expect(m.primaryKey).toEqual([]);
    expect(m.fields.map((f) => f.column)).toEqual(["street", "postCode", "secret"]);
    expect(meta(Phone).primaryKey.map((f) => f.name)).toEqual(["id"]);
    expect(meta(EmbeddedSchema({ postCode: t.string() }, { naming: "snake_case" })).fields[0]?.column).toBe(
      "post_code",
    );
    expect(meta(EmbeddedSchema({ postCode: t.string().column("pc") })).fields[0]?.column).toBe("pc");
    expect(meta(EmbeddedSchema({ a: t.string() })).name).toBe("EmbeddedSchema");
  });

  test("its rows are instances of the class, marked as having no table", () => {
    const m = meta(Address);
    const address = m.create(["1 Main St", null, "x"], m.rowMeta("loaded", undefined)) as Address;
    expect(address).toBeInstanceOf(Address);
    expect(address.line).toBe("1 Main St");
    expect(m.rowMeta("loaded", undefined)).toEqual({ state: "loaded", source: null, schema: undefined });
    expect(JSON.stringify(address)).toBe('{"street":"1 Main St","postCode":null}');
    expect(inspect(address)).toContain("secret: **redacted**");
  });

  test("an embed is listed among the fields and among the embeds", () => {
    const m = meta(Contact);
    expect(m.fields.map((f) => f.name)).toEqual(["id", "address", "phones"]);
    expect(m.persisted.map((f) => f.column)).toEqual(["id", "address", "phone_list"]);
    expect(field(Contact, "address")).toMatchObject({ nullable: true });
    expect(field(Contact, "address").type.db).toEqual({ kind: "jsonb" });
    expect(m.embeds).toHaveLength(2);
    expect(m.embeds[0]).toMatchObject({
      name: "address",
      cardinality: "one",
      onReplace: "error",
      column: "address",
    });
    expect(m.embeds[0]?.schema()).toBe(Address);
    expect(m.embeds[1]).toMatchObject({
      name: "phones",
      cardinality: "many",
      onReplace: "delete",
      column: "phone_list",
    });
    expect(m.embeds[1]?.schema()).toBe(Phone);
    expect(Object.keys(m.embeds[0] ?? {})).toEqual(Object.keys(m.embeds[1] ?? {}));
    expect(field(Contact, "phones").default?.kind).toBe("fn");
  });

  test("embedded rows inside a row serialise with it, redacted", () => {
    const address = meta(Address).create(
      ["1 Main St", "0150", "x"],
      meta(Address).rowMeta("loaded", undefined),
    );
    const phone = meta(Phone).create(["id-1", "555"], meta(Phone).rowMeta("loaded", undefined));
    const contact = meta(Contact).create([1, address, [phone]], meta(Contact).rowMeta("loaded", undefined));
    expect(JSON.stringify(contact)).toBe(
      '{"id":1,"address":{"street":"1 Main St","postCode":"0150"},"phones":[{"id":"id-1","number":"555"}]}',
    );
    expect(toJSON(contact)).toEqual({
      id: 1,
      address: { street: "1 Main St", postCode: "0150" },
      phones: [{ id: "id-1", number: "555" }],
    });
    expect(inspect(contact, { depth: 5 })).not.toContain("'x'");
  });

  test("has no public constructor either", () => {
    expect(() => new (Address as unknown as new () => object)()).toThrow(/Address has no public constructor/);
  });

  test("definition errors name it", () => {
    expect(() => EmbeddedSchema({ toJSON: t.string() })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.reservedName: EmbeddedSchema: field "toJSON" has a reserved name. A field cannot be named "constructor", "__proto__" or "toJSON", or start with "$". Rename it, and keep the column with .column("toJSON"). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-reservedname]`,
    );
    expect(() => EmbeddedSchema(null as never)).toThrow(SchemaDefinitionError);
  });
});

describe("helpers", () => {
  test("isSchema tells a schema class from everything else", () => {
    expect(isSchema(User)).toBe(true);
    expect(isSchema(Object.getPrototypeOf(User))).toBe(true);
    expect(isSchema(EmbeddedSchema({ a: t.string() }))).toBe(true);
    for (const other of [
      loadedUser(),
      () => User,
      Date,
      class {},
      null,
      undefined,
      "User",
      {},
      { [META]: {} },
    ]) {
      expect(isSchema(other)).toBe(false);
    }
    expect(isSchema(Object.assign(function Broken() {}, { [META]: null }))).toBe(false);
  });

  test("isRow tells a row from everything else", () => {
    expect(isRow(loadedUser())).toBe(true);
    for (const other of [User, { id: 1 }, null, undefined, 1, "row", [], User.prototype]) {
      expect(isRow(other)).toBe(false);
    }
  });

  test("stateOf gives the state of a row", () => {
    const m = meta(User);
    expect(stateOf(loadedUser())).toBe("loaded");
    expect(stateOf(m.create(USER_VALUES, m.rowMeta("deleted", undefined)))).toBe("deleted");
    expect(stateOf(m.create(USER_VALUES, m.rowMeta("built", undefined)))).toBe("built");
    expect(() => stateOf({ id: 1 })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.stateNotRow: stateOf() expects a row: an object returned by a query or a write. A plain object has no state. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-statenotrow]`,
    );
  });

  test("primaryKeyOf gives the key's value, or an object for a composite key", () => {
    class Membership extends Schema("memberships", {
      orgId: t.uuid().primaryKey(),
      userId: t.integer().primaryKey(),
      role: t.string(),
    }) {}
    const mm = meta(Membership);
    const membership = mm.create(["org-1", 7, "admin"], mm.rowMeta("loaded", undefined)) as Membership;
    expect(primaryKeyOf(loadedUser())).toBe(1);
    expect(primaryKeyOf(loadedUser(), User)).toBe(1);
    expect(primaryKeyOf(membership)).toEqual({ orgId: "org-1", userId: 7 });
    expect(primaryKeyOf(membership, Membership)).toEqual({ orgId: "org-1", userId: 7 });
    expect(Object.keys(primaryKeyOf(membership) as object)).toEqual(["orgId", "userId"]);
  });

  test("primaryKeyOf works for a row of a subclass and with loaded associations", () => {
    class Admin extends User {}
    const admin = meta(Admin).create(USER_VALUES, meta(Admin).rowMeta("loaded", undefined));
    expect(primaryKeyOf(admin)).toBe(1);
    const withPosts = meta(User).createWith(["posts"])(
      USER_VALUES,
      [[]],
      meta(User).rowMeta("loaded", undefined),
    );
    expect(primaryKeyOf(withPosts)).toBe(1);
  });

  test("primaryKeyOf refuses what has no key", () => {
    class Event extends Schema("events", { name: t.string() }, { primaryKey: false }) {}
    const event = meta(Event).create(["signup"], meta(Event).rowMeta("loaded", undefined));
    expect(() => primaryKeyOf(event)).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.keylessRow: Event has no primary key, so its rows have no key value. The schema is declared with { primaryKey: false }, or is an embedded schema without a key field. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-keylessrow]`,
    );
    expect(() => primaryKeyOf({ id: 1 })).toThrowErrorMatchingInlineSnapshot(
      `[SchemaDefinitionError: schema.notRow: primaryKeyOf() expects a row: an object returned by a query or a write. Pass a row returned by a query or a write, not a plain object or a changeset. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-notrow]`,
    );
    expect(() => primaryKeyOf(null as never)).toThrow(SchemaDefinitionError);
    expect(() => primaryKeyOf(User.prototype)).toThrow(SchemaDefinitionError);
  });
});

describe("the hot path", () => {
  test("making rows defines no property descriptors and creates no proxies", () => {
    const m = meta(User);
    const rowMeta = m.rowMeta("loaded", undefined);
    const withPosts = m.createWith(["posts"]);
    let calls: number[] = [];
    const defineProperty = vi.spyOn(Object, "defineProperty");
    const defineProperties = vi.spyOn(Object, "defineProperties");
    const reflectDefine = vi.spyOn(Reflect, "defineProperty");
    // Installing the spies defines properties; only what follows counts.
    defineProperty.mockClear();
    defineProperties.mockClear();
    reflectDefine.mockClear();
    try {
      for (let i = 0; i < 100; i++) {
        m.create(USER_VALUES, rowMeta);
        withPosts(USER_VALUES, [[]], rowMeta);
      }
      // Read before asserting: expect() defines properties of its own.
      calls = [
        defineProperty.mock.calls.length,
        defineProperties.mock.calls.length,
        reflectDefine.mock.calls.length,
      ];
    } finally {
      vi.restoreAllMocks();
    }
    expect(calls).toEqual([0, 0, 0]);
    for (const key of Object.keys(loadedUser())) {
      expect(Object.getOwnPropertyDescriptor(loadedUser(), key)).toMatchObject({
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });

  test("integer and timestamp types are shared objects, so a field adds no allocation per schema", () => {
    expect(field(User, "id").type).toBe(integerType());
    expect(field(User, "createdAt").type).toBe(field(User, "updatedAt").type);
  });
});
