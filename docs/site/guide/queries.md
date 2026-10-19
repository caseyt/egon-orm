# Queries

A query is an immutable value that describes what to read. Building one runs nothing; a
[repo](/guide/repo) runs it.

<<< @/examples/queries.ts#overview

The result type comes from the query: the schema's row when there is no `select`, and the
shape of the `select` when there is one. Nothing is generated; the types follow from the
schema classes.

## Bindings

Every table in a query has a name, its **binding**. `from(User, "u")` names the first one
`u`, and each join adds another. Clause callbacks receive all of them as one object:

<<< @/examples/queries.ts#bindings

A binding has one column per field of its schema (`u.email`, `u.createdAt`), each an
[expression](/guide/query-expressions) with the field's type. Virtual fields have no
column, and associations are not columns: join them (below) to use their columns.

- The alias is required.
- Using the same alias twice throws `QueryError`, and is a compile error.
- Aliases that start with `$` are reserved for tables the library joins itself (the join
  table of a many-to-many association).
- The same schema can be joined twice under two aliases, a self-join:

<<< @/examples/queries.ts#self-join

## `from`

`from(source, alias)` starts a query. The source is a schema class, or one of the wrappers
described in [Advanced queries](/guide/queries-advanced): `subquery(q)` or `cte(...)`.

It does not accept a query. To continue a query, call more methods on it.

## Clauses

| Clause | Notes |
|---|---|
| `.where(callback)` | Several `where` calls are combined with `AND`. |
| `.where({ field: value })` | Object form on the first binding. See below. |
| `.orWhere(callback)` | Combined with `OR` against everything before it. Takes the object form too. |
| `.join(Schema, alias, on)` | Inner join. |
| `.leftJoin`, `.rightJoin`, `.fullJoin` | Outer joins. |
| `.crossJoin(Schema, alias)` | No condition. |
| `.joinAssoc(from, assoc, alias, on?)` | Inner join through an [association](/guide/associations#joining-through-an-association). |
| `.leftJoinAssoc(from, assoc, alias, on?)` | Left join through an association. |
| `.select(callback)` | What to return. See [Select](#select). A query has one. |
| `.selectMerge(callback)` | Adds keys to an object select. |
| `.distinct()` | `SELECT DISTINCT`. |
| `.distinct(callback)` | `DISTINCT ON (...)`, Postgres only. |
| `.groupBy(callback)` | One expression or an array. Several calls add to the list. |
| `.having(callback)` | Needs a `groupBy`. |
| `.orderBy(callback)` | One expression or an array. A bare column sorts ascending. Several calls add to the list. |
| `.limit(n)`, `.offset(n)` | Bound parameters, so every page size shares one plan. A later call replaces an earlier one. |
| `.lock(mode, opts?)` | Row locks. See [Locks](#locks). |
| `.schema(name)` | The database schema for this query. |
| `.exclude(clause)` | Removes a clause, such as `"orderBy"` or `"limit"`. |
| `.reverseOrder()` | Flips every `orderBy`; with none, orders by the primary key, descending. |
| `.preload(...)` | Loads associations. See [Preloading](/guide/associations#preloading). |
| `.pipe(fn)` | `q.pipe(f)` is `f(q)`. |

### `where` and `orWhere`

<<< @/examples/queries.ts#where

`orWhere` applies to everything before it. For an `OR` inside one condition, use the
`or` function:

<<< @/examples/queries.ts#or

A callback must return a condition (a boolean expression); anything else is a compile
error and a `QueryError`.

### Object form

<<< @/examples/queries.ts#object-form

- A value means equals, `null` means `IS NULL`, an array means `IN`.
- The keys are the fields of the first binding; the values are typed by those fields.
- An array or JSON field holds arrays itself, so there an array is the value, compared
  whole, never a list. For anything else on such a column, use the callback form:

<<< @/examples/queries.ts#object-form-arrays

- `undefined` throws. A filter that silently disappears, and so matches every row, is a
  common bug. Add the clause conditionally instead:

<<< @/examples/queries.ts#dynamic

### Joins and nullability

<<< @/examples/queries.ts#joins

A left join makes the joined binding's columns nullable in the types; right and full
joins also make the existing bindings nullable, and the rows of a query with no select
(`Post | null`). Selecting a whole left-joined binding gives `Row | null`:

<<< @/examples/queries.ts#nullability

A right or full join comes before the query's `select` and `preload`: both take the rows
as they are, and a preload needs rows that exist.

`joinAssoc` writes the `ON` condition from the association: its keys, its `where`, the
join table of a many-to-many, and every step of a `through` chain.

### Select

`select` decides the result type.

<<< @/examples/queries.ts#select

An array is typed element by element, with or without `as const`: `[u.id, u.email]` gives
`[number, string]`. That holds up to four levels deep (objects and arrays counted together);
deeper, add `as const`.

With no `select`, a query returns rows of its first binding, with the class's getters and
methods. A query has one `select`; calling it twice throws. `selectMerge` adds keys to an
object select (a key it already has is replaced):

<<< @/examples/queries.ts#select-merge

### Grouping, ordering and distinct

<<< @/examples/queries.ts#group

<<< @/examples/queries.ts#order

<<< @/examples/queries.ts#distinct

### Limit and offset

<<< @/examples/queries.ts#paging

Both take a whole number of zero or more, or a [named parameter](#named-parameters).

### Locks

<<< @/examples/queries.ts#locks

The modes are `"update"`, `"share"`, `"noKeyUpdate"` and `"keyShare"`, with at most one of
`skipLocked` and `noWait`. A lock is never a string of SQL: another lock clause is a
`fragment`. SQLite has a single writer and ignores locks.

### Other clauses

<<< @/examples/queries.ts#other

## Queries are values

Every method returns a new query. A base query can be kept and extended without changing
it:

<<< @/examples/queries.ts#values

Callbacks run once, when the clause is added. They must not have side effects.

## Reusable pieces

A function from query to query is a reusable scope. `QueryWith` types it:

<<< @/examples/queries.ts#scopes

The scope is a compile error on a query that has no binding `p` for `Post`. It returns
the same query type it was given, so the result type and the named parameters are kept.
`QueryWith` with no argument is any query.

Three limits inside a scope, since it does not know how the query it receives was built:

- its bindings may come from a left join, so a `select` in the scope sees their columns as
  nullable (`p.title` is `string | null`);
- its root is unknown, so the object form of `where` does not compile there; use the
  callback form;
- for the same reason, `preload` does not compile there.

`hasNamedBinding(q, "p", Post)` is the runtime check, and narrows the query's type, for code
that receives a query it did not build:

<<< @/examples/queries.ts#has-named-binding

## Named parameters

`param(name, type)` leaves a placeholder that is filled in when the query runs:

<<< @/examples/queries.ts#params

The query's type collects the named parameters of every clause, and of the callbacks of
its preloads, which run with the same values. One name has one type, nullability included
(`t.integer()` and `t.integer().nullable()` are two types). Using it with another type in a
later clause or a preload callback is a compile error where the query runs (its parameter
type becomes `never`, so no value can be given), and a `QueryError` when the clause is
added. Within one expression it is a compile error at once.

Two field types that are the same TypeScript type are told apart only when the clause is
added: `t.integer()` and `t.bigint({ mode: "number" })` are both `number`, so using one name
with both compiles, and throws `QueryError`.

## Debugging

- `q.toString()` prints a compact rendering without values:

<<< @/examples/queries.ts#to-string

- `repo.toSql(q)` returns the SQL and the parameters.
- `repo.explain(q)` asks the database for its plan.
- [How a query becomes SQL](/internals/compiler) explains the SQL you will see there, and
  how compiled plans are cached.

## Errors

A mistake in a query throws `QueryError` when the clause is added, not when the query
runs. The message names the clause and the binding or field involved.

::: tip Good to know
- **Values are always bound.** Every value in a clause, `limit` and `offset` included, is a
  parameter, never SQL text.
- **One `select` per query.** Use `selectMerge` to add keys, or `exclude("select")` first.
- **`undefined` in the object form throws** instead of matching every row.
- **Removing a clause that holds a named parameter throws**, because the query's type
  would still ask for the parameter.
:::
