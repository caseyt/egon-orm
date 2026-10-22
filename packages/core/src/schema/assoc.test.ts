import { describe, expect, test } from "vitest";
import type { AnySchema } from "../contracts/schema.js";
import { SchemaDefinitionError } from "../errors.js";
import type { ResolvedAssoc } from "./index.js";
import { belongsTo, EmbeddedSchema, hasMany, hasOne, manyToMany, meta, Schema, t } from "./index.js";

const assoc = (schema: AnySchema, name: string): ResolvedAssoc => {
  const found = meta(schema).assocs().get(name) as ResolvedAssoc | undefined;
  if (found === undefined) throw new Error(`no association ${name}`);
  return found;
};

/** The resolution error of a schema's associations. */
const problem = (schema: AnySchema): unknown => {
  try {
    meta(schema).assocs();
  } catch (error) {
    return error;
  }
  throw new Error("expected the associations to be refused");
};

class User extends Schema("users", {
  id: t.integer().primaryKey(),
  email: t.string(),
  managerId: t.integer().nullable(),
}) {
  static profile = hasOne(() => Profile, { foreignKey: "userId" });
  static posts = hasMany(() => Post, {
    foreignKey: "authorId",
    where: { published: true, deletedAt: null, status: ["live", "pinned"] },
    orderBy: ["title", { createdAt: "desc", id: "asc" }],
    onReplace: "delete",
  });
  static comments = hasMany(() => Comment, { through: ["posts", "comments"] });
  static manager = belongsTo(() => User);
  static reports = hasMany(() => User, { foreignKey: "managerId" });
  static tags = manyToMany(() => Tag, {
    joinThrough: "users_tags",
    joinKeys: { owner: "user_id", target: "tag_id" },
    joinWhere: { hidden: false },
    unique: true,
  });
  static orgs = manyToMany(() => Org, { joinThrough: () => Membership, orderBy: ["name"] });
  static notAnAssociation = 42;
  static get computed(): never {
    throw new Error("a static getter is never run");
  }
}

class Profile extends Schema("profiles", { id: t.integer().primaryKey(), userId: t.integer() }) {
  static user = belongsTo(() => User, { onReplace: "update" });
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey(),
  authorId: t.integer(),
  title: t.string(),
  published: t.boolean(),
  status: t.string(),
  deletedAt: t.timestamp().nullable(),
  createdAt: t.timestamp(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId", references: "id" });
  static comments = hasMany(() => Comment, { foreignKey: "postId" });
}

class Comment extends Schema("comments", { id: t.integer().primaryKey(), postId: t.integer() }) {
  static post = belongsTo(() => Post);
}

class Tag extends Schema("tags", { id: t.integer().primaryKey(), name: t.string() }) {}

class Org extends Schema("orgs", { id: t.uuid().primaryKey(), name: t.string() }) {
  static users = manyToMany(() => User, {
    joinThrough: () => Membership,
    joinKeys: { owner: "orgId", target: "userId" },
    joinWhere: { role: "admin" },
  });
}

class Membership extends Schema("memberships", {
  orgId: t.uuid().primaryKey().column("org_ref"),
  userId: t.integer().primaryKey(),
  role: t.string(),
}) {
  static org = belongsTo(() => Org);
  static user = belongsTo(() => User);
}

describe("each kind resolves to its metadata", () => {
  test("belongsTo: the foreign key is on the owner and defaults to the name plus Id", () => {
    expect(assoc(Comment, "post")).toEqual({
      name: "post",
      kind: "belongsTo",
      owner: Comment,
      target: expect.any(Function),
      ownerKey: ["postId"],
      relatedKey: ["id"],
      joinThrough: undefined,
      joinKeys: undefined,
      through: undefined,
      onReplace: "error",
      where: undefined,
      joinWhere: undefined,
      orderBy: [],
      defaults: undefined,
      unique: false,
    });
    expect(assoc(Comment, "post").target()).toBe(Post);
    expect(assoc(Post, "author")).toMatchObject({ ownerKey: ["authorId"], relatedKey: ["id"] });
    expect(assoc(Profile, "user").onReplace).toBe("update");
    expect(assoc(User, "manager")).toMatchObject({
      ownerKey: ["managerId"],
      relatedKey: ["id"],
      owner: User,
    });
    expect(assoc(User, "manager").target()).toBe(User);
  });

  test("hasOne and hasMany: the foreign key is on the target", () => {
    expect(assoc(User, "profile")).toMatchObject({
      kind: "hasOne",
      ownerKey: ["id"],
      relatedKey: ["userId"],
      onReplace: "error",
      where: undefined,
      orderBy: [],
    });
    expect(assoc(User, "reports")).toMatchObject({
      kind: "hasMany",
      ownerKey: ["id"],
      relatedKey: ["managerId"],
    });
  });

  test("where and orderBy are kept, with the target's field names", () => {
    const posts = assoc(User, "posts");
    expect(posts.where).toEqual({ published: true, deletedAt: null, status: ["live", "pinned"] });
    expect(Object.isFrozen(posts.where)).toBe(true);
    expect(posts.orderBy).toEqual([
      { field: "title", direction: "asc" },
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ]);
    expect(posts.onReplace).toBe("delete");
  });

  test("manyToMany through a table keeps the column names it was given", () => {
    expect(assoc(User, "tags")).toMatchObject({
      kind: "manyToMany",
      ownerKey: ["id"],
      relatedKey: ["id"],
      joinThrough: { source: "users_tags", schema: undefined, model: undefined },
      joinKeys: [
        { column: "user_id", field: "id" },
        { column: "tag_id", field: "id" },
      ],
      joinWhere: { hidden: false },
      unique: true,
      through: undefined,
    });
  });

  test("manyToMany through a join schema finds the join columns from its belongsTo", () => {
    const orgs = assoc(User, "orgs");
    expect(orgs.joinThrough).toEqual({
      source: "memberships",
      schema: undefined,
      model: expect.any(Function),
    });
    expect(orgs.joinThrough?.model?.()).toBe(Membership);
    expect(orgs.joinKeys).toEqual([
      { column: "user_id", field: "id" },
      { column: "org_ref", field: "id" },
    ]);
    expect(orgs.orderBy).toEqual([{ field: "name", direction: "asc" }]);
    expect(orgs.unique).toBe(false);
  });

  test("manyToMany through a join schema takes field names, and turns them into columns", () => {
    expect(assoc(Org, "users")).toMatchObject({
      joinKeys: [
        { column: "org_ref", field: "id" },
        { column: "user_id", field: "id" },
      ],
      joinWhere: { role: "admin" },
    });
  });

  test("a join schema in a database schema carries it", () => {
    class Link extends Schema(
      "links",
      {
        userId: t.integer().primaryKey(),
        tagId: t.integer().primaryKey(),
      },
      { schema: "audit" },
    ) {
      static user = belongsTo(() => User);
      static tag = belongsTo(() => Tag);
    }
    class Linked extends Schema("linked", { id: t.integer().primaryKey() }) {
      static tags = manyToMany(() => Tag, {
        joinThrough: () => Link,
        joinKeys: { owner: "userId", target: "tagId" },
      });
    }
    expect(assoc(Linked, "tags").joinThrough).toMatchObject({ source: "links", schema: "audit" });
  });

  test("has-through keeps the path and has no keys of its own", () => {
    expect(assoc(User, "comments")).toMatchObject({
      kind: "hasMany",
      through: ["posts", "comments"],
      ownerKey: [],
      relatedKey: [],
      onReplace: "error",
    });
    expect(assoc(User, "comments").target()).toBe(Comment);
  });

  test("composite keys pair up in order", () => {
    class Grant extends Schema("grants", {
      id: t.integer().primaryKey(),
      orgId: t.uuid(),
      userId: t.integer(),
    }) {
      static membership = belongsTo(() => Membership, { foreignKey: ["orgId", "userId"] });
    }
    class Holder extends Schema("holders", { id: t.integer().primaryKey() }) {
      static grants = hasMany(() => Grant, { foreignKey: ["userId"], references: ["id"] });
    }
    expect(assoc(Grant, "membership")).toMatchObject({
      ownerKey: ["orgId", "userId"],
      relatedKey: ["orgId", "userId"],
    });
    expect(assoc(Holder, "grants")).toMatchObject({ ownerKey: ["id"], relatedKey: ["userId"] });
  });

  test("integer and bigint-as-number keys match each other", () => {
    class Wide extends Schema("wide", {
      id: t.bigint({ mode: "number" }).primaryKey(),
      ownerId: t.integer(),
    }) {
      static owner = belongsTo(() => User);
    }
    expect(assoc(Wide, "owner").ownerKey).toEqual(["ownerId"]);
  });

  test("every association has the same members in the same order, and is frozen", () => {
    const keys = Object.keys(assoc(Comment, "post"));
    for (const schema of [User, Post, Comment, Org, Membership, Profile] as AnySchema[]) {
      for (const one of meta(schema).assocs().values()) {
        expect(Object.keys(one)).toEqual(keys);
        expect(Object.isFrozen(one)).toBe(true);
      }
    }
  });

  test("associations are listed in declaration order; other statics are ignored and getters are not run", () => {
    expect([...meta(User).assocs().keys()]).toEqual([
      "profile",
      "posts",
      "comments",
      "manager",
      "reports",
      "tags",
      "orgs",
    ]);
    expect(meta(Tag).assocs().size).toBe(0);
  });

  test("the result is resolved once and cached", () => {
    expect(meta(User).assocs()).toBe(meta(User).assocs());
  });
});

describe("resolution is lazy", () => {
  test("a class may point at one that is defined after it, as long as it is used afterwards", () => {
    class Early extends Schema("early", { id: t.integer().primaryKey() }) {
      static lates = hasMany(() => Late, { foreignKey: "earlyId" });
    }
    // Asked before Late exists: the error says why, and nothing is cached.
    const error = problem(Early) as SchemaDefinitionError;
    expect(error.message).toMatchInlineSnapshot(
      `"schema.assocTargetThrew: Early.lates: the function for the target threw (Cannot access 'Late' before initialization). It is called when associations are first used, by which time every schema module must have been loaded. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assoctargetthrew"`,
    );
    expect(error.cause).toBeInstanceOf(ReferenceError);

    class Late extends Schema("late", { id: t.integer().primaryKey(), earlyId: t.integer() }) {
      static early = belongsTo(() => Early);
    }
    expect(assoc(Early, "lates").target()).toBe(Late);
    expect(assoc(Late, "early").target()).toBe(Early);
  });

  test("defining a class checks nothing about its associations", () => {
    expect(() => {
      class Broken extends Schema("broken", { id: t.integer().primaryKey() }) {
        static nope = belongsTo(() => User, { foreignKey: "missing" });
      }
      return Broken;
    }).not.toThrow();
  });

  test("a failure is not cached: once the declaration is corrected, it resolves", () => {
    class Fixable extends Schema("fixable", { id: t.integer().primaryKey(), userId: t.integer() }) {
      static user = belongsTo(() => User, { foreignKey: "ownerId" });
    }
    expect(problem(Fixable)).toBeInstanceOf(SchemaDefinitionError);
    expect(problem(Fixable)).toBeInstanceOf(SchemaDefinitionError);
    Fixable.user = belongsTo(() => User, { foreignKey: "userId" }) as never;
    expect(assoc(Fixable, "user").ownerKey).toEqual(["userId"]);
  });

  test("two schemas whose has-through associations follow each other resolve", () => {
    class Writer extends Schema("writers", { id: t.integer().primaryKey() }) {
      static books = hasMany(() => Book, { foreignKey: "writerId" });
      static readers = hasMany(() => Reader, { through: ["books", "readers"] });
    }
    class Book extends Schema("books", { id: t.integer().primaryKey(), writerId: t.integer() }) {
      static writer = belongsTo(() => Writer);
      static readers = hasMany(() => Reader, { foreignKey: "bookId" });
      static colleagues = hasMany(() => Book, { through: ["writer", "books"] });
    }
    class Reader extends Schema("readers", { id: t.integer().primaryKey(), bookId: t.integer() }) {
      static book = belongsTo(() => Book);
      static writers = hasMany(() => Writer, { through: ["book", "writer"] });
      static fellowReaders = hasMany(() => Reader, { through: ["writers", "readers"] });
    }
    expect(assoc(Reader, "fellowReaders").through).toEqual(["writers", "readers"]);
    expect(assoc(Writer, "readers").target()).toBe(Reader);
    expect(assoc(Book, "colleagues").target()).toBe(Book);
  });

  test("the result does not depend on which schema is asked first", () => {
    const define = () => {
      class A extends Schema("a", { id: t.integer().primaryKey() }) {
        static bs = manyToMany(() => B, { joinThrough: () => J });
      }
      class B extends Schema("b", { id: t.integer().primaryKey() }) {}
      class J extends Schema("j", {
        aId: t.integer().primaryKey(),
        bId: t.integer().primaryKey(),
      }) {
        static a = belongsTo(() => A);
        static b = belongsTo(() => B);
        static siblings = hasMany(() => B, { through: ["a", "bs"] });
      }
      return { A, B, J };
    };
    const first = define();
    expect(assoc(first.A, "bs").joinKeys?.[0].column).toBe("a_id");
    expect(assoc(first.J, "siblings").target()).toBe(first.B);
    const second = define();
    expect(assoc(second.J, "siblings").target()).toBe(second.B);
    expect(assoc(second.A, "bs").joinKeys?.[1].column).toBe("b_id");
  });

  test("a join schema whose own associations go back through the owner resolves", () => {
    class Team extends Schema("teams", { id: t.integer().primaryKey() }) {
      static members = hasMany(() => Seat, { foreignKey: "teamId" });
      static players = manyToMany(() => Player, { joinThrough: () => Seat });
    }
    class Player extends Schema("players", { id: t.integer().primaryKey() }) {}
    class Seat extends Schema("seats", {
      teamId: t.integer().primaryKey(),
      playerId: t.integer().primaryKey(),
    }) {
      static team = belongsTo(() => Team);
      static player = belongsTo(() => Player);
      static teammates = hasMany(() => Seat, { through: ["team", "members"] });
    }
    expect(assoc(Team, "players").joinKeys).toEqual([
      { column: "team_id", field: "id" },
      { column: "player_id", field: "id" },
    ]);
    expect(assoc(Seat, "teammates").target()).toBe(Seat);
  });
});

describe("definition errors name the schema, the association and the fix", () => {
  /** A one-off schema with `fields` and one association named `x`. */
  function owner(declaration: unknown, fields: Record<string, ReturnType<typeof t.integer>> = {}): AnySchema {
    class Owner extends Schema("owners", { id: t.integer().primaryKey(), ...fields }) {
      static x = declaration;
    }
    return Owner;
  }
  const message = (declaration: unknown, fields?: Record<string, ReturnType<typeof t.integer>>): string =>
    (problem(owner(declaration, fields)) as Error).message;

  test("the target", () => {
    expect(message(hasMany(User as never, { foreignKey: "managerId" }))).toMatchInlineSnapshot(
      `"schema.assocTargetThunk: Owner.x: the target must be given as a function that returns the class. Pass a function that returns the class, so that classes can refer to each other: hasMany(() => Post). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assoctargetthunk"`,
    );
    expect(message(belongsTo("User" as never))).toMatch(/the target must be given as a function/);
    expect(message(belongsTo((() => 42) as never))).toMatchInlineSnapshot(
      `"schema.assocTargetNotSchema: Owner.x: the function for the target returned a number, not a schema class. The function must return a class declared with Schema(...), such as () => Post. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assoctargetnotschema"`,
    );
    expect(
      message(
        belongsTo(() => {
          throw "not an error";
        }),
      ),
    ).toMatch(/threw \(a string\)/);
    class Address extends EmbeddedSchema({ city: t.string() }) {}
    expect(message(hasOne(() => Address, { foreignKey: "city" as never }))).toMatchInlineSnapshot(
      `"schema.assocTargetEmbedded: Owner.x: Address is an embedded schema and has no table, so it cannot be the target of an association. Declare it as a field: t.embedOne(() => Address). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assoctargetembedded"`,
    );
  });

  test("the options", () => {
    expect(message(belongsTo(() => User, "userId" as never))).toMatchInlineSnapshot(
      `"schema.assocOptionsNotObject: Owner.x: the options of belongsTo must be an object, but got a string. Pass the options as an object, as in hasMany(() => Post, { foreignKey: "authorId" }). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocoptionsnotobject"`,
    );
    expect(message(belongsTo(() => User, { optional: true } as never))).toMatchInlineSnapshot(
      `"schema.assocUnknownOption: Owner.x: belongsTo has no option "optional". It takes foreignKey, references, onReplace. Remove the option, or check its spelling against the ones listed. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocunknownoption"`,
    );
    expect(message(hasMany(() => Post, { foreignKey: "authorId", onDelete: "cascade" } as never))).toMatch(
      /hasMany has no option "onDelete"/,
    );
    expect(message(hasMany(() => Post, { foreignKey: "authorId", preloadOrder: ["id"] } as never))).toMatch(
      /no option "preloadOrder"/,
    );
    expect(
      message(
        manyToMany(() => Tag, {
          joinThrough: "t",
          joinKeys: { owner: "a", target: "b" },
          through: ["a", "b"],
        } as never),
      ),
    ).toMatch(/manyToMany has no option "through"/);
  });

  test("a foreign key that does not exist, or is virtual", () => {
    expect(message(belongsTo(() => User))).toMatchInlineSnapshot(
      `"schema.belongsToKeyMissing: Owner.x: belongsTo expects the foreign key field "xId" on Owner, but Owner has no such field. Declare the field (as in authorId: t.integer()), or pass { foreignKey } with the field that holds the key. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-belongstokeymissing"`,
    );
    expect(message(belongsTo(() => User, { foreignKey: "ownerId" }))).toMatch(/"ownerId" on Owner/);
    expect(message(hasMany(() => Post, { foreignKey: "ownerId" as never }))).toMatchInlineSnapshot(
      `"schema.hasKeyMissing: Owner.x: hasMany expects the foreign key field "ownerId" on Post, but Post has no such field. Declare the field on Post (as in authorId: t.integer()), or correct { foreignKey }. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-haskeymissing"`,
    );
    class Virtual extends Schema("virtuals", { id: t.integer().primaryKey(), xId: t.integer().virtual() }) {
      static x = belongsTo(() => User);
    }
    expect((problem(Virtual) as Error).message).toMatchInlineSnapshot(
      `"schema.assocFieldVirtual: Virtual.x: the foreign key field "xId" of Virtual is virtual, so it is not stored and cannot be part of an association. Point the association at a stored field: remove .virtual() from it, or use another field. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocfieldvirtual"`,
    );
  });

  test("a foreign key given wrongly", () => {
    expect(
      message(
        belongsTo(() => User, { foreignKey: [] as never }),
        { xId: t.integer() },
      ),
    ).toMatchInlineSnapshot(
      `"schema.assocKeyOption: Owner.x: foreignKey must be a field name, or an array of field names for a composite key. Pass a field name, as in { foreignKey: "authorId" }, or an array of them for a composite key. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assockeyoption"`,
    );
    expect(
      message(
        belongsTo(() => User, { foreignKey: "" }),
        { xId: t.integer() },
      ),
    ).toMatch(/foreignKey must be a field name/);
    expect(message(belongsTo(() => User, { foreignKey: [1] as never }))).toMatch(
      /foreignKey must be a field name/,
    );
    expect(
      message(
        belongsTo(() => User, { references: 5 as never }),
        { xId: t.integer() },
      ),
    ).toMatch(/references must be a field name/);
  });

  test("hasOne and hasMany need a foreign key", () => {
    expect(message(hasMany(() => Post, {} as never))).toMatchInlineSnapshot(
      `"schema.foreignKeyRequired: Owner.x: hasMany needs { foreignKey }: the field on Post that points at Owner. Pass the field, as in hasMany(() => Post, { foreignKey: "authorId" }). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-foreignkeyrequired"`,
    );
    expect(message(hasOne(() => Profile, { where: {} } as never))).toMatch(/hasOne needs \{ foreignKey \}/);
  });

  test("a key the other side points at that cannot be guessed, or does not exist", () => {
    class Keyless extends Schema(
      "keyless",
      { name: t.string(), ownerId: t.integer() },
      { primaryKey: false },
    ) {}
    expect(
      message(
        belongsTo(() => Keyless),
        { xId: t.integer() },
      ),
    ).toMatchInlineSnapshot(
      `"schema.assocNoPrimaryKey: Owner.x: Keyless has no primary key, so the field the key points at cannot be guessed. Pass { references }. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocnoprimarykey"`,
    );
    expect(
      message(
        belongsTo(() => User, { references: "nope" as never }),
        { xId: t.integer() },
      ),
    ).toMatchInlineSnapshot(
      `"schema.referencedFieldMissing: Owner.x: belongsTo expects the referenced field "nope" on User, but User has no such field. Pass { references } with the field the key points at. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-referencedfieldmissing"`,
    );
    class KeylessOwner extends Schema("keyless_owners", { name: t.string() }, { primaryKey: false }) {
      static posts = hasMany(() => Post, { foreignKey: "authorId" });
    }
    expect((problem(KeylessOwner) as Error).message).toMatch(/KeylessOwner has no primary key/);
  });

  test("a foreign key whose type does not match what it points at", () => {
    expect(
      message(
        belongsTo(() => Org),
        { xId: t.integer() },
      ),
    ).toMatchInlineSnapshot(
      `"schema.assocKeyType: Owner.x: the foreign key Owner.xId is of type integer, but Org.id, which it points at, is of type uuid. Declare both with the same type. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assockeytype"`,
    );
    const big = t.bigint() as unknown as ReturnType<typeof t.integer>;
    expect(
      message(
        belongsTo(() => User),
        { xId: big },
      ),
    ).toMatch(/is of type bigint, but User\.id, which it points at, is of type integer/);
    const text = t.string() as unknown as ReturnType<typeof t.integer>;
    expect(() =>
      assoc(
        owner(
          belongsTo(() => Tag, { references: "name" }),
          { xId: text },
        ),
        "x",
      ),
    ).not.toThrow();
  });

  test("an integer key matches a bigint key read as a number, and not a bigint read as a bigint", () => {
    class Wide extends Schema("wide", { id: t.bigint({ mode: "number" }).primaryKey() }) {}
    class Big extends Schema("big", { id: t.bigint().primaryKey() }) {}
    expect(() =>
      assoc(
        owner(
          belongsTo(() => Wide),
          { xId: t.integer() },
        ),
        "x",
      ),
    ).not.toThrow();
    expect(
      message(
        belongsTo(() => Big),
        { xId: t.integer() },
      ),
    ).toMatch(/Owner\.xId is of type integer, but Big\.id, which it points at, is of type bigint/);
  });

  test("custom types match by their SQL type", () => {
    const money = (sql: string) =>
      t.type({
        name: "money",
        db: { kind: "custom", sql },
        cast: () => ({ success: false }),
        fromDb: (value: unknown) => value,
        toDb: (value: unknown) => value,
        equal: Object.is,
      }) as unknown as ReturnType<typeof t.integer>;
    class Priced extends Schema("priced", { id: money("money").primaryKey() }) {}
    expect(() =>
      assoc(
        owner(
          belongsTo(() => Priced),
          { xId: money("money") },
        ),
        "x",
      ),
    ).not.toThrow();
    expect(
      message(
        belongsTo(() => Priced),
        { xId: money("citext") },
      ),
    ).toMatch(/Declare both with the same type/);
  });

  test("a composite key given with the wrong number of fields", () => {
    expect(
      message(
        belongsTo(() => Membership, { foreignKey: "orgId" }),
        { orgId: t.uuid() as never },
      ),
    ).toMatchInlineSnapshot(
      `"schema.assocKeyCount: Owner.x: the foreign key has 1 field(s) ("orgId") but it points at 2 ("orgId", "userId" on Membership). Give one foreign-key field per referenced field, in the same order. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assockeycount"`,
    );
  });

  test("onReplace that the kind does not have", () => {
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", onReplace: "update" as never })),
    ).toMatchInlineSnapshot(
      `"schema.assocOnReplace: Owner.x: onReplace must be one of "error", "invalid", "setNull", "delete", "deleteIfExists" for hasMany. Pick one of the listed modes; "error" (the default) refuses to replace existing associated rows. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assoconreplace"`,
    );
    expect(
      message(
        belongsTo(() => User, { onReplace: "cascade" as never }),
        { xId: t.integer() },
      ),
    ).toMatch(/onReplace must be one of/);
  });

  test("where", () => {
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", where: "published" as never })),
    ).toMatchInlineSnapshot(
      `"schema.assocWhereOption: Owner.x: where must be an object from name to value. Pass an object from field name to value, such as { published: true }. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocwhereoption"`,
    );
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", where: { nope: 1 } as never })),
    ).toMatchInlineSnapshot(
      `"schema.assocWhereFieldMissing: Owner.x: hasMany expects the where field "nope" on Post, but Post has no such field. A where condition is written with the target's field names. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocwherefieldmissing"`,
    );
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", where: { title: undefined } })),
    ).toMatchInlineSnapshot(
      `"schema.assocWhereUndefined: Owner.x: where.title is undefined. Use null to match NULL, or leave the key out. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocwhereundefined"`,
    );
    expect(message(hasMany(() => Post, { foreignKey: "authorId", where: new Date() as never }))).toMatch(
      /where must be an object/,
    );
  });

  test("orderBy", () => {
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", orderBy: "title" as never })),
    ).toMatchInlineSnapshot(
      `"schema.assocOrderBy: Owner.x: orderBy must be an array of field names or { field: "asc" | "desc" } objects. Pass field names, as in ["createdAt"], or objects of a field and a direction, as in [{ createdAt: "desc" }]. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocorderby"`,
    );
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", orderBy: [{ title: "up" }] as never })),
    ).toMatch(/orderBy must be an array/);
    expect(message(hasMany(() => Post, { foreignKey: "authorId", orderBy: [7] as never }))).toMatch(
      /orderBy must be an array/,
    );
    expect(
      message(hasMany(() => Post, { foreignKey: "authorId", orderBy: ["nope"] as never })),
    ).toMatchInlineSnapshot(
      `"schema.assocOrderByFieldMissing: Owner.x: hasMany expects the orderBy field "nope" on Post, but Post has no such field. An order is written with the target's field names. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocorderbyfieldmissing"`,
    );
  });

  test("manyToMany through a table", () => {
    expect(message(manyToMany(() => Tag, { joinThrough: "users_tags" } as never))).toMatchInlineSnapshot(
      `"schema.joinKeysRequired: Owner.x: manyToMany through the table "users_tags" needs joinKeys with that table's column names. Pass joinKeys, as in { joinThrough: "users_tags", joinKeys: { owner: "post_id", target: "tag_id" } }: owner is the column that points at Owner, target the one that points at Tag. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeysrequired"`,
    );
    expect(message(manyToMany(() => Tag, {} as never))).toMatchInlineSnapshot(
      `"schema.joinThroughRequired: Owner.x: manyToMany needs { joinThrough }: the name of the join table (with joinKeys), or a function returning its schema class. Pass { joinThrough: "posts_tags", joinKeys: { owner, target } } with the join table's name, or { joinThrough: () => PostTag } with its schema class. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-jointhroughrequired"`,
    );
    expect(
      message(manyToMany(() => Tag, { joinThrough: "", joinKeys: { owner: "a", target: "b" } })),
    ).toMatch(/joinThrough is an empty string/);
    expect(
      message(manyToMany(() => Tag, { joinThrough: "t", joinKeys: { owner: "a" } as never })),
    ).toMatchInlineSnapshot(
      `"schema.joinKeysOption: Owner.x: joinKeys must be { owner, target }, each the name of a column of the join table. Pass joinKeys: { owner: "...", target: "..." }, each naming a column of the join table. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeysoption"`,
    );
    expect(message(manyToMany(() => Tag, { joinThrough: "t", joinKeys: null as never }))).toMatch(
      /joinKeys must be/,
    );
    expect(
      message(manyToMany(() => Tag, { joinThrough: "t", joinKeys: { owner: "", target: "b" } })),
    ).toMatch(/joinKeys must be/);
    expect(
      message(manyToMany(() => Tag, { joinThrough: "t", joinKeys: { owner: "a", target: "" } })),
    ).toMatch(/joinKeys must be/);
    expect(
      message(manyToMany(() => Tag, { joinThrough: "t", joinKeys: { owner: "tag_id", target: "tag_id" } })),
    ).toMatchInlineSnapshot(
      `"schema.joinKeysSame: Owner.x: joinKeys.owner and joinKeys.target are both "tag_id". They are two different columns. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeyssame"`,
    );
    expect(
      message(
        manyToMany(() => Tag, {
          joinThrough: "t",
          joinKeys: { owner: "a", target: "b" },
          unique: "yes" as never,
        }),
      ),
    ).toMatchInlineSnapshot(
      `"schema.uniqueOption: Owner.x: unique must be true or false. Pass unique: true or unique: false, or leave it out. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-uniqueoption"`,
    );
    expect(
      message(
        manyToMany(() => Tag, {
          joinThrough: "t",
          joinKeys: { owner: "a", target: "b" },
          joinWhere: [] as never,
        }),
      ),
    ).toMatch(/joinWhere must be an object/);
  });

  test("manyToMany needs a single-field key on both sides", () => {
    expect(
      message(manyToMany(() => Membership, { joinThrough: "t", joinKeys: { owner: "a", target: "b" } })),
    ).toMatchInlineSnapshot(
      `"schema.manyToManyCompositeKey: Owner.x: manyToMany needs Membership to have a primary key of exactly one field, because a join table holds one column for each side. Membership has 2. Give the schema a single-field key, or declare the join as a schema class with belongsTo associations and use hasMany with through. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-manytomanycompositekey"`,
    );
  });

  test("manyToMany through a join schema", () => {
    class Loose extends Schema("loose", {
      userId: t.integer().primaryKey(),
      tagId: t.integer().primaryKey(),
    }) {}
    expect(message(manyToMany(() => Tag, { joinThrough: () => Loose }))).toMatchInlineSnapshot(
      `"schema.joinKeysAmbiguous: Owner.x: the join keys cannot be worked out: Loose declares 0 belongsTo association(s) to Owner and exactly one, with a single foreign key, is needed. Pass { joinKeys: { owner, target } } with the fields of Loose. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeysambiguous"`,
    );
    class Twice extends Schema("twice", {
      id: t.integer().primaryKey(),
      ownerId: t.integer(),
      otherId: t.integer(),
      tagId: t.integer(),
    }) {
      static owner = belongsTo(() => Wanted);
      static other = belongsTo(() => Wanted);
      static tag = belongsTo(() => Tag);
    }
    class Wanted extends Schema("wanted", { id: t.integer().primaryKey() }) {
      static tags = manyToMany(() => Tag, { joinThrough: () => Twice });
    }
    expect((problem(Wanted) as Error).message).toMatch(
      /Twice declares 2 belongsTo association\(s\) to Wanted/,
    );
    class Friend extends Schema("friends", { id: t.integer().primaryKey() }) {
      static friends = manyToMany(() => Friend, { joinThrough: () => Membership });
    }
    expect((problem(Friend) as Error).message).toMatchInlineSnapshot(
      `"schema.joinKeysSelf: Friend.friends: Friend is on both sides of this manyToMany, so the join keys cannot be told apart. Pass { joinKeys: { owner, target } } with the fields of Membership. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeysself"`,
    );
    expect(
      message(
        manyToMany(() => User, {
          joinThrough: () => Membership,
          joinKeys: { owner: "nope", target: "userId" } as never,
        }),
      ),
    ).toMatchInlineSnapshot(
      `"schema.joinKeyFieldMissing: Owner.x: manyToMany expects the join key field "nope" on Membership, but Membership has no such field. Pass { joinKeys } with fields of Membership. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeyfieldmissing"`,
    );
    expect(
      message(
        manyToMany(() => User, {
          joinThrough: () => Membership,
          joinKeys: { owner: "orgId", target: "userId" },
        }),
      ),
    ).toMatchInlineSnapshot(
      `"schema.joinKeyType: Owner.x: the join key Membership.orgId is of type uuid, but Owner.id, which it points at, is of type integer. Declare both with the same type. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-joinkeytype"`,
    );
    expect(
      message(
        manyToMany(() => User, {
          joinThrough: () => Membership,
          joinKeys: { owner: "userId", target: "userId" },
        }),
      ),
    ).toMatch(/both "userId"/);
    expect(
      message(
        manyToMany(() => Org, {
          joinThrough: () => Membership,
          joinKeys: { owner: "userId", target: "orgId" },
          joinWhere: { nope: 1 } as never,
        }),
      ),
    ).toMatch(/manyToMany expects the joinWhere field "nope" on Membership/);
    expect(message(manyToMany(() => Org, { joinThrough: (() => 42) as never }))).toMatch(
      /the function for the join schema returned a number/,
    );
    expect(message(manyToMany(() => Org, { joinThrough: Membership as never }))).toMatch(
      /joinThrough: \(\) => PostTag/,
    );
  });

  test("has-through", () => {
    expect(message(hasMany(() => Comment, { through: ["posts"] } as never))).toMatchInlineSnapshot(
      `"schema.throughPath: Owner.x: through must be an array of at least two association names to follow. Pass the names of the associations to follow, as in hasMany(() => Comment, { through: ["posts", "comments"] }). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-throughpath"`,
    );
    expect(message(hasMany(() => Comment, { through: "posts.comments" } as never))).toMatch(
      /through must be an array/,
    );
    expect(message(hasMany(() => Comment, { through: ["posts", ""] } as never))).toMatch(
      /through must be an array/,
    );
    expect(
      message(hasMany(() => Comment, { through: ["posts", "comments"], foreignKey: "postId" } as never)),
    ).toMatchInlineSnapshot(
      `"schema.throughCombined: Owner.x: through cannot be combined with foreignKey. Remove the other options: the associations through follows already say how the rows are found. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-throughcombined"`,
    );
    expect(message(hasMany(() => Comment, { through: ["posts", "comments"] }))).toMatchInlineSnapshot(
      `"schema.throughUnknownStep: Owner.x: through follows "posts" on Owner, but Owner has no such association. It has: none. Follow associations the schema declares, in the order the path takes them. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-throughunknownstep"`,
    );
    expect(message(hasMany(() => Comment, { through: ["x", "comments"] }))).toMatchInlineSnapshot(
      `"schema.throughUnknownStep: Owner.x: through follows "x" on Owner, but Owner has no such association. It has: none. Follow associations the schema declares, in the order the path takes them. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-throughunknownstep"`,
    );
    class Hop extends Schema("hops", { id: t.integer().primaryKey(), userId: t.integer() }) {
      static user = belongsTo(() => User);
      static wrongEnd = hasMany(() => Tag, { through: ["user", "posts"] });
      static deadEnd = hasMany(() => Tag, { through: ["user", "posts", "comments", "nowhere"] });
    }
    expect((problem(Hop) as Error).message).toMatchInlineSnapshot(
      `"schema.throughWrongTarget: Hop.wrongEnd: through ["user", "posts"] ends at Post, but the association is declared with Tag as its target. Make the last association of the path point at the declared target, or change the target to the class the path ends at. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-throughwrongtarget"`,
    );
    Hop.wrongEnd = hasMany(() => Post, { through: ["user", "posts"] }) as never;
    expect((problem(Hop) as Error).message).toMatch(/It has: post\./);
    Hop.deadEnd = hasMany(() => Comment, { through: ["user", "posts", "comments"] }) as never;
    expect(assoc(Hop, "deadEnd").target()).toBe(Comment);
    class Bare extends Schema("bare", { id: t.integer().primaryKey() }) {
      static a = hasMany(() => Tag, { through: ["b", "c"] });
    }
    class Plain extends Schema("plain", { id: t.integer().primaryKey(), bareId: t.integer() }) {
      static bare = belongsTo(() => Bare);
      static lost = hasMany(() => Tag, { through: ["bare", "nothing"] });
    }
    expect((problem(Bare) as Error).message).toMatch(/It has: none\./);
    // A path is followed through declarations, so Bare's own mistake does not stop it.
    expect((problem(Plain) as Error).message).toMatch(
      /^schema\.throughUnknownStep: Plain\.lost: .*Bare has no such association\. It has: a\./,
    );
  });

  test("a name that is a field, or reserved", () => {
    class Clash extends Schema("clashes", { id: t.integer().primaryKey(), author: t.integer() }) {
      static author = belongsTo(() => User);
    }
    expect((problem(Clash) as Error).message).toMatchInlineSnapshot(
      `"schema.assocFieldClash: Clash.author: Clash has a field and an association that are both named "author". A preloaded association is a property of the row, so rename one of them (the foreign-key field is usually "authorId"). See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocfieldclash"`,
    );
    class Reserved extends Schema("reserved", { id: t.integer().primaryKey(), toJSONId: t.integer() }) {
      static toJSON = belongsTo(() => User);
    }
    expect((problem(Reserved) as Error).message).toMatchInlineSnapshot(
      `"schema.assocReservedName: Reserved.toJSON: "toJSON" cannot be the name of an association: "constructor", "__proto__", "toJSON", "fields" and names that start with "$" are reserved. Rename the static member. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocreservedname"`,
    );
    class Dollar extends Schema("dollars", { id: t.integer().primaryKey(), fromId: t.integer() }) {
      static $from = belongsTo(() => User, { foreignKey: "fromId" });
    }
    expect((problem(Dollar) as Error).message).toMatch(/"\$from" cannot be the name/);
    class Fields extends Schema("fields_owners", { id: t.integer().primaryKey(), fieldsId: t.integer() }) {}
    Object.defineProperty(Fields, "fields", { value: belongsTo(() => User) });
    expect((problem(Fields) as Error).message).toMatch(/"fields" cannot be the name/);
  });

  test("an embedded schema has no associations", () => {
    class Address extends EmbeddedSchema({ city: t.string(), ownerId: t.integer() }) {
      static owner = belongsTo(() => User);
    }
    expect((problem(Address) as Error).message).toMatchInlineSnapshot(
      `"schema.assocOnEmbedded: Address.owner: Address is an embedded schema: it is stored inside its parent's row and has no table to associate. Move the association to the parent schema. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assoconembedded"`,
    );
    expect(meta(EmbeddedSchema({ city: t.string() })).assocs().size).toBe(0);
  });

  test("a name that the class also defines as a getter or method", () => {
    class Shadow extends Schema("shadows", { id: t.integer().primaryKey(), authorId: t.integer() }) {
      static author = belongsTo(() => User);
    }
    Object.defineProperty(Shadow.prototype, "author", { get: () => "a getter" });
    expect((problem(Shadow) as Error).message).toMatchInlineSnapshot(
      `"schema.assocShadowedByMember: Shadow.author: Shadow defines "author" as a getter, method or property of the class, and "author" is also an association. A preloaded association is a property of the row, so the class member would hide it or make it impossible to set. Rename one of them. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-assocshadowedbymember"`,
    );
  });

  test("every error is a SchemaDefinitionError", () => {
    expect(problem(owner(belongsTo(() => User)))).toBeInstanceOf(SchemaDefinitionError);
  });
});
