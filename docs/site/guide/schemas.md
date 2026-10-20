# Schemas

A schema is a class that describes one table. Its instances are the rows you get back
from the database.

<<< @/examples/schemas.ts#user

The examples on this page import these:

<<< @/examples/schemas.ts#imports

`Schema(table, fields, options?)` returns a base class to extend. The class name is the
row type: a function that takes a `User` takes a row of the `users` table.

## Fields

Every field starts with a type from `t` and may chain modifiers. See [Types](/guide/types)
for the full list of types and what each accepts.

| Modifier | Effect |
|---|---|
| `.nullable()` | The column may be `NULL`; the TypeScript type gains `\| null`. A new record starts with `null`. |
| `.default(value \| () => value)` | Used for a new record when no value is given. A function is called once per record. |
| `.primaryKey()` | Part of the primary key. See [Primary keys](#primary-keys). |
| `.autogenerate(fn?)` | A value generated in your process on insert when none is given (UUIDs, timestamps). |
| `.dbGenerated()` | The database produces the value; it is read back after insert and update. A serial key is `.primaryKey().dbGenerated()`. |
| `.virtual()` | Exists on the row and in changesets, but is never stored or selected. |
| `.column("name")` | The column name, when it is not the snake_case form of the field name. |
| `.redact()` | Hidden from `toJSON`, `console.log`, logs and error messages. |
| `.writable("always" \| "insert" \| "never")` | Restricts when the field may be written. The default is `"always"`. |

Every modifier returns a new field, so a field can be declared once and shared by several
schemas.

**Fields are non-null by default.** A field without `.nullable()` is `string`, not
`string | null`, and the library enforces it: see
[Required fields](/guide/changesets#required-fields).

Use a function for a default that is an object or an array, such as
`t.json<string[]>().default(() => [])`. A value is shared by every new record, and
changing it in one record would change it in all of them.

`.autogenerate()` without a function works for two types: `t.uuid()` gets a UUID
version 7 (time-ordered, so new keys go to the end of the index) and the timestamp types
get the current time. For anything else, pass the function:
`t.uuid().autogenerate(() => crypto.randomUUID())` for a random version 4 UUID.

## Primary keys

<<< @/examples/schemas.ts#primary-keys

- `.primaryKey()` marks the key and nothing else: the value is one you supply, whatever
  its type. Add `.dbGenerated()` when the database generates it (a `serial`, `bigserial`
  or identity column), or `.autogenerate()` when your process does (a UUID).
- The same holds for every part of a composite key, so a join table's two foreign keys
  are plain `.primaryKey()`.
- Several fields with `.primaryKey()` form a composite key, in declaration order:

<<< @/examples/schemas.ts#composite-key

- A table with no key is declared with `{ primaryKey: false }`. Such rows cannot be
  updated or deleted individually.

<<< @/examples/schemas.ts#keyless

There is no special "id" type. A foreign key is an ordinary field of the same type as the
key it points at:

<<< @/examples/schemas.ts#foreign-key

## Timestamps

`...timestamps()` adds `createdAt` and `updatedAt`, both set on insert; `updatedAt` is set
again on every update that changes something.

<<< @/examples/schemas.ts#timestamps

Both are `t.timestamp()` (`timestamptz`) unless you pass another type that holds a
`Date`, such as `t.localTimestamp()`. The time is taken in your process, at the type's
precision.

## Schema options

<<< @/examples/schemas.ts#schema-options

| Option | Effect |
|---|---|
| `schema` | The database schema (a Postgres schema, a MySQL database) the table is in. |
| `naming` | `"snake_case"` (the default), `"camelCase"` to use the field names as they are, or a function from field name to column name. |
| `primaryKey: false` | The table has no primary key. |
| `codegen: false` | Build rows without generating code. This happens by itself where generating code is forbidden (a Content Security Policy without `unsafe-eval`); rows are the same either way, only slower to build. |

## Column names

Field names are camelCase in TypeScript and snake_case in the database. An upper-case
run counts as one word. `.column()` overrides one field, `naming` the whole schema.

<<< @/examples/schemas.ts#column-names

Two fields that end up in the same column are refused when the class is defined.

## Getters and methods

A schema class may define getters and methods, as `displayName` does above. It may **not**
define a constructor or field initialisers: rows are built without running a constructor,
so neither would run.

### There is no constructor

You never write `new User()`. A `User` object comes only from the database: from a query,
or from a successful insert or update. A record that does not exist yet is described by a
[changeset](/guide/changesets):

<<< @/examples/changesets.ts#new-record

Calling the constructor throws `SchemaDefinitionError`, which says so.

This is why a row's type can be trusted: a `User` whose `email` is `undefined` cannot
exist.

## Derived types

<<< @/examples/schemas.ts#derived-types

`InsertShape` makes a field optional when it is nullable, has a default, is autogenerated
or is database-generated. Virtual fields are left out.

A row with preloaded associations has the type `Loaded<typeof User, "posts">`; see
[Associations](/guide/associations#the-loaded-type).

## Associations

Associations are `static` members of the class. The foreign key is always a field you
declare; the association refers to it by field name.

<<< @/examples/schemas.ts#associations

Where the keys are, for each kind:

```
belongsTo   books.author_id ──────────▶ authors.id        the key is on this table
hasOne      authors.id      ◀────────── profiles.author_id the key is on the other table
hasMany     authors.id      ◀────────── books.author_id    (any number of rows)
manyToMany  posts.id ◀── posts_tags.post_id                a join table holds
                         posts_tags.tag_id ──▶ tags.id     both keys
```

`hasOne` and `hasMany` need `foreignKey`; `belongsTo` defaults it to the property name
plus `Id`. Associations are checked the first time they are used, not when the class is
defined, because the class they point at may not exist yet. See
[Associations and preloading](/guide/associations).

## Embedded schemas

An embedded schema has fields but no table. It is stored in a JSON column of its parent,
with the field names as JSON keys (they are not converted to snake_case):

<<< @/examples/schemas.ts#embedded

Embedded rows are instances of their class. See [Embeds](/guide/embeds).

## Serialisation

- `JSON.stringify(user)` gives a plain object of the fields. Redacted fields are omitted.
- `console.log(user)` shows redacted fields as `**redacted**`.
- Preloaded associations and embeds are included in both, with their own redacted fields
  hidden at every level.
- `toJSON` lives on the class's prototype. A schema class may define its own.

## Reflection

<<< @/examples/schemas.ts#reflection

| Function | Returns |
|---|---|
| `meta(User)` | The schema's metadata: `source`, `fields`, `primaryKey`, `assocs()`. |
| `fieldNames(User)` | The field names, in declaration order. |
| `isSchema(x)` / `isRow(x)` | Type guards. |
| `primaryKeyOf(row, User?)` | The key value, or an object for a composite key. Typed when the class is passed. |
| `stateOf(row)` | `"loaded"` or `"deleted"`. |
| `User.fields` | The field declarations the class was defined with. |

## Reserved names

A field cannot be named `constructor`, `__proto__` or `toJSON`, or start with `$`. An
association cannot have those names either, nor `fields`. A mistake in a schema throws
`SchemaDefinitionError` when the class is defined, with a message that names the schema,
the field and the fix.

::: tip Good to know
- **No constructor.** Rows come from the database; new records are changesets. A schema
  class holds getters and methods only.
- **Non-null by default.** Add `.nullable()` where the column allows `NULL`.
- **camelCase fields, snake_case columns.** `createdAt` is stored in `created_at`.
- **You declare the foreign key.** `belongsTo(() => User)` does not add `userId`; the
  field must exist, and is checked the first time the association is used.
:::

## Why classes and static associations

Two schemas that refer to each other (a user has posts, a post has an author) must both
be typed without either being written first. A schema as a constant
(`const User = schema({ posts: hasMany(() => Post) })`) makes TypeScript give up on such a
cycle and type it as `any`. A class whose fields are in its base and whose associations
are `static` members does not: the base mentions only fields, and TypeScript works out
static members lazily. The class also gives the row type a name, `User`, and a place for
getters and methods. The decision and the experiment behind it are recorded in
[ADR 0001](https://github.com/caseyt/egon-orm/blob/main/docs/adr/0001-schema-classes.md).

## See also

- [Types](/guide/types)
- [Associations and preloading](/guide/associations)
- [Embeds](/guide/embeds) for nested objects stored in one JSON column.
- [Changesets](/guide/changesets): creating and changing records.
- [Migrations](/guide/migrations): creating the tables.
