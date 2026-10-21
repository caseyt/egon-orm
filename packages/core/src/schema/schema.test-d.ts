// Type tests for the schema API, against the real implementation. The first half ports
// every assertion of docs/plan/spikes/schema-typing.ts and of the contract's own type
// tests (contracts/schema.test-d.ts, which run on a hand-written fake); the second half
// covers what only the implementation has: the types of `t`, timestamps, embeds, the
// options of the association functions and the reflection helpers.
import { describe, expectTypeOf, test } from "vitest";
import type {
  AnyFieldBuilder,
  AnySchema,
  AssocKeys,
  DefaultFieldFlags,
  FieldBuilder,
  FieldFlagsOf,
  FieldNames,
  FieldValueOf,
  InsertShape,
  Loaded,
  LoadedAs,
  LoadedUnchecked,
  PreloadElement,
  PreloadKey,
  PreloadSpec,
  PrimaryKeyNames,
  PrimaryKeyOf,
  Row,
  SchemaMeta,
  Target,
  ValidPreload,
  WithFlag,
} from "../contracts/schema.js";
import type { AnyFieldType, FieldType } from "../contracts/type.js";
import { defineType } from "../types/index.js";
import {
  belongsTo,
  EmbeddedSchema,
  fieldNames,
  fieldTypeOf,
  hasMany,
  hasOne,
  isRow,
  isSchema,
  manyToMany,
  meta,
  primaryKeyOf,
  Schema,
  stateOf,
  t,
  timestamps,
} from "./index.js";

// --- Circular, self-referential and mutually recursive schemas (decision D1) ---

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  managerId: t.integer().nullable(),
  createdAt: t.timestamp().autogenerate(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
  static profile = hasOne(() => Profile, { foreignKey: "userId" });
  static manager = belongsTo(() => User);
  static tags = manyToMany(() => Tag, {
    joinThrough: "users_tags",
    joinKeys: { owner: "user_id", target: "tag_id" },
  });
  static notAnAssociation = 42;

  get display(): string {
    return `${this.name} (${this.age})`;
  }
}

class Profile extends Schema("profiles", {
  id: t.integer().primaryKey(),
  userId: t.integer(),
  bio: t.string().nullable(),
}) {
  static user = belongsTo(() => User);
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  published: t.boolean().default(false),
  authorId: t.integer(),
  editorId: t.integer().nullable(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
  static editor = belongsTo(() => User, { foreignKey: "editorId" });
  static comments = hasMany(() => Comment, { foreignKey: "postId" });
}

class Comment extends Schema("comments", {
  id: t.integer().primaryKey(),
  body: t.string(),
  postId: t.integer(),
}) {
  static post = belongsTo(() => Post);
}

class Tag extends Schema("tags", { id: t.integer().primaryKey(), name: t.string().nullable() }) {}

class Membership extends Schema("memberships", {
  orgId: t.uuid().primaryKey(),
  userId: t.integer().primaryKey(),
  role: t.string().default("member"),
}) {
  static user = belongsTo(() => User, { foreignKey: ["userId"] });
}

class Keyless extends Schema("events", { name: t.string() }) {}

describe("assertions ported from spikes/schema-typing.ts", () => {
  test("a Loaded row has its fields, its getters and the loaded associations", () => {
    const u = {} as Loaded<typeof User, "posts" | "manager">;
    expectTypeOf(u.posts[0]!.title).toEqualTypeOf<string>();
    expectTypeOf(u.name).toEqualTypeOf<string | null>();
    expectTypeOf(u.display).toEqualTypeOf<string>();
    expectTypeOf(u.manager?.name).toEqualTypeOf<string | null | undefined>();
    expectTypeOf(u).not.toBeAny();
    // @ts-expect-error an unknown property
    u.nope;
    // @ts-expect-error an association that was not preloaded is not a property
    u.profile;
  });

  test("a field is not an association", () => {
    // @ts-expect-error "name" is a field
    expectTypeOf<Loaded<typeof User, "name">>();
    expectTypeOf<AssocKeys<typeof User>>().toEqualTypeOf<"posts" | "profile" | "manager" | "tags">();
  });

  test("associations of both directions load, through a cycle", () => {
    const p = {} as Loaded<typeof Post, "author" | "comments">;
    expectTypeOf(p.author.name).toEqualTypeOf<string | null>();
    expectTypeOf(p.comments[0]!.body).toEqualTypeOf<string>();
    expectTypeOf(p.comments).not.toBeAny();
  });

  test("there is no public constructor, and the class still has its instance type (decision D2)", () => {
    // @ts-expect-error a row comes from the database, never from `new`
    new User();
    // @ts-expect-error not with initial values either: a new record is a changeset
    new User({ name: "a" });
    // @ts-expect-error nor a class that adds nothing to the base
    new Tag();
    const row = {} as User;
    expectTypeOf(row.name).toEqualTypeOf<string | null>();
    expectTypeOf(row.display).toEqualTypeOf<string>();
    expectTypeOf(row).not.toBeAny();
    expectTypeOf<Row<typeof User>>().toEqualTypeOf<User>();
    expectTypeOf(User).toExtend<AnySchema>();
  });

  test("Target resolves the association's schema class", () => {
    expectTypeOf<Target<typeof User, "posts">>().toEqualTypeOf<typeof Post>();
    expectTypeOf<Target<typeof Post, "author">>().toEqualTypeOf<typeof User>();
    expectTypeOf<Target<typeof User, "manager">>().toEqualTypeOf<typeof User>();
    expectTypeOf<Target<typeof User, "notAnAssociation">>().toBeNever();
  });
});

describe("Row", () => {
  test("has every field, virtual ones included, with nullability from the builder", () => {
    type U = Row<typeof User>;
    expectTypeOf<U["id"]>().toEqualTypeOf<number>();
    expectTypeOf<U["email"]>().toEqualTypeOf<string>();
    expectTypeOf<U["name"]>().toEqualTypeOf<string | null>();
    expectTypeOf<U["role"]>().toEqualTypeOf<"admin" | "member">();
    expectTypeOf<U["password"]>().toEqualTypeOf<string>();
    expectTypeOf<U>().not.toBeAny();
  });

  test("is the class instance type, so class members survive", () => {
    expectTypeOf<Row<typeof User>>().toEqualTypeOf<User>();
    expectTypeOf<Row<typeof User>["display"]>().toEqualTypeOf<string>();
  });

  test("has no association properties", () => {
    const u = {} as Row<typeof User>;
    // @ts-expect-error not preloaded
    u.posts;
    expectTypeOf<Row<typeof User>>().not.toHaveProperty("posts");
  });

  test("fields are assignable (rows are plain mutable objects)", () => {
    const u = {} as User;
    u.name = null;
    // @ts-expect-error email is not nullable (decision D3)
    u.email = null;
  });
});

describe("InsertShape", () => {
  test("requires fields that are neither nullable, defaulted, autogenerated nor read back", () => {
    expectTypeOf<InsertShape<typeof User>>().toEqualTypeOf<{
      email: string;
      id?: number;
      name?: string | null;
      age?: number | null;
      role?: "admin" | "member";
      managerId?: number | null;
      createdAt?: Date;
    }>();
    expectTypeOf<InsertShape<typeof User>>().not.toBeAny();
  });

  test("excludes virtual fields", () => {
    expectTypeOf<InsertShape<typeof User>>().not.toHaveProperty("password");
    const ok: InsertShape<typeof User> = { email: "a@b.c" };
    void ok;
    // @ts-expect-error a virtual field is not insertable
    const bad: InsertShape<typeof User> = { email: "a@b.c", password: "x" };
    void bad;
  });

  test("rejects a missing required field and a wrong type", () => {
    // @ts-expect-error email is required
    const missing: InsertShape<typeof User> = { name: "x" };
    void missing;
    // @ts-expect-error role must be one of the enum values
    const wrong: InsertShape<typeof User> = { email: "a@b.c", role: "owner" };
    void wrong;
  });

  test("covers a composite key and a schema with required foreign keys", () => {
    expectTypeOf<InsertShape<typeof Membership>>().toEqualTypeOf<{
      orgId: string;
      userId: number;
      role?: string;
    }>();
    expectTypeOf<InsertShape<typeof Post>>().toEqualTypeOf<{
      title: string;
      authorId: number;
      id?: number;
      published?: boolean;
      editorId?: number | null;
    }>();
  });
});

describe("field builder flags", () => {
  test("each modifier sets its flag and keeps the others", () => {
    const base = t.string();
    expectTypeOf<FieldFlagsOf<typeof base>>().toEqualTypeOf<DefaultFieldFlags>();
    const nullable = base.nullable();
    expectTypeOf<FieldValueOf<typeof nullable>>().toEqualTypeOf<string | null>();
    expectTypeOf<FieldFlagsOf<typeof nullable>["nullable"]>().toEqualTypeOf<true>();
    expectTypeOf<FieldFlagsOf<typeof nullable>["defaulted"]>().toEqualTypeOf<false>();

    const chained = base
      .nullable()
      .default("x")
      .primaryKey()
      .virtual()
      .redact()
      .column("col")
      .writable("insert");
    expectTypeOf<FieldFlagsOf<typeof chained>>().toEqualTypeOf<{
      readonly nullable: true;
      readonly defaulted: true;
      readonly virtual: true;
      readonly primaryKey: true;
      readonly json: false;
    }>();
    expectTypeOf<FieldValueOf<typeof chained>>().toEqualTypeOf<string | null>();

    expectTypeOf<FieldFlagsOf<ReturnType<typeof base.autogenerate>>["defaulted"]>().toEqualTypeOf<true>();
    expectTypeOf<FieldFlagsOf<ReturnType<typeof base.dbGenerated>>["defaulted"]>().toEqualTypeOf<true>();
  });

  test("default() takes the field's type, as a value or a function", () => {
    t.integer().default(0);
    t.integer().default(() => 0);
    t.string().nullable().default(null);
    // @ts-expect-error wrong default type
    t.integer().default("0");
    // @ts-expect-error null is not a default for a non-nullable field
    t.integer().default(null);
    // @ts-expect-error not a writable mode
    t.integer().writable("sometimes");
  });

  test("any builder is an AnyFieldBuilder, and a non-builder is not a field", () => {
    expectTypeOf(t.integer().primaryKey()).toExtend<AnyFieldBuilder>();
    expectTypeOf(t.string().nullable().default(null)).toExtend<AnyFieldBuilder>();
    // @ts-expect-error a plain value is not a field builder
    Schema("x", { id: 1 });
  });

  test("FieldNames lists the fields and nothing else", () => {
    expectTypeOf<FieldNames<typeof Post>>().toEqualTypeOf<
      "id" | "title" | "published" | "authorId" | "editorId"
    >();
  });
});

describe("PrimaryKeyOf", () => {
  test("is the key's type for a single key and an object for a composite key", () => {
    expectTypeOf<PrimaryKeyNames<typeof User>>().toEqualTypeOf<"id">();
    expectTypeOf<PrimaryKeyOf<typeof User>>().toEqualTypeOf<number>();
    expectTypeOf<PrimaryKeyNames<typeof Membership>>().toEqualTypeOf<"orgId" | "userId">();
    expectTypeOf<PrimaryKeyOf<typeof Membership>>().toEqualTypeOf<{ orgId: string; userId: number }>();
    expectTypeOf<PrimaryKeyOf<typeof User>>().not.toBeAny();
  });

  test("is never for a schema without a primary key", () => {
    expectTypeOf<PrimaryKeyNames<typeof Keyless>>().toBeNever();
    expectTypeOf<PrimaryKeyOf<typeof Keyless>>().toBeNever();
  });
});

describe("AssocKeys and Target", () => {
  test("only static members that hold an Assoc are association keys", () => {
    expectTypeOf<AssocKeys<typeof Post>>().toEqualTypeOf<"author" | "editor" | "comments">();
    expectTypeOf<AssocKeys<typeof Tag>>().toBeNever();
    expectTypeOf<AssocKeys<typeof User>>().not.toBeAny();
  });

  test("every schema class is an AnySchema; other classes are not", () => {
    expectTypeOf<typeof User>().toExtend<AnySchema>();
    expectTypeOf<typeof Membership>().toExtend<AnySchema>();
    expectTypeOf<typeof Date>().not.toExtend<AnySchema>();
    // @ts-expect-error not a schema class
    expectTypeOf<Row<typeof Date>>();
  });
});

describe("Loaded", () => {
  test("hasMany and manyToMany become arrays", () => {
    type L = Loaded<typeof User, "posts" | "tags">;
    expectTypeOf<L["posts"]>().toEqualTypeOf<Post[]>();
    expectTypeOf<L["tags"]>().toEqualTypeOf<Tag[]>();
  });

  test("hasOne is nullable", () => {
    expectTypeOf<Loaded<typeof User, "profile">["profile"]>().toEqualTypeOf<Profile | null>();
  });

  test("belongsTo follows the nullability of its foreign key", () => {
    // explicit foreignKey, non-null
    expectTypeOf<Loaded<typeof Post, "author">["author"]>().toEqualTypeOf<User>();
    // explicit foreignKey, nullable
    expectTypeOf<Loaded<typeof Post, "editor">["editor"]>().toEqualTypeOf<User | null>();
    // default foreignKey "<name>Id", non-null
    expectTypeOf<Loaded<typeof Comment, "post">["post"]>().toEqualTypeOf<Post>();
    expectTypeOf<Loaded<typeof Profile, "user">["user"]>().toEqualTypeOf<User>();
    // default foreignKey "<name>Id", nullable
    expectTypeOf<Loaded<typeof User, "manager">["manager"]>().toEqualTypeOf<User | null>();
    // composite foreignKey, all parts non-null
    expectTypeOf<Loaded<typeof Membership, "user">["user"]>().toEqualTypeOf<User>();
  });

  test("belongsTo is nullable when the foreign key cannot be determined", () => {
    class Orphan extends Schema("orphans", { id: t.integer().primaryKey() }) {
      static owner = belongsTo(() => User);
      static widened = belongsTo(() => User, { foreignKey: "id" as string });
    }
    expectTypeOf<Loaded<typeof Orphan, "owner">["owner"]>().toEqualTypeOf<User | null>();
    expectTypeOf<Loaded<typeof Orphan, "widened">["widened"]>().toEqualTypeOf<User | null>();
  });

  test("nests two levels with a string and three levels with objects", () => {
    type Two = Loaded<typeof User, { posts: "comments" }>;
    expectTypeOf<Two["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>();
    expectTypeOf<Two["posts"][number]["title"]>().toEqualTypeOf<string>();

    type Three = Loaded<typeof User, { posts: { comments: "post" } }>;
    expectTypeOf<Three["posts"][number]["comments"][number]["post"]>().toEqualTypeOf<Post>();
    expectTypeOf<Three["posts"][number]["comments"][number]["post"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Three["posts"]>().not.toBeAny();

    const three = {} as Three;
    // @ts-expect-error the innermost post has no preloaded associations
    three.posts[0]!.comments[0]!.post.author;
  });

  test("accepts unions, arrays, `true` and mixtures of them", () => {
    type Mixed = Loaded<typeof User, "profile" | { posts: "comments" | { author: "profile" } }>;
    expectTypeOf<Mixed["profile"]>().toEqualTypeOf<Profile | null>();
    expectTypeOf<Mixed["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>();
    expectTypeOf<Mixed["posts"][number]["author"]["profile"]>().toEqualTypeOf<Profile | null>();

    type FromArray = Loaded<typeof User, readonly ["profile", { posts: readonly ["comments", "author"] }]>;
    expectTypeOf<FromArray["profile"]>().toEqualTypeOf<Profile | null>();
    expectTypeOf<FromArray["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>();
    expectTypeOf<FromArray["posts"][number]["author"]>().toEqualTypeOf<User>();

    type WithTrue = Loaded<typeof User, { posts: true; manager: { posts: true } }>;
    expectTypeOf<WithTrue["posts"]>().toEqualTypeOf<Post[]>();
    expectTypeOf<NonNullable<WithTrue["manager"]>["posts"]>().toEqualTypeOf<Post[]>();
  });

  test("follows a self-reference to any depth", () => {
    type Chain = Loaded<typeof User, { manager: { manager: "manager" } }>;
    expectTypeOf<
      NonNullable<NonNullable<NonNullable<Chain["manager"]>["manager"]>["manager"]>["email"]
    >().toEqualTypeOf<string>();
  });

  test("rejects an unknown association at every depth", () => {
    // @ts-expect-error unknown at the top
    expectTypeOf<Loaded<typeof User, "nope">>();
    // @ts-expect-error unknown one level down
    expectTypeOf<Loaded<typeof User, { posts: "nope" }>>();
    // @ts-expect-error unknown two levels down
    expectTypeOf<Loaded<typeof User, { posts: { comments: "nope" } }>>();
    // @ts-expect-error an object that names no association at all
    expectTypeOf<Loaded<typeof User, { nope: true }>>();
    // @ts-expect-error unknown inside an array
    expectTypeOf<Loaded<typeof User, readonly ["posts", "nope"]>>();

    // Known limit of the `Loaded` TYPE ARGUMENT: an unknown key beside a valid one is
    // ignored, not rejected. TypeScript checks excess properties only on an object literal
    // assigned to a non-generic type, as in the annotated variable below. Functions are
    // generic, so they use ValidPreload instead (see "ValidPreload").
    expectTypeOf<Loaded<typeof User, { posts: true; nope: true }>>().toExtend<Loaded<typeof User, "posts">>();
    expectTypeOf<Loaded<typeof User, { posts: true; nope: true }>>().not.toHaveProperty("nope");

    const good: PreloadSpec<typeof User> = { posts: { comments: "post" }, profile: true };
    void good;
    // @ts-expect-error an unknown key beside a valid one, in a literal
    const bad: PreloadSpec<typeof User> = { posts: true, nope: true };
    void bad;
  });

  test("a Loaded row is still a Row", () => {
    expectTypeOf<Loaded<typeof User, "posts">>().toExtend<Row<typeof User>>();
    expectTypeOf<Loaded<typeof User, { posts: "comments" }>>().toExtend<Loaded<typeof User, "posts">>();
  });
});

// How every function that takes a preload spec is declared.
declare function preload<S extends AnySchema, const P>(
  schema: S,
  spec: P & ValidPreload<S, P>,
): LoadedUnchecked<S, P>;

describe("ValidPreload", () => {
  test("a generic function accepts every valid form and types the result", () => {
    const one = preload(User, "posts");
    expectTypeOf(one.posts).toEqualTypeOf<Post[]>();
    const nested = preload(User, { posts: "comments", profile: true });
    expectTypeOf(nested.posts[0]!.comments).toEqualTypeOf<Comment[]>();
    expectTypeOf(nested.profile).toEqualTypeOf<Profile | null>();
    const deep = preload(User, { posts: { comments: { post: "author" } } });
    expectTypeOf(deep.posts[0]!.comments[0]!.post.author).toEqualTypeOf<User>();
    const list = preload(User, ["profile", { posts: ["comments", "author"] }]);
    expectTypeOf(list.profile).toEqualTypeOf<Profile | null>();
    expectTypeOf(list.posts[0]!.author).toEqualTypeOf<User>();
    expectTypeOf(list.posts[0]!.comments).toEqualTypeOf<Comment[]>();
    expectTypeOf(nested).not.toBeAny();
    expectTypeOf(list).not.toBeAny();
  });

  test("a generic function rejects an unknown association in the string form", () => {
    // @ts-expect-error unknown association
    preload(User, "nope");
    // @ts-expect-error a field is not an association
    preload(User, "email");
    // @ts-expect-error unknown nested association
    preload(User, { posts: "nope" });
  });

  test("a generic function rejects a stray key beside a valid one, at any depth", () => {
    // @ts-expect-error stray key at the top
    preload(User, { posts: true, nope: true });
    // @ts-expect-error stray key one level down
    preload(User, { posts: { comments: true, zzz: true } });
    // @ts-expect-error stray key two levels down
    preload(User, { posts: { comments: { post: true, zzz: true } } });
    // @ts-expect-error an object that names no association
    preload(User, { nope: true });
  });

  test("a generic function rejects unknown names inside arrays", () => {
    // @ts-expect-error unknown name in an array
    preload(User, ["posts", "nope"]);
    // @ts-expect-error stray key in an object in an array
    preload(User, ["profile", { posts: true, nope: true }]);
    // @ts-expect-error unknown name in a nested array
    preload(User, { posts: ["comments", "nope"] });
  });

  test("maps a valid spec to itself and an invalid part to never", () => {
    expectTypeOf<ValidPreload<typeof User, "posts">>().toEqualTypeOf<"posts">();
    expectTypeOf<ValidPreload<typeof User, "nope">>().toBeNever();
    expectTypeOf<ValidPreload<typeof User, { posts: true }>>().toEqualTypeOf<{ readonly posts: true }>();
    expectTypeOf<ValidPreload<typeof User, { posts: true; nope: true }>>().toEqualTypeOf<{
      readonly posts: true;
      readonly nope: never;
    }>();
    expectTypeOf<ValidPreload<typeof User, 42>>().toBeNever();
  });
});

describe("schema-derived types on AnySchema", () => {
  // A signature that defaults its schema parameter to AnySchema must not lose checking.
  test("none of them degrades to any", () => {
    expectTypeOf<Row<AnySchema>>().not.toBeAny();
    expectTypeOf<Row<AnySchema>>().toEqualTypeOf<object>();
    expectTypeOf<Loaded<AnySchema, never>>().not.toBeAny();
    expectTypeOf<InsertShape<AnySchema>>().not.toBeAny();
    expectTypeOf<PrimaryKeyOf<AnySchema>>().not.toBeAny();
    expectTypeOf<PrimaryKeyNames<AnySchema>>().not.toBeAny();
    expectTypeOf<FieldNames<AnySchema>>().not.toBeAny();
    expectTypeOf<AssocKeys<AnySchema>>().not.toBeAny();
    expectTypeOf<Target<typeof User, AssocKeys<typeof User>>>().not.toBeAny();
    expectTypeOf<FieldValueOf<AnyFieldBuilder>>().not.toBeAny();
    expectTypeOf<PreloadSpec<AnySchema>>().not.toBeAny();
  });

  test("a row of an unknown schema has no properties to misuse", () => {
    const rows = [] as Row<AnySchema>[];
    // @ts-expect-error an unknown row is an object, not any
    rows[0]!.anything;
    const generic = <S extends AnySchema>(row: Row<S>): Row<S> => row;
    expectTypeOf(generic<typeof User>({} as User)).toEqualTypeOf<User>();
  });
});

describe("LoadedAs, PreloadKey and PreloadElement (a preload whose callback selects)", () => {
  type Shape = { authorId: number; title: string };

  test("a to-many association is an array of the given element", () => {
    type L = LoadedAs<typeof User, "posts", Shape>;
    expectTypeOf<L["posts"]>().toEqualTypeOf<Shape[]>();
    expectTypeOf<L["email"]>().toEqualTypeOf<string>();
    expectTypeOf<LoadedAs<typeof User, "tags", { name: string | null }>["tags"]>().toEqualTypeOf<
      { name: string | null }[]
    >();
  });

  test("a to-one association is the element, nullable as in Loaded", () => {
    type E = { id: number };
    expectTypeOf<LoadedAs<typeof User, "profile", E>["profile"]>().toEqualTypeOf<E | null>();
    expectTypeOf<LoadedAs<typeof Post, "author", E>["author"]>().toEqualTypeOf<E>();
    expectTypeOf<LoadedAs<typeof Post, "editor", E>["editor"]>().toEqualTypeOf<E | null>();
  });

  test("with the target's row as the element it is Loaded", () => {
    expectTypeOf<LoadedAs<typeof User, "posts", Post>["posts"]>().toEqualTypeOf<
      Loaded<typeof User, "posts">["posts"]
    >();
  });

  test("nesting is the element's own type", () => {
    type Inner = Loaded<typeof Post, "comments">;
    type L = LoadedAs<typeof User, "posts", Inner>;
    expectTypeOf<L["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>();
  });

  test("does not add other associations, and rejects an unknown one", () => {
    const u = {} as LoadedAs<typeof User, "posts", Shape>;
    // @ts-expect-error profile was not loaded
    void u.profile;
    // @ts-expect-error not an association
    expectTypeOf<LoadedAs<typeof User, "nope", Shape>>();
    expectTypeOf<LoadedAs<typeof User, "posts", Shape>>().not.toBeAny();
  });

  test("PreloadKey is the literal foreign key of a hasOne or hasMany, and never otherwise", () => {
    expectTypeOf<PreloadKey<typeof User, "posts">>().toEqualTypeOf<"authorId">();
    expectTypeOf<PreloadKey<typeof User, "profile">>().toEqualTypeOf<"userId">();
    expectTypeOf<PreloadKey<typeof Post, "comments">>().toEqualTypeOf<"postId">();
    expectTypeOf<PreloadKey<typeof Post, "author">>().toBeNever();
    expectTypeOf<PreloadKey<typeof User, "tags">>().toBeNever();
  });

  test("PreloadElement keeps a shape that has the key and rejects one that lacks it", () => {
    expectTypeOf<PreloadElement<typeof User, "posts", Shape>>().toEqualTypeOf<Shape>();
    expectTypeOf<PreloadElement<typeof User, "posts", Post>>().toEqualTypeOf<Post>();
    expectTypeOf<PreloadElement<typeof User, "posts", { title: string }>>().toBeNever();
  });

  test("PreloadElement accepts anything where the key is not known to the types", () => {
    expectTypeOf<PreloadElement<typeof Post, "author", { name: string }>>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<PreloadElement<typeof User, "tags", { name: string }>>().toEqualTypeOf<{ name: string }>();
  });

  test("a generic preload function infers the element from its callback", () => {
    function preloadAs<S extends AnySchema, K extends AssocKeys<S>, E>(
      _schema: S,
      _name: K,
      _fn: () => E & PreloadElement<S, K, E>,
    ): LoadedAs<S, K, E> {
      return {} as LoadedAs<S, K, E>;
    }
    const loaded = preloadAs(User, "posts", () => ({ authorId: 1, title: "t" }));
    expectTypeOf(loaded.posts).toEqualTypeOf<{ authorId: number; title: string }[]>();
    // @ts-expect-error the selected shape lacks the key, authorId
    preloadAs(User, "posts", () => ({ title: "t" }));
  });
});

// ---------------------------------------------------------------------------
// What only the implementation has
// ---------------------------------------------------------------------------

describe("t", () => {
  test("every type gives its application type", () => {
    expectTypeOf(t.string()).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf(t.integer()).toEqualTypeOf<FieldBuilder<number>>();
    expectTypeOf(t.bigint()).toEqualTypeOf<FieldBuilder<bigint>>();
    expectTypeOf(t.bigint({ mode: "bigint" })).toEqualTypeOf<FieldBuilder<bigint>>();
    expectTypeOf(t.bigint({ mode: "number" })).toEqualTypeOf<FieldBuilder<number>>();
    expectTypeOf(t.float()).toEqualTypeOf<FieldBuilder<number>>();
    expectTypeOf(t.decimal()).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf(t.decimal({ precision: 10, scale: 2 })).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf(t.boolean()).toEqualTypeOf<FieldBuilder<boolean>>();
    expectTypeOf(t.uuid()).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf(t.binary()).toEqualTypeOf<FieldBuilder<Uint8Array>>();
    expectTypeOf(t.date()).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf(t.date({ as: "date" })).toEqualTypeOf<FieldBuilder<Date>>();
    expectTypeOf(t.time()).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf(t.timestamp()).toEqualTypeOf<FieldBuilder<Date>>();
    expectTypeOf(t.timestamp({ precision: "us" })).toEqualTypeOf<FieldBuilder<Date>>();
    expectTypeOf(t.localTimestamp()).toEqualTypeOf<FieldBuilder<Date>>();
    expectTypeOf(t.string()).not.toBeAny();
  });

  test("json is typed by its parameter and unknown without one", () => {
    expectTypeOf(t.json<{ theme: string }>()).toEqualTypeOf<FieldBuilder<{ theme: string }>>();
    expectTypeOf(t.json()).toEqualTypeOf<FieldBuilder<unknown>>();
    expectTypeOf<FieldValueOf<ReturnType<typeof t.json>>>().not.toBeAny();
  });

  test("an array is an array of its element, and takes modifiers itself", () => {
    expectTypeOf(t.array(t.string())).toEqualTypeOf<FieldBuilder<string[]>>();
    expectTypeOf(t.array(t.array(t.integer()))).toEqualTypeOf<FieldBuilder<number[][]>>();
    const nullable = t.array(t.enum(["a", "b"])).nullable();
    expectTypeOf<FieldValueOf<typeof nullable>>().toEqualTypeOf<("a" | "b")[] | null>();
    // @ts-expect-error the element takes no modifiers
    t.array(t.string().nullable());
    // @ts-expect-error nor a default
    t.array(t.integer().default(0));
    // @ts-expect-error a field type is not a field builder
    t.array("string");
  });

  test("an enum is the union of its members, or of a mapping's keys", () => {
    expectTypeOf(t.enum(["admin", "member"])).toEqualTypeOf<FieldBuilder<"admin" | "member">>();
    expectTypeOf(t.enum({ low: 1, high: 2 })).toEqualTypeOf<FieldBuilder<"low" | "high">>();
    expectTypeOf(t.enum({ draft: "d", live: "l" })).toEqualTypeOf<FieldBuilder<"draft" | "live">>();
    t.enum(["admin", "member"]).default("member");
    // @ts-expect-error not a member
    t.enum(["admin", "member"]).default("owner");
    // @ts-expect-error an enum has at least one member
    t.enum([]);
  });

  test("a custom type gives its application type", () => {
    class Money {
      constructor(readonly cents: bigint) {}
    }
    const MoneyType = defineType<Money, string>({
      name: "money",
      db: { kind: "decimal" },
      cast: () => ({ success: false }),
      fromDb: (stored) => new Money(BigInt(stored)),
      toDb: (money) => String(money.cents),
    });
    expectTypeOf(t.type(MoneyType)).toEqualTypeOf<FieldBuilder<Money>>();
    const handWritten = {} as FieldType<Date, number>;
    expectTypeOf(t.type(handWritten)).toEqualTypeOf<FieldBuilder<Date>>();
    // @ts-expect-error not a type
    t.type("money");
  });

  test("a builder gives its type to the code that needs one", () => {
    expectTypeOf(fieldTypeOf(t.integer())).toEqualTypeOf<AnyFieldType>();
    expectTypeOf(fieldTypeOf(t.integer())).not.toBeAny();
  });
});

describe("primaryKey", () => {
  test("a key is required on insert, whatever its type", () => {
    class Serial extends Schema("a", { id: t.integer().primaryKey(), name: t.string() }) {}
    class Big extends Schema("b", { id: t.bigint().primaryKey(), name: t.string() }) {}
    class Real extends Schema("c", { id: t.float().primaryKey() }) {}
    class Code extends Schema("d", { code: t.string().primaryKey(), name: t.string() }) {}
    class Uuid extends Schema("e", { id: t.uuid().primaryKey() }) {}
    class Pair extends Schema("f", { a: t.integer().primaryKey(), b: t.integer().primaryKey() }) {}
    expectTypeOf<InsertShape<typeof Serial>>().toEqualTypeOf<{ id: number; name: string }>();
    expectTypeOf<InsertShape<typeof Big>>().toEqualTypeOf<{ id: bigint; name: string }>();
    expectTypeOf<InsertShape<typeof Real>>().toEqualTypeOf<{ id: number }>();
    expectTypeOf<InsertShape<typeof Code>>().toEqualTypeOf<{ code: string; name: string }>();
    expectTypeOf<InsertShape<typeof Uuid>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<InsertShape<typeof Pair>>().toEqualTypeOf<{ a: number; b: number }>();
    expectTypeOf<PrimaryKeyOf<typeof Big>>().toEqualTypeOf<bigint>();
    expectTypeOf<PrimaryKeyOf<typeof Code>>().toEqualTypeOf<string>();
    // @ts-expect-error primaryKey() takes no options; generation is said by .dbGenerated()
    t.integer().primaryKey({ dbGenerated: false });
  });

  test(".dbGenerated() and .autogenerate() make the key optional", () => {
    class Serial extends Schema("a", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {}
    class BigNumber extends Schema("b", { id: t.bigint({ mode: "number" }).primaryKey().dbGenerated() }) {}
    class UuidGenerated extends Schema("c", { id: t.uuid().primaryKey().autogenerate() }) {}
    class Versioned extends Schema("d", {
      id: t.integer().primaryKey().dbGenerated(),
      version: t.integer().primaryKey(),
    }) {}
    expectTypeOf<InsertShape<typeof Serial>>().toEqualTypeOf<{ name: string; id?: number }>();
    expectTypeOf<InsertShape<typeof BigNumber>>().toEqualTypeOf<{ id?: number }>();
    expectTypeOf<InsertShape<typeof UuidGenerated>>().toEqualTypeOf<{ id?: string }>();
    expectTypeOf<InsertShape<typeof Versioned>>().toEqualTypeOf<{ version: number; id?: number }>();
  });
});

describe("InsertShape, by modifier", () => {
  class Every extends Schema("every", {
    id: t.integer().primaryKey().dbGenerated(),
    plain: t.string(),
    nullable: t.string().nullable(),
    defaulted: t.integer().default(0),
    defaultedByFunction: t.json<string[]>().default(() => []),
    autogenerated: t.uuid().autogenerate(),
    dbGenerated: t.integer().dbGenerated(),
    virtual: t.string().virtual(),
    virtualNullable: t.string().nullable().virtual(),
    redacted: t.string().redact(),
    renamed: t.string().column("other"),
    insertOnly: t.string().writable("insert"),
    nullableDefaulted: t.boolean().nullable().default(false),
  }) {}

  test("a field is required unless it is nullable, defaulted, autogenerated or database-generated", () => {
    expectTypeOf<InsertShape<typeof Every>>().toEqualTypeOf<{
      plain: string;
      redacted: string;
      renamed: string;
      insertOnly: string;
      id?: number;
      nullable?: string | null;
      defaulted?: number;
      defaultedByFunction?: string[];
      autogenerated?: string;
      dbGenerated?: number;
      nullableDefaulted?: boolean | null;
    }>();
  });

  test("the row has every field, virtual ones too", () => {
    expectTypeOf<Row<typeof Every>>().toEqualTypeOf<Every>();
    expectTypeOf<Every["virtual"]>().toEqualTypeOf<string>();
    expectTypeOf<Every["virtualNullable"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Every["defaultedByFunction"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Exclude<keyof Every, "~fields">>().toEqualTypeOf<FieldNames<typeof Every>>();
  });
});

describe("timestamps", () => {
  test("gives createdAt and updatedAt, optional on insert", () => {
    expectTypeOf(timestamps()).toEqualTypeOf<{
      createdAt: FieldBuilder<Date, WithFlag<DefaultFieldFlags, "defaulted">>;
      updatedAt: FieldBuilder<Date, WithFlag<DefaultFieldFlags, "defaulted">>;
    }>();
    class Note extends Schema("notes", { id: t.integer().primaryKey().dbGenerated(), ...timestamps() }) {}
    expectTypeOf<Note["createdAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<Note["updatedAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<InsertShape<typeof Note>>().toEqualTypeOf<{
      id?: number;
      createdAt?: Date;
      updatedAt?: Date;
    }>();
  });

  test("a field can be renamed or left out", () => {
    class Renamed extends Schema("a", {
      id: t.integer().primaryKey(),
      ...timestamps({ createdAt: "insertedAt" }),
    }) {}
    expectTypeOf<FieldNames<typeof Renamed>>().toEqualTypeOf<"id" | "insertedAt" | "updatedAt">();
    expectTypeOf<Renamed["insertedAt"]>().toEqualTypeOf<Date>();

    class CreatedOnly extends Schema("b", {
      id: t.integer().primaryKey(),
      ...timestamps({ updatedAt: false }),
    }) {}
    expectTypeOf<FieldNames<typeof CreatedOnly>>().toEqualTypeOf<"id" | "createdAt">();

    class Neither extends Schema("c", {
      id: t.integer().primaryKey(),
      ...timestamps({ createdAt: false, updatedAt: false }),
    }) {}
    expectTypeOf<FieldNames<typeof Neither>>().toEqualTypeOf<"id">();

    timestamps({ type: t.localTimestamp({ precision: "s" }) });
    // @ts-expect-error the type must hold a Date
    timestamps({ type: t.string() });
    // @ts-expect-error a name or false
    timestamps({ createdAt: true });
  });
});

describe("embedded schemas", () => {
  class Address extends EmbeddedSchema({
    street: t.string(),
    city: t.string(),
    postcode: t.string().nullable(),
  }) {
    get line(): string {
      return `${this.street}, ${this.city}`;
    }
  }
  class Phone extends EmbeddedSchema({ id: t.uuid().primaryKey().autogenerate(), number: t.string() }) {}
  class Contact extends Schema("contacts", {
    id: t.integer().primaryKey().dbGenerated(),
    address: t.embedOne(() => Address),
    previous: t.embedOne(() => Address, { onReplace: "update" }).nullable(),
    phones: t.embedMany(() => Phone),
  }) {}

  test("an embedded schema is a schema class with a row type of its own", () => {
    expectTypeOf(Address).toExtend<AnySchema>();
    expectTypeOf<Row<typeof Address>>().toEqualTypeOf<Address>();
    expectTypeOf<Address["postcode"]>().toEqualTypeOf<string | null>();
    expectTypeOf<InsertShape<typeof Address>>().toEqualTypeOf<{
      street: string;
      city: string;
      postcode?: string | null;
    }>();
    expectTypeOf<PrimaryKeyOf<typeof Phone>>().toEqualTypeOf<string>();
    expectTypeOf<PrimaryKeyOf<typeof Address>>().toBeNever();
  });

  test("an embed field is the embedded class, a list of them, or null", () => {
    expectTypeOf<Contact["address"]>().toEqualTypeOf<Address>();
    expectTypeOf<Contact["address"]["line"]>().toEqualTypeOf<string>();
    expectTypeOf<Contact["previous"]>().toEqualTypeOf<Address | null>();
    expectTypeOf<Contact["phones"]>().toEqualTypeOf<Phone[]>();
    expectTypeOf<Contact["phones"]>().not.toBeAny();
  });

  test("a list of embeds starts empty, so it is optional on insert", () => {
    expectTypeOf<InsertShape<typeof Contact>>().toEqualTypeOf<{
      address: Address;
      id?: number;
      previous?: Address | null;
      phones?: Phone[];
    }>();
  });

  test("an embed is a field, never an association", () => {
    expectTypeOf<AssocKeys<typeof Contact>>().toBeNever();
    // @ts-expect-error the embedded schema is given as a function
    t.embedOne(Address);
    // @ts-expect-error not a schema class
    t.embedMany(() => Date);
    // @ts-expect-error not an onReplace mode of an embed
    t.embedOne(() => Address, { onReplace: "setNull" });
  });
});

describe("association options", () => {
  test("hasOne and hasMany require foreignKey, and it must be a field of the target", () => {
    hasMany(() => Post, { foreignKey: "authorId" });
    hasOne(() => Profile, { foreignKey: "userId" });
    hasMany(() => Post, { foreignKey: ["authorId", "editorId"] });
    // @ts-expect-error foreignKey is required
    hasMany(() => Post);
    // @ts-expect-error foreignKey is required
    hasMany(() => Post, {});
    // @ts-expect-error foreignKey is required
    hasOne(() => Profile, { references: "id" });
    // @ts-expect-error Post has no such field
    hasMany(() => Post, { foreignKey: "userId" });
    // @ts-expect-error Profile has no such field
    hasOne(() => Profile, { foreignKey: "authorId" });
  });

  test("where and orderBy are written with the target's fields", () => {
    hasMany(() => Post, {
      foreignKey: "authorId",
      where: { published: true },
      orderBy: ["title", { id: "desc" }],
      onReplace: "delete",
    });
    hasOne(() => Profile, { foreignKey: "userId", where: { bio: null } });
    // @ts-expect-error not a field of Post
    hasMany(() => Post, { foreignKey: "authorId", where: { nope: 1 } });
    // @ts-expect-error not a field of Post
    hasMany(() => Post, { foreignKey: "authorId", orderBy: ["nope"] });
    // @ts-expect-error not a direction
    hasMany(() => Post, { foreignKey: "authorId", orderBy: [{ title: "up" }] });
    // @ts-expect-error hasOne has no order
    hasOne(() => Profile, { foreignKey: "userId", orderBy: ["id"] });
    // @ts-expect-error not an onReplace mode
    hasMany(() => Post, { foreignKey: "authorId", onReplace: "cascade" });
  });

  test("through takes a path of at least two names and nothing else", () => {
    const comments = hasMany(() => Comment, { through: ["posts", "comments"] });
    expectTypeOf(comments.kind).toEqualTypeOf<"hasMany">();
    hasOne(() => Comment, { through: ["posts", "comments", "post"] });
    // @ts-expect-error one step is the association itself
    hasMany(() => Comment, { through: ["posts"] });
  });

  test("belongsTo takes its foreign key by name and references a field of the target", () => {
    belongsTo(() => User);
    belongsTo(() => User, {});
    belongsTo(() => User, { references: "id" });
    belongsTo(() => User, { foreignKey: "authorId", references: "id", onReplace: "update" });
    // @ts-expect-error User has no such field
    belongsTo(() => User, { references: "nope" });
    // @ts-expect-error belongsTo has no optional: the foreign key's nullable() decides
    belongsTo(() => User, { optional: true });
    // @ts-expect-error belongsTo has no order
    belongsTo(() => User, { orderBy: ["id"] });
  });

  test("an options object without a foreign key keeps the default, so nullability is still known", () => {
    class Review extends Schema("reviews", {
      id: t.integer().primaryKey(),
      postId: t.integer(),
      editorId: t.integer().nullable(),
    }) {
      static post = belongsTo(() => Post, { references: "id" });
      static editor = belongsTo(() => User, { onReplace: "setNull" });
    }
    expectTypeOf<Loaded<typeof Review, "post">["post"]>().toEqualTypeOf<Post>();
    expectTypeOf<Loaded<typeof Review, "editor">["editor"]>().toEqualTypeOf<User | null>();
  });

  test("manyToMany through a table requires joinKeys", () => {
    manyToMany(() => Tag, {
      joinThrough: "posts_tags",
      joinKeys: { owner: "post_id", target: "tag_id" },
      where: { name: "x" },
      joinWhere: { deleted_at: null },
      orderBy: ["name"],
      onReplace: "delete",
      unique: true,
    });
    // @ts-expect-error joinKeys is required with a table name
    manyToMany(() => Tag, { joinThrough: "posts_tags" });
    // @ts-expect-error both sides are needed
    manyToMany(() => Tag, { joinThrough: "posts_tags", joinKeys: { owner: "post_id" } });
    // @ts-expect-error joinThrough is required
    manyToMany(() => Tag, {});
    // @ts-expect-error links are not updated in place or set to null
    manyToMany(() => Tag, { joinThrough: "x", joinKeys: { owner: "a", target: "b" }, onReplace: "setNull" });
  });

  test("manyToMany through a join schema takes that schema's fields, or none", () => {
    manyToMany(() => User, { joinThrough: () => Membership });
    manyToMany(() => User, {
      joinThrough: () => Membership,
      joinKeys: { owner: "orgId", target: "userId" },
      joinWhere: { role: "admin" },
    });
    // @ts-expect-error not a field of Membership
    manyToMany(() => User, {
      joinThrough: () => Membership,
      joinKeys: { owner: "org_id", target: "userId" },
    });
    // @ts-expect-error not a field of Membership
    manyToMany(() => User, { joinThrough: () => Membership, joinWhere: { nope: 1 } });
  });

  test("an inherited association is an association of the subclass", () => {
    class Admin extends User {
      static audits = hasMany(() => Post, { foreignKey: "editorId" });
    }
    expectTypeOf<AssocKeys<typeof Admin>>().toEqualTypeOf<
      "posts" | "profile" | "manager" | "tags" | "audits"
    >();
    expectTypeOf<Loaded<typeof Admin, "audits" | "posts">["audits"]>().toEqualTypeOf<Post[]>();
    expectTypeOf<Row<typeof Admin>>().toEqualTypeOf<Admin>();
  });
});

describe("Schema()", () => {
  test("takes the options the guide lists", () => {
    Schema("invoices", { id: t.integer().primaryKey() }, { schema: "billing", naming: "snake_case" });
    Schema("invoices", { id: t.integer().primaryKey() }, { schema: undefined, naming: "camelCase" });
    Schema("events", { name: t.string() }, { primaryKey: false, naming: (field) => field.toUpperCase() });
    Schema("events", { id: t.integer().primaryKey() }, { codegen: false });
    // @ts-expect-error a key is declared on its field
    Schema("events", { name: t.string() }, { primaryKey: true });
    // @ts-expect-error not a naming
    Schema("events", { id: t.integer().primaryKey() }, { naming: "kebab-case" });
    // @ts-expect-error the old name of the option
    Schema("events", { id: t.integer().primaryKey() }, { prefix: "billing" });
    // @ts-expect-error the table name comes first
    Schema({ id: t.integer().primaryKey() });
  });

  test("the class exposes its field builders", () => {
    expectTypeOf(User.fields.email).toEqualTypeOf<FieldBuilder<string>>();
    expectTypeOf<FieldValueOf<(typeof User.fields)["name"]>>().toEqualTypeOf<string | null>();
    expectTypeOf(User.fields).not.toBeAny();
  });

  test("getters and methods of the class are on its rows, and on a Loaded row", () => {
    class Account extends Schema("accounts", { id: t.integer().primaryKey(), cents: t.integer() }) {
      static owner = belongsTo(() => User, { foreignKey: "id" });
      get dollars(): number {
        return this.cents / 100;
      }
      owes(amount: number): boolean {
        return this.cents < amount;
      }
    }
    const row = {} as Row<typeof Account>;
    expectTypeOf(row.dollars).toEqualTypeOf<number>();
    expectTypeOf(row.owes).toEqualTypeOf<(amount: number) => boolean>();
    const loaded = {} as Loaded<typeof Account, "owner">;
    expectTypeOf(loaded.dollars).toEqualTypeOf<number>();
    expectTypeOf(loaded.owner.display).toEqualTypeOf<string>();
  });
});

describe("reflection helpers", () => {
  test("meta returns the metadata contract", () => {
    expectTypeOf(meta(User)).toEqualTypeOf<SchemaMeta>();
    expectTypeOf(meta(User).source).toEqualTypeOf<string | null>();
    // @ts-expect-error a row is not a schema class
    meta({} as User);
    // @ts-expect-error nor is any other class
    meta(Date);
  });

  test("fieldNames is typed by the schema", () => {
    expectTypeOf(fieldNames(Post)).toEqualTypeOf<
      readonly ("id" | "title" | "published" | "authorId" | "editorId")[]
    >();
    expectTypeOf(fieldNames(Post)).not.toBeAny();
  });

  test("primaryKeyOf is typed when it is given the class, and unknown otherwise", () => {
    const user = {} as User;
    const membership = {} as Membership;
    expectTypeOf(primaryKeyOf(user, User)).toEqualTypeOf<number>();
    expectTypeOf(primaryKeyOf(membership, Membership)).toEqualTypeOf<{ orgId: string; userId: number }>();
    expectTypeOf(primaryKeyOf(user)).toEqualTypeOf<unknown>();
    expectTypeOf(primaryKeyOf(user, User)).not.toBeAny();
    // @ts-expect-error the row is not of that schema
    primaryKeyOf(user, Membership);
  });

  test("the guards narrow", () => {
    const value = {} as unknown;
    if (isSchema(value)) expectTypeOf(value).toEqualTypeOf<AnySchema>();
    if (isRow(value)) expectTypeOf(stateOf(value)).toEqualTypeOf<"built" | "loaded" | "deleted">();
    expectTypeOf(stateOf({} as User)).toEqualTypeOf<"built" | "loaded" | "deleted">();
  });
});
