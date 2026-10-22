// The checked sources of the code blocks in guide/schemas.md. Each `#region` is included
// in the page by name; everything outside a region is the scaffolding that makes the
// regions compile.
// #region imports
import {
  belongsTo,
  EmbeddedSchema,
  fieldNames,
  hasMany,
  type InsertShape,
  isRow,
  isSchema,
  type Json,
  meta,
  primaryKeyOf,
  type Row,
  Schema,
  stateOf,
  t,
  timestamps,
} from "egon-orm";
// #endregion imports

// #region user
export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  loginCount: t.integer().default(0),
  password: t.string().virtual(),
  passwordHash: t.string().redact().column("pw_hash"),
  settings: t.json<{ theme: string }>().nullable(),
  ...timestamps(),
}) {
  get displayName() {
    return this.name ?? this.email;
  }
}
// #endregion user

export const keys = {
  // #region primary-keys
  serial: t.integer().primaryKey().dbGenerated(), //                 32-bit serial / identity column
  big: t.bigint({ mode: "number" }).primaryKey().dbGenerated(), //   64-bit bigserial, as a JS number
  uuid: t.uuid().primaryKey().autogenerate(), //                     UUID v7 generated in your process
  natural: t.string().primaryKey(), //                               natural key; you supply the value
  // #endregion primary-keys
};

// #region composite-key
export class Membership extends Schema("memberships", {
  orgId: t.uuid().primaryKey(),
  userId: t.integer().primaryKey(),
  role: t.string(),
}) {}
// #endregion composite-key

// #region keyless
export class Event extends Schema("events", { name: t.string(), at: t.timestamp() }, { primaryKey: false }) {}
// #endregion keyless

// #region foreign-key
export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {}
// #endregion foreign-key

export const variants = [
  // #region timestamps
  timestamps(), //                                       createdAt, updatedAt
  timestamps({ createdAt: "insertedAt" }), //            rename one
  timestamps({ updatedAt: false }), //                   leave one out
  timestamps({ type: t.timestamp({ precision: "s" }) }), // another type or precision
  // #endregion timestamps
];

const fields = { id: t.integer().primaryKey().dbGenerated(), totalCents: t.integer() };
// #region schema-options
class Invoice extends Schema("invoices", fields, {
  schema: "billing", //        database schema (Postgres schema, MySQL database)
  naming: "snake_case", //     how field names become column names; the default
}) {}
// #endregion schema-options

// #region column-names
class Customer extends Schema("customers", {
  id: t.integer().primaryKey().dbGenerated(),
  firstName: t.string(), //                       column first_name
  vatID: t.string(), //                           column vat_id
  legacyCode: t.string().column("LEGACY_CODE"), // column LEGACY_CODE
}) {}
// #endregion column-names

// #region derived-types
type UserRow = Row<typeof User>; //            the same as the instance type, User
type NewUser = InsertShape<typeof User>; //    what an insert needs
// { email: string; id?: number; name?: string | null; role?: "admin" | "member"; ... }
// #endregion derived-types

// #region json
type UserJson = Json<User>; // what JSON.stringify(user) writes, and what a client receives
// { id: number; email: string; name: string | null; role: "admin" | "member"; loginCount: number;
//   settings: { theme: string } | null; createdAt: string; updatedAt: string }
// No password (virtual), no passwordHash (redacted), no displayName (a getter).

class Member extends Schema("members", {
  id: t.integer().primaryKey().dbGenerated(),
  joinedAt: t.date({ as: "date" }), //            "2026-10-22" in JSON
  points: t.bigint(), //                         "9007199254740993" in JSON
  avatar: t.binary().nullable(), //              base64 in JSON
  badge: t.string().virtual({ json: true }), //  set in code, and sent when it is set
}) {}
type MemberJson = Json<Member>;
// { id: number; joinedAt: string; points: string; avatar: string | null; badge?: string }
// #endregion json

// #region associations
class Author extends Schema("authors", { id: t.integer().primaryKey().dbGenerated(), name: t.string() }) {
  static books = hasMany(() => Book, { foreignKey: "authorId" });
}

class Book extends Schema("books", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(), // the foreign key is a field you declare
  title: t.string(),
}) {
  static author = belongsTo(() => Author); // foreignKey defaults to "authorId"
}
// #endregion associations

// #region embedded
class Address extends EmbeddedSchema({
  street: t.string(),
  city: t.string(),
  postCode: t.string().nullable(),
}) {}

class Shop extends Schema("shops", {
  id: t.integer().primaryKey().dbGenerated(),
  address: t.embedOne(() => Address),
}) {}
// #endregion embedded

export function reflect(user: User): void {
  // #region reflection
  meta(User).source; //                          "users"
  meta(User).primaryKey.map((f) => f.name); //   ["id"]
  meta(User).assocs(); //                        the associations, by name
  fieldNames(User); //                           ["id", "email", "name", ...]
  isSchema(User); //                             true
  isRow(user); //                                true
  primaryKeyOf(user, User); //                   1, typed number
  stateOf(user); //                              "loaded"
  // #endregion reflection
}

export type { Customer, Invoice, MemberJson, NewUser, Shop, UserJson, UserRow };
