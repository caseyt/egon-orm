# Nested changesets

A parent changeset can carry changes to its associated records, so a post and its
comments are validated together and saved in one transaction.

<<< @/examples/nested-changesets.ts#intro

For nested objects stored in a JSON column, see [Embeds](/guide/embeds). The examples on
this page use these schemas:

<<< @/examples/nested-changesets.ts#define

## `castAssoc`

`castAssoc(name, { with?, required? })` reads the association's data from the params given
to `cast` and builds a child changeset for each item.

- **`with`** is the child's changeset function, called as `with(target, item, index)`:
  `target` is the existing child for an update, the target class for a new record, and
  `index` is the item's position (0 for a to-one value). It defaults to the target
  schema's static `changeset` method; without one, `with` is required (a compile error
  where the types know the target).
- **`required: true`** adds `can't be blank` when the result is empty (no items, or `null`).
- **Params** are an object or `null` for a to-one association, and an **array** of objects
  for a to-many association. Anything else adds `is invalid` to the association.
- **A key missing from the params changes nothing** (with `required: true`, it is
  `can't be blank` when the parent has no children).
- **The association must be preloaded** on a loaded parent, as whole rows (a preload with
  a `select` does not count). Otherwise `castAssoc` throws `NotLoadedError`. A new parent is
  treated as having no children.
- `castAssoc` needs a changeset made by `cast`; for values you trust, use `putAssoc`.

<<< @/examples/nested-changesets.ts#with

### How items are matched

Each incoming item is compared with the existing children by primary key, the item's key
first cast with the key field's type (`"3"` matches `3`):

| Incoming item | Existing child | Result |
|---|---|---|
| has the key of a child | yes | `with(existingChild, item)`, an update |
| has no key, or a key no child has | — | `with(ChildClass, item)`, an insert |
| has the same key as an earlier item | — | an insert in its place, and `is invalid` on the association |
| — | a child no item names | decided by `onReplace` |

The new children keep the order of the params; the changes for children left out follow
them. When every item matches its child in order and changes nothing, the association has
no change.

For a to-one association, an item whose key matches updates the existing row; otherwise
the existing row is replaced according to `onReplace` and a new one is inserted. `null`
removes the existing row according to `onReplace`.

### `onReplace`

`onReplace` is set on the association and decides what happens to an existing child that
the new data leaves out (or, for a to-one association, replaces).

| Value | Effect | Kinds |
|---|---|---|
| `"error"` | Throw a `QueryError`, before anything is sent. The default: nothing is removed unless you said how. | all |
| `"invalid"` | Add `is invalid` to the association; the parent cannot be saved. | all |
| `"setNull"` | Update the child, setting its foreign key to `null` (the key must be nullable). For `belongsTo`, the old parent is left as it is. | `hasOne`, `hasMany`, `belongsTo` |
| `"update"` | To-one only: reuse the existing row and update it, whatever key the item has. It cannot remove the row (`null` throws). | `hasOne`, `belongsTo` |
| `"delete"` | Delete the child. For `manyToMany`, delete the join row only: the target row stays. | all |
| `"deleteIfExists"` | Delete the child, and do not fail if it is already gone. | `hasOne`, `hasMany`, `belongsTo` |

<<< @/examples/nested-changesets.ts#form

## `putAssoc`

`putAssoc(name, value)` sets an association from data you trust: a list for `hasMany` and
`manyToMany`, one value or `null` for the others. Each value is one of:

- a **loaded row**: kept as it is (for `hasMany` and `hasOne`, its foreign key is set to
  the parent's key when the parent is saved; for `manyToMany`, it is linked);
- a **changeset**: inserted if it is for a new record, updated otherwise;
- a **plain object**: a new record, or an update when it carries the primary key of an
  existing child. It may hold values for the child's own associations and embeds, which are
  put on the child in turn.

Children that are left out follow `onReplace`. Putting the rows that are already there
changes nothing. Giving the same row twice throws a `QueryError`.

<<< @/examples/nested-changesets.ts#put

`buildAssoc(Schema, parent, name, values)` returns a changeset for a new child of a
`hasOne` or `hasMany` association, its foreign key already set. The schema class comes
first, as for `assoc` and `isLoaded`: a row's type does not lead back to its class.

<<< @/examples/nested-changesets.ts#build

## Errors

Child errors stay on the child changesets. The parent is invalid when any child is.

<<< @/examples/nested-changesets.ts#errors

When the association also has errors of its own (`is invalid` from `onReplace`, say), the
tree keeps both: `{ comments: { $errors: ["is invalid"], $items: [{}, { body: [...] }] } }`
for a list, and `$errors` beside the child's own keys for a single child.

An issue from a schema validator whose path leads into an association or embed is placed
on the matching child (by position for a list, counting the children that stay), so one
nested schema can validate the whole payload. The validator sees each changed association
as the values of its children.

<<< @/examples/nested-changesets.ts#zod

## Saving

`repo.insert` and `repo.update` save the whole tree:

1. Everything runs in **one transaction**: its own on the pool, or a savepoint inside a
   transaction (so a failure undoes only this write and the outer transaction carries on).
   The parent's `prepareChanges` functions run inside it, and get the transaction's repo.
2. **Order:** `belongsTo` targets first (their keys go into the parent), then the parent,
   then `hasOne` and `hasMany` children (which receive the parent's key): rows leaving the
   association first, then updates, then inserts. Then `manyToMany` targets, and their join
   rows. A replaced `belongsTo` target with `onReplace: "delete"` is deleted after the
   parent stops pointing at it.
3. Each child goes through the normal insert, update or delete, so its own nested changes,
   prepare functions, constraints and optimistic locking apply.
4. **If any child fails, everything is rolled back** and the result is the parent
   changeset, with the failing child in its place carrying its errors and `action`. An error
   that is thrown (an undeclared constraint, a stale row) is thrown after the rollback.
5. On success, the returned parent has each written association loaded with the saved
   children (rows that left it removed). Its type does not show them: narrow it with
   `isLoaded`.

<<< @/examples/nested-changesets.ts#save

`timeoutMs` is one budget for every statement of the call. An upsert (`onConflict`) cannot
be combined with changes of associations.

::: tip Good to know
- Nothing is written until you call the repo; changesets never touch the database.
- Deleting a parent does not touch its children: that is the database's `ON DELETE`.
- Children are never removed silently: leaving one out throws unless the association's
  `onReplace` says what to do.
- Has-through associations are read-only: change the associations they go through.
:::

## Recipes

- **A form with rows that can be added, edited and removed:** `castAssoc` with
  `onReplace: "delete"` on the association. Rows left out of the submitted array are
  deleted.
- **A tag picker:** `putAssoc("tags", tags)` with rows you looked up or created first,
  inside a [batch](/guide/batch); the association needs `onReplace: "delete"` for tags to
  be removed.

<<< @/examples/nested-changesets.ts#tag-picker
