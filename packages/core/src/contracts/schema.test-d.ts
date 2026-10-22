// Type tests for the schema contract, on a hand-written fake of the schema API: nothing
// here is implemented (step 04 does that); `declare` gives the signatures the contract
// prescribes. The first half ports every assertion of docs/plan/spikes/schema-typing.ts.
import { describe, expectTypeOf, test } from "vitest";
import type {
  AnyFieldBuilder,
  AnySchema,
  Assoc,
  AssocKeys,
  DefaultFieldFlags,
  FieldBuilder,
  FieldFlagsOf,
  FieldNames,
  FieldsShape,
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
  SchemaClass,
  Target,
  ValidPreload,
} from "./schema.js";

// --- The fake schema API ---------------------------------------------------

declare const t: {
  string(): FieldBuilder<string>;
  integer(): FieldBuilder<number>;
  boolean(): FieldBuilder<boolean>;
  uuid(): FieldBuilder<string>;
  enum<const V extends string>(values: readonly V[]): FieldBuilder<V>;
};
declare function Schema<const F extends FieldsShape>(source: string, fields: F): SchemaClass<F>;
// A literal `foreignKey` is captured as the third parameter of `Assoc`, as for `belongsTo`.
declare function hasMany<T, const FK extends string>(
  target: () => T,
  options: { foreignKey: FK },
): Assoc<"hasMany", T, FK>;
declare function hasMany<T>(target: () => T): Assoc<"hasMany", T, undefined>;
declare function hasOne<T, const FK extends string>(
  target: () => T,
  options: { foreignKey: FK },
): Assoc<"hasOne", T, FK>;
declare function hasOne<T>(target: () => T): Assoc<"hasOne", T, undefined>;
declare function manyToMany<T>(
  target: () => T,
  options: { joinThrough: string },
): Assoc<"manyToMany", T, undefined>;
declare function belongsTo<T>(target: () => T): Assoc<"belongsTo", T, undefined>;
declare function belongsTo<T, const FK extends string | readonly string[]>(
  target: () => T,
  options: { foreignKey: FK },
): Assoc<"belongsTo", T, FK>;

// --- Circular, self-referential and mutually recursive schemas (decision D1) ---

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  managerId: t.integer().nullable(),
  createdAt: t.string().autogenerate(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
  static profile = hasOne(() => Profile, { foreignKey: "userId" });
  static manager = belongsTo(() => User);
  static tags = manyToMany(() => Tag, { joinThrough: "users_tags" });
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
  static comments = hasMany(() => Comment);
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
      createdAt?: string;
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
    expectTypeOf<PreloadKey<typeof Post, "comments">>().toBeNever();
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
