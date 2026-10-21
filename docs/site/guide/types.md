# Types

A type answers three questions about a field: how to accept untrusted input, how to read
the value the database returns, and how to write a value to the database.

All types come from `t`, the same object used to declare fields. Wherever the library
needs a type on its own, such as `param("minAge", t.integer())`, you pass a field builder.

## Built-in types

| Type | In TypeScript | Postgres column | Accepts from untrusted input |
|---|---|---|---|
| `t.string()` | `string` | `text`, `varchar` | Strings only. Numbers are not coerced. |
| `t.integer()` | `number` | `integer` | Safe integers, digit strings such as `"42"`, and `bigint`s in the safe range. Rejects `1.5`, `"1.0"`, `NaN`. |
| `t.bigint()` | `bigint` | `bigint` | A `bigint`, a safe-integer `number`, or a digit string, within the 64-bit range. |
| `t.bigint({ mode: "number" })` | `number` | `bigint` | As `integer`. A stored value beyond the safe integer range throws `CastError`. |
| `t.float()` | `number` | `double precision` | Finite numbers and numeric strings such as `"1.5"` or `"1e3"`. |
| `t.decimal()` | `string` | `numeric` | Decimal strings such as `"19.99"` (no exponent) and finite numbers. |
| `t.boolean()` | `boolean` | `boolean` | `true`, `false`, `"true"`, `"false"`, `1`, `0`, `"1"`, `"0"`. |
| `t.uuid()` | `string` | `uuid` | The canonical 36-character form, any case; stored lower-case. |
| `t.binary()` | `Uint8Array` | `bytea` | `Uint8Array` or `Buffer`. |
| `t.date()` | `string` (`"YYYY-MM-DD"`) | `date` | A date string, a `Date` (its UTC date), or `{ year, month, day }`. Rejects impossible dates. |
| `t.time()` | `string` | `time` | `"HH:MM"`, `"HH:MM:SS"`, with an optional fraction of up to six digits. |
| `t.timestamp()` | `Date` | `timestamptz` | A valid `Date`, or an ISO-8601 string **with** an offset or `Z`. |
| `t.localTimestamp()` | `Date` | `timestamp` | A `Date`, or an ISO-8601 string **without** an offset, read as UTC. |
| `t.json<T>()` | `T` | `jsonb` | Anything JSON can represent exactly. The shape is not checked; use a validator. |
| `t.array(inner)` | `T[]` | `inner[]` | An array; each element is cast with `inner`. |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `text` | One of the listed values. |
| `t.enum({ a: 1, b: 2 })` | `"a" \| "b"` | `integer` | A key, or its stored value. |
| `t.type(custom)` | yours | yours | Whatever your type accepts. See [Custom types](#custom-types). |

Anything else is rejected, and the changeset reports the field as `is invalid`.

Options:

- `t.decimal({ precision, scale })`. The value is rounded to `scale` digits after the
  point, half away from zero as the database rounds, and a number with more than
  `precision - scale` digits before the point is rejected. `scale` defaults to 0.
- `t.date({ as: "date" })` gives a `Date` at midnight UTC instead of a string.
- `t.timestamp({ precision })` and `t.localTimestamp({ precision })`, with `"s"`, `"ms"`
  or `"us"`. The default is `"ms"`, which is what a JavaScript `Date` holds. `"s"` drops
  the milliseconds of accepted input. `"us"` is for a microsecond column; the value is
  still a `Date`, so it carries milliseconds.

Some details of what is accepted:

- **Normal form.** A type returns one spelling of each value, the one the database gives
  back: a uuid in lower case, `"09:30"` as `"09:30:00"`, `".5"` as `"0.5"`.
- **Mapped enums.** In `t.enum({ low: 1, high: 2 })` the values are all whole numbers
  (an `integer` column) or all strings (a `text` column). Your code sees the keys. A key
  may not be the stored value of another key, because input may be either.
- **Arrays.** A `null` element is rejected. When an element fails, the error says which
  one (`meta.index`) and keeps the element's own message. `meta.path` holds the indexes
  that lead to the value: `[1]`, or `[1, 2]` in an array of arrays.
- **JSON.** Values that JSON would change or drop are rejected instead of being stored
  differently from what you passed: `undefined` inside a document, `NaN`, a `Date`, a
  `Map`, a class instance, a `bigint`, and a value that contains itself.

::: tip Good to know
**A number field needs a number column.** A `t.integer()` or `t.float()` field reads the
driver's value as it is, and throws `CastError`, naming the field, when that value is not a
number. Today that happens on Postgres for `bigint`, `bigserial` and `numeric` columns,
which `pg` returns as text, and on MySQL for `decimal` columns and for `div` of an
operand whose type the query does not know, such as
`coalesce(p.views, val(0, t.integer())).div(2)` (see
[Expressions](/guide/query-expressions#explicit-values-and-types)). Declare a 64-bit integer as
`t.bigint({ mode: "number" })` (or `t.bigint()`), and a decimal as `t.decimal()`.

Input is accepted leniently, because it usually arrives as JSON or form data: `"42"` is a
valid integer and `"true"` a valid boolean. The reverse is not true. A number is never
turned into a string, and a timestamp string without an offset is rejected instead of
being read in the server's time zone.
:::

## Why dates and decimals are strings

- A `date` has no time zone. Turning `2026-10-13` into a `Date` gives a moment in time,
  which shifts to the 12th or 14th in some time zones. A string cannot shift.
- A `decimal` exists to avoid floating-point error. Reading `19.99` into a `number` would
  reintroduce it. Use a [custom type](#custom-types) to get a decimal object instead.

## Null

`null` never reaches a type. Whether a field may be `null` is decided by `.nullable()` on
the field, and handled before the type is involved.

## Equality

Each type knows how to compare two values, which is how a changeset decides whether a
value changed. Dates compare by timestamp, binaries by bytes, arrays element by element,
and JSON values structurally, whatever the order of their keys. Decimals compare as
numbers: `"1.50"` equals `"1.5"`, so sending back the value the database returned is not
a change.

## Custom types

<<< @/examples/types.ts#imports

<<< @/examples/types.ts#custom-type

<<< @/examples/types.ts#custom-type-field

| Member | Purpose |
|---|---|
| `name` | Shown in error messages. |
| `db` | The logical column type: `{ kind: "decimal" }`, `{ kind: "array", of }`, `{ kind: "custom", sql }` and so on. |
| `cast(input)` | Untrusted input to your value. Return `{ success: true, data }` or `{ success: false, message?, meta? }`. It must never throw. |
| `fromDb(stored)` | The driver's value to your value. Optional when they are the same. |
| `toDb(value)` | Your value to a query parameter. Optional when they are the same. |
| `equal(a, b)` | Optional; defaults to `Object.is`. |

Leave `fromDb` and `toDb` out when no conversion is needed. The library then skips the
call entirely when reading rows.

<<< @/examples/types.ts#identity-type

Three rules for the functions you pass:

- `cast` receives anything at all and must not throw. Return `{ success: false }` for
  what you do not accept. The `message` may contain `{key}` placeholders that are filled
  from `meta`; without a message the changeset says `is invalid`.
- `null` never reaches them, so they do not need to handle it.
- They are called on their own, not as methods, so they cannot use `this`.

`defineType` checks the definition when it runs and throws `SchemaDefinitionError` for a
missing name, a `cast` that is not a function, or a column type it cannot use. It keeps
its own copy of `db`.

### A column type the library does not know

`{ kind: "custom", sql }` names a SQL type directly. The name is written into the SQL
text, so it must be a constant in your code and a plain type name, such as `citext`,
`numeric(10, 2)` or `public.mood[]`. Anything else is refused. Never build it from user
input.

<<< @/examples/types.ts#custom-sql

## Types that take options

`parameterized` builds a type from options and remembers the result per option set. The
built-in `enum`, `array` and `decimal` are made this way.

<<< @/examples/types.ts#parameterized

<<< @/examples/types.ts#parameterized-field

Options are compared by content: `{ code: "EUR", digits: 2 }` and
`{ digits: 2, code: "EUR" }` give the same type. A type, a function or a class instance
inside the options is compared by identity. Options are plain data: options that contain
themselves are refused.

## Differences between databases

SQLite and MySQL store some of these differently (booleans as `0`/`1`, JSON as text, no
array columns). The adapter converts for you; the TypeScript type is the same everywhere.
See [Dialect support](/reference/dialect-support).

## See also

- [Schemas](/guide/schemas#fields): field modifiers such as `.nullable()` and `.default()`.
- [Money](/recipes/money) and [Enums](/recipes/enums) recipes.
- [Dialect support](/reference/dialect-support)
