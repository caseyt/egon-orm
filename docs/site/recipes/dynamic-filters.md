# Filters from a query string

Turn `?q=launch&status=published&minViews=10&sort=popular&page=2` into a query, with every
parameter validated and converted, and an error response for bad input.

## Validating the parameters

A changeset does not need a table. Give it the parameters' types, and it casts and validates
them like any form:

<<< @/examples/recipes/dynamic-filters.ts#parse

- Every value of a query string is a string; `cast` converts `"10"` to `10` and refuses
  `"lots"` for an integer.
- Parameters that are not listed are ignored, so a client cannot add filters you did not
  plan for.
- `default(1)` fills in `page` when it is missing; the others are `undefined` when absent.

## Building the query

<<< @/examples/recipes/dynamic-filters.ts#query

Each `.pipe` adds a clause or leaves the query as it is. The query is immutable, so the
steps can also live in separate functions and be combined.

<<< @/examples/recipes/dynamic-filters.ts#use

`invalid.errors` is `{ minViews: ["is invalid"], page: ["must be greater than 0"] }`, ready for
a 400 response.

::: tip Good to know
- **`undefined` in the object form throws.** `.where({ status })` with `status` undefined
  would match every row, so it is refused; add the clause only when there is a value, as
  above.
- **Escape `like` patterns.** A user's `%` or `_` would otherwise be a wildcard.
- **Sorting by a column name from the request**: map the allowed names to expressions, as
  `sort` does, or use `field(p, name)`, which checks the name against the schema.
- To build a condition before the query exists, see `dynamic` in
  [Conditions built at runtime](/guide/queries-advanced#conditions-built-at-runtime).
:::

## See also

- [Changesets without a schema](/guide/changesets#without-a-schema)
- [Object form](/guide/queries#object-form)
