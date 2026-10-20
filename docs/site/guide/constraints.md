# Constraints

Some rules can only be enforced by the database. Two requests can both check that an
email is free and both find that it is; only a unique index decides which one wins.

A constraint declaration on a changeset tells the repo: if the database rejects this write
for that reason, report it as an error on this field instead of throwing.

<<< @/examples/repo-write.ts#constraints

## Declarations

| Method | Database constraint | Default message |
|---|---|---|
| `uniqueConstraint(field \| fields, opts?)` | unique index or constraint | `has already been taken` |
| `foreignKeyConstraint(field, opts?)` | foreign key, on insert or update | `does not exist` |
| `assocConstraint(assoc, opts?)` | the foreign key of a `belongsTo` | `does not exist` |
| `noAssocConstraint(assoc, opts?)` | foreign key, when deleting a parent that still has children | `is still associated with this entry` |
| `checkConstraint(field, { name, ... })` | check constraint | `is invalid` |
| `exclusionConstraint(field, opts?)` | exclusion constraint | `violates an exclusion constraint` |

Options: `name`, `match` (`"exact"`, `"suffix"` or `"prefix"`), `message`, and `errorKey`
(the field the error is reported on).

The error a declaration produces carries the declared type and name, for code that wants
to tell constraint errors apart from validation errors:

```ts
{ message: "has already been taken", constraint: "unique", meta: { constraint: "unique", constraintName: "users_email_key" } }
```

## How a violation is matched

The database reports the **name** of the constraint that failed. The declaration must
match that name, and its type must fit the violation: `foreignKeyConstraint`,
`assocConstraint` and `noAssocConstraint` match a foreign-key violation; the others match
their own kind. Declarations are tried in the order they were made; the first match wins.

With no `name`, one default is used:

| Declaration | Name matched |
|---|---|
| `uniqueConstraint("email")` on `users` | `users_email_key` |
| `uniqueConstraint(["orgId", "slug"])` on `projects` | `projects_org_id_slug_key` |
| `foreignKeyConstraint("orgId")` on `users` | `users_org_id_fkey` |
| `noAssocConstraint("posts")` on `users` | `posts_author_id_fkey` (the child table's foreign key) |
| `exclusionConstraint("during")` on `bookings` | `bookings_during_excl` |

These are the names Postgres gives a constraint when you do not name it, and the ones
Prisma generates. Drizzle names unique constraints `users_email_unique`, and a unique
*index* is often named `users_email_index`. For any other name, pass it:

<<< @/examples/repo-write.ts#constraint-name

A `checkConstraint` always needs a `name`. `match: "suffix"` or `"prefix"` compares only the
end or the start of the reported name, for names generated per partition or tenant.

### Long names

Postgres keeps at most 63 bytes of a name. When a default name is longer, it shortens it
by trimming the table part and the column part (whichever is longer, a byte at a time)
until `<table>_<columns>_<suffix>` fits. A declaration made with the default name matches
that shortened name too, and a long name passed with `{ name }` matches its first 63 bytes.
A name the database made otherwise (Postgres adds a number when the shortened name is
taken) is not predicted: pass the name it reports with `{ name }`.

Shortening drops the end of the column part, so different declarations can shorten to
the same name: a declaration of one long column can match a two-column constraint whose
shortened name starts the same way. The first matching declaration wins, so name long
constraints explicitly with `{ name }`.

## When a constraint was not declared

The repo throws a `ConstraintError` whose message says what to add:

```
unique constraint "users_email_key" violated on insert into "users".
The changeset has not defined this constraint. Add: .uniqueConstraint("email")
(or .uniqueConstraint("email", { name: "users_email_key" }))
```

When the reported name is not a default name the repo can read fields from, the message
shows the `{ name }` form with a placeholder for the field. The message never includes the
value that was rejected; the error keeps the database's own report as `detail` and `cause`.

## One error per attempt

The database stops at the first violation, so a write reports at most one constraint
error, even if several would fail. Validations, by contrast, all run and all report.

## Not-null

A `NOT NULL` violation is never converted. The repo checks required fields itself before
sending SQL; see [Required fields](/guide/changesets#required-fields).

## Early feedback

`validateUniqueAsync(fields, repo)` queries for another row with the same values (not the
changeset's own row) and adds `has already been taken` (`validation: "uniqueAsync"`)
before the write is attempted. It runs only when one of the fields changed, all of them
have a value and none has an error already, nor has the key the error would go on
(`errorKey`, by default the first field). A changeset of a loaded row is checked in the
database schema the row was read from, where its update will be written. It cannot
replace the constraint, because
another request can insert between the check and the write. Declare both.

<<< @/examples/repo-write.ts#early-feedback

## Bulk writes

`insertAll`, `updateAll` and `deleteAll` take no changeset, so a violation there is always
thrown as a `ConstraintError`.

## SQLite

SQLite reports a unique violation by its columns, not by an index name. The adapter turns
that into the default name, so `uniqueConstraint("email")` works. A custom `name` cannot be
matched there.
