# Advanced queries

The SQL in the examples is what the Postgres adapter emits; values are always bound
parameters (`$1`, `$2`, …).

## Subqueries

A query can be used inside another: as a source, in a join, with `in`, with `exists`, or
as a single value.

<<< @/examples/queries-advanced.ts#subqueries

- A subquery used as a source must select an object of expressions, or whole rows of a
  schema; anything else does not compile (and throws `QueryError`). Its binding exposes
  the select keys as columns, typed like the selected values; over whole rows it is the
  schema's binding. A query over it that selects nothing returns those objects or rows.
- On the optional side of a `leftJoin`, every column of the subquery is nullable.
- An inner callback can use the outer binding directly, as `u` is used above.
- `scalar(q)` must select one expression, and is `null` when the subquery returns no row.
  A query of whole rows, an object or an array of values does not compile. Neither does
  one that selects a JSON column whose type is an object, since its type cannot be told
  from an object of keys: select it as `.as<unknown>()` and check its shape where you
  read it.
- The inner query's values and named parameters become the outer query's: the outer query
  needs the inner one's named parameters when it runs.
- A subquery in `FROM` or a join reads the queries around its query, not its query's
  own bindings: that would be a lateral join, which is not supported yet (`QueryError`).
- When the inner query is built elsewhere and has no access to `u`, refer to it by alias
  with `outerRef`. A query around the one that uses it must bind that schema under that
  alias, and the query using it must not have a binding of that alias itself (it would be
  read instead); otherwise compiling the query throws `QueryError`:

<<< @/examples/queries-advanced.ts#outer-ref

## Common table expressions

<<< @/examples/queries-advanced.ts#ctes

- `.withCte(name, query, { recursive?, materialized? })` attaches a CTE to a query.
  `materialized: true` computes it once, `false` lets the database inline it; left out,
  the database decides.
- `cte(name, shape)` refers to it as a source. `shape` is a schema class, or the CTE's own
  query, and gives the binding its type. The query given to `withCte` must return the
  same: rows of that schema, or the same keys with the same types (`QueryError`
  otherwise). A recursive CTE's query refers to the CTE before it exists, so it names
  the schema of its rows.
- A CTE's values come first in the SQL, so its parameters are `$1`, `$2`, ….

## Set operations

<<< @/examples/queries-advanced.ts#set-operations

- Both sides must have the same result type; a mismatch is a compile error. Columns are
  combined by position, so both sides must also select their keys in the same order, and
  neither may select a plain value (it is never sent to the database): both are checked
  when the query is built.
- The query the method is called on is the combined query. `orderBy`, `limit` and `offset`
  added after the operation apply to the combined rows; an `orderBy` may only use selected
  expressions (or a `selectedAs` name).
- Nothing else may be added after a set operation (`where`, `join`, `select`, …): it
  would apply to the left side only. Add it to a side before combining, or wrap the
  combined query in `subquery(…)`. For the same reason the left side may not already have
  an `orderBy`, `limit` or `offset`.
- An `intersect` after a `union` or `except` applies to everything before it:
  `a.union(b).intersect(c)` is `(a union b) intersect c`.

## Window functions

<<< @/examples/queries-advanced.ts#windows

- Functions: `rowNumber`, `rank`, `denseRank`, `percentRank`, `cumeDist`, `ntile`, `lag`,
  `lead`, `firstValue`, `lastValue`, `nthValue`, and any aggregate with `.over()`. A window
  function without `.over()` does not compile, and takes no `filter()`.
- `.over("w")` uses a named window declared with `.windows({ … })`. The name is
  type-checked against the windows declared, so declare them before the `select` or
  `orderBy` that uses them.
- `.over({ partitionBy, orderBy, frame })` defines one inline. `frame` is a `fragment`.
- `.over()` with no argument is the whole result.
- Window functions are computed after the rows are filtered and grouped, so they belong in
  `select` and `orderBy` only: in `where`, `having`, `groupBy`, a join's `on`,
  `set` or `returning` they are a `QueryError`. To filter on one, select it in a
  subquery and filter the query over it (the top-N recipe below).

## Conditions built at runtime

Clause callbacks already cover most dynamic queries. `dynamic` is for a condition that is
built before the query it will be used in:

<<< @/examples/queries-advanced.ts#dynamic

Using it on a query that has no binding `u` of `User` is a compile error. `dynamic`
values are accepted by `where`, `orWhere`, `having`, `orderBy`, `groupBy`, `select` and
join conditions, and combine with `.and(…)`, `.or(…)` and `.not()`.

The form above, with the bindings as a type, takes conditions without named parameters.
To use named parameters, or to build an order item or a select shape, give the schemas as
a value; the bindings are then also checked when the query runs the callback:

<<< @/examples/queries-advanced.ts#dynamic-value

`field(binding, name)` picks a column by a name known only at runtime. The name is
checked against the binding's columns, and anything else throws:

<<< @/examples/queries-advanced.ts#field

## Bulk updates and deletes

A query with `.set(...)` describes an `UPDATE`, run with
[`repo.updateAll`](/guide/repo#bulk-writes). A query without it can be run with
`repo.deleteAll`.

<<< @/examples/queries-advanced.ts#bulk

- `.set` takes an object, or a callback returning one. Values are type-checked against
  the fields; plain values are bound with the field's type. The field also types a
  `caseWhen` or `coalesce` made only of values and `NULL`s: it is written
  `cast(case … end as <the column's type>)`, so `caseWhen(p.published, "live").else("draft")`
  and `caseWhen(c, 1).else(2)` work on any column. `.set` may be called again: it adds
  fields, and a field set twice takes the later value.
- `.returning(...)` takes the same shapes as `select` and makes the repo return rows. An
  update has no `select`: calling it is a `QueryError` that points at `returning`.
- Joins become `UPDATE ... FROM` and `DELETE ... USING` on Postgres:

<<< @/examples/queries-advanced.ts#bulk-join

## Prepared queries

`prepare(q)` marks a query that runs many times. Run it like any query, with its named
parameters.

<<< @/examples/queries-advanced.ts#prepare

Today it compiles once per adapter and is then found in the adapter's plan cache by
identity, as any query kept in a variable is; skipping that lookup as well is planned.
What changes between runs are the named parameters; a value written into the query is
fixed.

## Other tools

- **Ordering by a select alias.** `selectedAs(expr, "total")` names a selected expression,
  and `selectedAs("total")` refers to it in `orderBy` or `groupBy`; a name the select does
  not have is a `QueryError`:

<<< @/examples/queries-advanced.ts#selected-as

- **Tuple comparison**, for keyset pagination. A plain value takes the type of the column
  at the same position of the other row; where both rows hold a bound value, the typed one
  is cast. A row has no `null` item and is compared, not selected:

<<< @/examples/queries-advanced.ts#keyset

## Recipes

### Top N per group

<<< @/examples/queries-advanced.ts#top-n

When the groups are the parents of an association, a preload does this for you:
`preload("posts", (q) => q.orderBy(...).limit(3))`. See
[Preloading](/guide/associations#callback-form).

### Recursive tree

The CTE example above: the roots, then `unionAll` with the rows that join the CTE itself.

### Keyset pagination

The tuple comparison above, with the last row of a page as the cursor of the next.

### Rows with no match

<<< @/examples/queries-advanced.ts#no-match

### Updating from a CTE

<<< @/examples/queries-advanced.ts#update-from-cte

To insert a row or update the one that is there, use `onConflict` on
[`repo.insert`](/guide/repo#upserts).

### Conditional filters

The `dynamic` example above: build the conditions from the request, then fold them.

## Not in the first release

Lateral joins, `VALUES` lists as a source, table-valued fragments, index hints,
data-modifying CTEs and named server-side prepared statements are planned. See the
[Roadmap](/reference/roadmap).

::: tip Good to know
- **Nothing after a set operation** but `orderBy`, `limit` and `offset`: wrap the combined
  query in `subquery(…)` to filter it.
- **Window functions** belong in `select` and `orderBy` only; filter on one through a
  subquery.
- **Bulk updates use `.set(…)`** and are run with `repo.updateAll`; there is no guard
  against an update without `where`.
:::

## See also

- [Queries](/guide/queries) and [Expressions](/guide/query-expressions)
- [Top N per parent](/recipes/top-n-per-parent)
- [Dialect support](/reference/dialect-support): what SQLite and MySQL lack.
