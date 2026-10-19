# Expressions

Expressions are what you write inside `where`, `select`, `orderBy` and the other clause
callbacks. Operators are methods on columns and on other expressions; the functions
(`and`, `count`, `coalesce`, `fragment`, …) are imported from `egon-orm`.

<<< @/examples/query-expressions.ts#overview

An expression is a value: `u.age.gte(18)` returns a new `Expr<boolean>` and changes
nothing. You can keep one in a variable, pass it to a function, and use it in as many
queries as you like.

## Values are always bound

A JavaScript value passed to an operator becomes a bound parameter (`$1`). It is never
written into the SQL text, so a value cannot inject SQL, and two queries that differ only
in their values share one cached plan.

The value takes the type of the other side, and is written to the driver with it:

<<< @/examples/query-expressions.ts#bound

A value compared with a [redacted](/guide/schemas#fields) field (`.redact()`) is redacted
too: it is hidden in logs and telemetry, like the field. That holds in either order
(`val(x).eq(u.passwordHash)`), for an explicit `val(x)` and a named parameter, for a value
inside a wrapper that keeps it (`cast`, `lower()`, `upper()`, `coalesce`, arithmetic,
`concat`, the results and `else` of a `caseWhen`, but not its conditions), and for a
`caseWhen` with a redacted branch. The arguments of a `fragment` are deliberately left
as they are, since what the SQL does with them is unknown: wrap a secret in `val(x)` and
compare it with the field directly.

## Operators

| Group | Methods | SQL |
|---|---|---|
| Comparison | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | `=`, `<>`, `>`, `>=`, `<`, `<=` |
| | `between(a, b)` | `BETWEEN a AND b` (both ends included) |
| | `in(list)`, `notIn(list)` | `= ANY($1)`, or `IN (...)` |
| | `isNull()`, `isNotNull()` | `IS NULL`, `IS NOT NULL` |
| | `isDistinctFrom(x)` | `IS DISTINCT FROM` |
| Boolean | `and(x)`, `or(x)`, `not()` | `AND`, `OR`, `NOT` |
| Text | `like`, `notLike`, `ilike` | `LIKE`, `NOT LIKE`, `ILIKE` |
| | `concat(...)`, `lower()`, `upper()` | `\|\|`, `lower()`, `upper()` |
| Number | `add`, `sub`, `mul`, `div`, `mod`, `neg` | `+`, `-`, `*`, `/`, `%`, unary `-` |
| Array | `contains`, `containedBy`, `overlaps` | `@>`, `<@`, `&&` |
| | `has(element)` | `element = ANY(col)` |
| | `append(element)`, `remove(element)` | `array_append`, `array_remove` |
| JSON | `path(...keys)`, `pathText(...keys)` | `#>`, `#>>` |
| Typing | `cast(t.string())` | `CAST(x AS text)` |
| | `as<T>()` | none; changes the TypeScript type only |
| Ordering | `asc()`, `desc()`, then `nullsFirst()` or `nullsLast()` | `ASC`, `DESC`, `NULLS FIRST`, `NULLS LAST` |

Each method exists only on expressions of a fitting type: `ilike` on a number column is a
compile error, and so is `u.age.gt("18")`. Chained `and` calls make one flat
`a AND b AND c`; the parentheses that mixed `and` and `or` need are added for you.

## Functions

| Function | Notes |
|---|---|
| `and(...xs)`, `or(...xs)`, `not(x)` | With no arguments, `and()` is true and `or()` is false. |
| `count()`, `count(x)`, `countDistinct(x)` | `number` |
| `sum(x)`, `avg(x)`, `min(x)`, `max(x)` | `T \| null`: an aggregate over no rows is `NULL`. |
| `arrayAgg(x)`, `jsonAgg(x)`, `stringAgg(x, sep)` | `T[] \| null`, `unknown[] \| null`, `string \| null` |
| `coalesce(a, b, ...)` | Not nullable when the last argument is not. |
| `now()` | The database's current time. |
| `caseWhen(cond, value).when(...).else(value)` | `CASE WHEN`. |
| `exists(query)` | See [Advanced queries](/guide/queries-advanced#subqueries). |
| `val(value, type?)` | An explicit bound parameter, for where the type cannot be inferred. In a `select`, a value other than a string or `null` needs the type. |
| `lit(true \| false \| null \| number)` | A literal written into the SQL. Restricted to these safe kinds. |
| `param(name, type)` | A [named parameter](#named-parameters). |
| `fragment` | Raw SQL. See [Fragments](#fragments). |

<<< @/examples/query-expressions.ts#logic

## Null

Comparing with `null` is rejected: `u.name.eq(null)` is a compile error and throws
`QueryError`. In SQL, `name = NULL` is never true, so the query would silently match
nothing. Use `isNull()` or `isNotNull()`. The same goes for `null` inside an `in` list,
for `between`, for a `like` pattern, and for an expression that is always `null`:
`u.name.eq(lit(null))` and `u.name.eq(val(null))` do not compile either.

<<< @/examples/query-expressions.ts#null

`isDistinctFrom` is the exception among the operators: it treats `null` as a value, so it
takes one. The [object form](/guide/queries#object-form) of `where` is the other: there,
`{ name: null }` means `IS NULL`.

Arithmetic and text functions on a nullable column give a nullable result, as in SQL.

## Lists

<<< @/examples/query-expressions.ts#lists

On Postgres a list is one array parameter, so `in([1, 2])` and `in([1, 2, 3])` share a
plan. The list is copied when the expression is built: changing your array afterwards
does not change the query.

## Arrays

<<< @/examples/query-expressions.ts#arrays

The elements are typed from the column: `p.tags.has(1)` on a `string[]` column is a
compile error.

## JSON

<<< @/examples/query-expressions.ts#json

Each key of a path is a bound parameter; a number is an array position. `path` gives JSON
of unknown shape, so give it a type with `cast` (converted by the database) or `as`
(asserted only). `path` exists on JSON columns and embeds, not on text or numbers.

For a typed alternative on embedded schemas, see
[Embeds](/guide/embeds#querying-inside-an-embed).

## Aggregates

<<< @/examples/query-expressions.ts#aggregates

- `count` is always a `number`.
- `sum` over integers is a `number`. A sum that can pass `Number.MAX_SAFE_INTEGER` should
  be cast: `sum(p.views).cast(t.bigint())`. Over `t.bigint()` it is a `bigint`, over
  `t.decimal()` a decimal string.
- `avg` over numbers is a `number` (the SQL casts the average to a float); over
  `t.decimal()` it stays a decimal string.
- `filter(condition)` aggregates only the rows that match: `FILTER (WHERE ...)`. A second
  `filter` is combined with the first by `AND`.
- `.over(...)` turns an aggregate into a [window function](/guide/queries-advanced#window-functions):
  `.over()` for the whole result, `.over("w")` for a named window (the name is checked
  like an identifier, `/^[A-Za-z_][A-Za-z0-9_$]*$/`), or `.over({ partitionBy, orderBy, frame })`.

## Conditional values

<<< @/examples/query-expressions.ts#case

Without `else`, a `CASE` whose branches all fail is `NULL`, and its type says so.

## Fragments

`fragment` is the only way to write raw SQL. It is a tagged template: the literal parts
become SQL text and every interpolation becomes an expression or a bound parameter.

<<< @/examples/query-expressions.ts#fragments

- Calling `fragment` as an ordinary function throws. A string can never become SQL text.
- A fragment's type is `unknown` until you give it one with `.as<T>()` or `.cast(type)`.
- A dynamic identifier goes through `fragment.ident(name)`, which checks it against
  `/^[A-Za-z_][A-Za-z0-9_$]*$/` and quotes it.
- An interpolated query becomes a subquery.
- A value is bound: a string, number, bigint, boolean, `Date`, bytes or `null`, or an
  array of those (one array parameter). An order item (`u.name.asc()`), a plain object,
  and an array that holds expressions are refused: interpolate each expression on its
  own, and bind a JSON value with `val(value, t.json())`.

## Explicit values and types

Most values get their type from the other side of the operator. Where there is no other
side (a value in a `select`, a fragment argument, the first argument of `coalesce`), say
it yourself:

<<< @/examples/query-expressions.ts#explicit

In a `select`, a value with no type is read back as text, so only a string or `null` may
go without one: `val(5)`, `val(true)` and `caseWhen(c, 1)` in a `select` do not compile
(and throw `QueryError` if the types are bypassed). Give the value a type,
`val(5, t.integer())`, or give the `CASE` a typed first branch.

A type is always a field type, `t.integer()`, the same one you use in a schema. `cast`
keeps the operand's `null`: `u.age.cast(t.string())` is `string | null` because `age` is
nullable.

## Named parameters

`param(name, type)` leaves a placeholder that is filled in when the query runs. Its name
and type are part of the expression's type, so the query knows which parameters it needs:

<<< @/examples/query-expressions.ts#named-params

The parameters are a requirement, so they cannot be typed away: a helper that returns
`u.age.gte(param("minAge", t.integer()))` must say so in its return type,
`Expr<boolean, { minAge: number }>`; `Expr<boolean>` (no parameters) does not compile.

`SomeParams` is for accepting an expression whatever parameters it needs, as the type of a
function's parameter. Never use it as a return or variable type: the parameters would be
unknown, everything built from that expression would carry unknown parameters too, and a
query made from it cannot be run.

<<< @/examples/query-expressions.ts#named-params-helper

One name has one type. Using `"n"` as an integer in one place and a string in another does
not compile where the two expressions meet, and throws `QueryError` when they are combined
where the types cannot see it (in `and(...)` of many conditions, for example).

See [Queries](/guide/queries#named-parameters) for passing the values.

## Result types

- Comparisons and predicates are `boolean`.
- Arithmetic keeps the operand's type, and is nullable when an operand is.
- `count` is a `number`; `sum`, `avg`, `min` and `max` are nullable.
- `coalesce` is nullable only when its last argument is.
- A selected expression is read back with its type: `u.createdAt` as a `Date`,
  `count(p.id)` as a `number`, `u.age.cast(t.string())` as a `string`.

::: tip Good to know
- **`null` is not a value to compare with.** `eq(null)` does not compile; use `isNull()`.
  Coming from an ORM where `{ name: null }` builds `IS NULL`, the object form of `where`
  still does.
- **Every value is a parameter.** There is no way to put a string into the SQL text except
  the literal parts of a `fragment` template, which come from your source code.
- **Expressions are immutable.** `a.and(b)` leaves `a` as it was; keep the result.
:::
