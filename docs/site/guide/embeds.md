# Embeds

An embed is a structured object, or a list of them, stored inside one JSON column of its
parent. It has fields, types and validations like a schema, but no table.

<<< @/examples/embeds.ts#define

- `t.embedOne(() => E)` is one object; `t.embedMany(() => E)` is an array (a new record
  starts with an empty one).
- Both are stored as `jsonb` on Postgres, and as JSON text or native JSON elsewhere.
- Loaded embeds are instances of their class, so getters and methods work. They are built
  by the class's row factory: no constructor runs.
- Embeds can contain embeds.

## Changing embeds

<<< @/examples/embeds.ts#change

`castEmbed` and `putEmbed` work like
[`castAssoc` and `putAssoc`](/guide/nested-changesets): child changesets, nested errors,
and `with` defaulting to the embed's static `changeset`. `cast`, `change` and `putChange`
refuse an embed field and point to them.

- **Matching in a list** needs a primary key on the embed, as `Phone` has. Items are then
  matched by id and updated in place, and a key with `.autogenerate()` is filled in for
  new items when they are saved (or applied). Without a key, `castEmbed` replaces the
  whole list, and a list equal to the stored one is no change.
- **`onReplace`** is passed to the field: `t.embedOne(() => Address, { onReplace: "update" })`.
  The values are `"error"` (the default), `"invalid"`, `"update"` (one only) and `"delete"`
  (the item is dropped from the column).
- **Any change inside an embed rewrites the whole column.** The parent field counts as
  changed, and `cs.changes.address` holds the child changeset. `getField`,
  `applyChanges` and `applyAction` give embedded rows instead.
- A new item that would lack a value for a field that is neither nullable nor defaulted is
  reported as `can't be blank` on that item when the parent is saved.

<<< @/examples/embeds.ts#phones

## Stored form

Each embedded field is written with its own type, then as JSON: a `timestamp` is stored as
an ISO string and read back as a `Date`, a `bigint` as a string of digits, bytes as
base64. A plain object written directly (by `insertAll`, say) is first made an embedded
row: its missing fields take their defaults and generated values, its values are cast, and
a key that is not a field is refused (`CastError`).

When reading, keys that are not fields are ignored and missing keys get the field's
default (or `null` for a nullable field); a stored `null` in a field that is not nullable
counts as missing. A missing key of a field that has neither, or a stored value of the
wrong JSON kind (a string where a number is expected), is an error (`CastError`): the
database does not check what is inside a JSON column. Give a field a default when you add
it to an embed that already has stored rows.

A `.redact()` field inside an embed hides the whole embed column's value in logs.

The JSON keys are the field names as written: `postCode` is stored as `"postCode"`, not
`"post_code"`. `.column("pc")` renames one key, and `EmbeddedSchema(fields, { naming: "snake_case" })`
switches the whole embed to snake_case keys.

## Querying inside an embed

<<< @/examples/embeds.ts#query

`field(name)` is typed from the embed (`Expr<string>` here; nullable when the embed or the
field is). It reads the field's JSON key as text, cast to the field's type where that is
not text (a number, a boolean, a date or timestamp from its ISO string), and chains into a
nested embed: `u.card.field("point").field("lat")`. It works on `t.embedOne` fields. Bytes
(stored as base64) and lists (stored as JSON arrays) are refused, as are lists of embeds and
other JSON: use the general JSON operators `path` and `pathText` for those; see
[Expressions](/guide/query-expressions#json).

## When to use an embed

Use an embed for data that belongs to exactly one parent and is always read with it: an
address, preferences, a list of phone numbers. Use an
[association](/guide/associations) when the data is shared, queried by itself, or large.
