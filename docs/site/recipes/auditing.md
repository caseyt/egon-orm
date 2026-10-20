# Auditing

Record who changed what, in the same transaction as the change, so a change is never
written without its audit entry or the other way round.

## The audit table

<<< @/examples/recipes/auditing.ts#schema

## A write and its entry, as one batch

<<< @/examples/recipes/auditing.ts#audited

- The second step receives the first one's result by name (`row`), fully typed.
- `changeset.changes` holds only what the changeset changed, already converted to the
  fields' types, so the entry records the change and not the whole row.
- If either step fails, both are rolled back.

<<< @/examples/recipes/auditing.ts#use

The batch is a value: build it in one place (a service function) and run it with
`repo.transaction`, or append it to a larger batch with `append`.

## Reading the history

<<< @/examples/recipes/auditing.ts#read

::: tip Good to know
- **Redacted fields** are in `changes` like any other: leave them out of the entry
  (copy the keys you want) if the audit table must not hold them.
- **Bulk writes** (`updateAll`, `deleteAll`) take no changeset; audit them with a `run` step
  that records the query's parameters, or with a database trigger.
- A database trigger is the other way to audit: it also sees writes that do not go through
  the application. This recipe records the actor, which a trigger does not know.
:::

## See also

- [Batch](/guide/batch)
- [Changesets](/guide/changesets#working-with-changes)
