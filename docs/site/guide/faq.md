# FAQ and troubleshooting

The errors people meet first, with the exact message and the fix. Compiler messages are
from TypeScript 6 (`tsc --pretty false`); type names in them depend on your code.

## Type errors

### `Property 'posts' does not exist on type 'User'`

```text
error TS2576: Property 'posts' does not exist on type 'User'. Did you mean to access the static member 'User.posts' instead?
```

The row was loaded without the association. Nothing is loaded lazily, so a plain `User`
has no `posts`, and the compiler says so instead of returning `undefined` at run time.
Preload it, and say what a function needs with `Loaded`:

<<< @/examples/faq.ts#preload

See [The Loaded type](/guide/associations#the-loaded-type).

### `Argument of type 'null' is not assignable to parameter of type 'Operand<…>'`

```text
error TS2345: Argument of type 'null' is not assignable to parameter of type 'Operand<string | null>'.
```

You wrote `u.name.eq(null)`. In SQL, `name = NULL` is never true, so the query would match
nothing; it is refused. Use one of these:

<<< @/examples/faq.ts#null

If the types are bypassed, the same mistake throws when the clause is added:

```text
QueryError: where(): eq() was given null. A comparison with null is always unknown in SQL, so it would match nothing: use isNull() or isNotNull(), or isDistinctFrom() to compare treating null as a value.
```

### `Class 'Post' used before its declaration`, or a circular import

```text
error TS2449: Class 'Post' used before its declaration.
error TS2769: No overload matches this call.
    Argument of type 'typeof Post' is not assignable to parameter of type '() => unknown'.
```

An association takes a **function** that returns the class, not the class itself:
`hasMany(() => Post, …)`, not `hasMany(Post, …)`. The function runs the first time the
association is used, after both classes exist, which is what lets two schemas refer to each
other, in one file or across two files that import each other:

<<< @/examples/faq.ts#circular

- Import the other class as a value (`import { Post }`), not with `import type`: the
  function uses it at run time (`TS1361: 'Post' cannot be used as a value because it was
  imported using 'import type'`).
- Without the function, a circular import fails at run time as well, with
  `ReferenceError: Cannot access 'Post' before initialization`.
- Define schemas as classes, `class User extends Schema(…) {}`. A schema held in a `const`
  cannot refer to itself through another schema: TypeScript gives up and types it as
  `any` (`TS7022`). See [Why classes](/guide/schemas#why-classes-and-static-associations).

### `Expected 1 arguments, but got 0` on `new User()`

```text
error TS2554: Expected 1 arguments, but got 0.
```

A schema class has no public constructor: rows come from the database. A new record is a
changeset, `User.changeset(User, params)` or `change(User, values)`, which the repo turns
into a row. Calling the constructor anyway throws:

```text
SchemaDefinitionError: User has no public constructor: a row comes only from the database. Describe a new record with a changeset instead: cast(User, params, [...]) or change(User, values).
```

### `insert takes a changeset of a new record`

```text
error TS2769: No overload matches this call.
  … Property '"insert takes a changeset of a new record (cast(User, …)); this one is of a loaded row: use update() or insertOrUpdate()"' is missing …
```

The changeset was made from a loaded row, so it describes an update:

<<< @/examples/faq.ts#update

The same kind of message, `"a new record has no row: applyChanges() and applyAction() need a changeset of a loaded row"`,
appears when `applyChanges()` is called on a changeset of a class.

### `Type '"emial"' is not assignable to type 'FieldName<typeof User>'`

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type '"emial"' is not assignable to type 'FieldName<typeof User>'. Did you mean '"email"'?
```

The permitted fields of `cast` are checked against the schema. Fix the name; an unknown
name that gets past the types throws `QueryError` when the changeset is built.

### `Argument of type 'number' is not assignable to parameter of type 'Operand<string>'`

```text
error TS2345: Argument of type 'number' is not assignable to parameter of type 'Operand<string>'.
```

The value does not have the column's type (`u.email.eq(1)`). Operators take values of the
column's type; there is no implicit conversion. Convert the value, or compare with
`cast(...)` on the column.

### `Type 'Col<string>' is not assignable to type 'Condition'`

A `where` callback returned a column instead of a condition, for example
`.where(({ u }) => u.email)`. Return a comparison: `u.email.eq(email)`, or for a boolean
column the column itself (`p.published`).

### A preload with a `select` `selects without its key`

```text
QueryError: preload "posts" selects without its key. Add `authorId: posts.authorId` to the select.
```

A preload whose callback selects columns must include the field the association is matched
on (`authorId` for `User.posts`, `id` for `Post.author`); nothing is added for you. Where
the types can see it, this is a compile error that names the field
(`"~error": "preload \"posts\" selects without its key: add authorId to the select"`).

## Errors at run time

### `ConstraintError: … The changeset has not defined this constraint`

```text
ConstraintError: unique constraint "users_email_key" violated on insert into "users".
The changeset has not defined this constraint. Add: .uniqueConstraint("email")
(or .uniqueConstraint("email", { name: "users_email_key" }))
```

The database rejected the write, and the changeset did not say that this violation is an
expected form error. Add the declaration the message suggests to the changeset function;
the write then returns `{ success: false }` with `{ email: ["has already been taken"] }`.
If your index has another name, pass it with `{ name }`. See [Constraints](/guide/constraints).

### `QueryError: where({ name: undefined }) …`

```text
QueryError: where({ name: undefined }) on the root binding "u" (User): undefined is not a value, and a filter that silently disappears matches every row. Leave the key out, or add the clause only when there is a value: if (value !== undefined) q = q.where({ name: value }).
```

A filter built from optional input had no value. Add the clause only when there is one:

<<< @/examples/faq.ts#undefined

### `QueryError: repo.raw() takes a fragment`

```text
QueryError: repo.raw() takes a fragment: repo.raw(fragment`select …`). It was given something else; values go into the template as interpolations, where they are bound.
```

`repo.raw` never takes a string. Write ``repo.raw(fragment`select … where id = ${id}`)``:
the interpolations become bound parameters.

### `NoResultsError` from `getOrThrow`

The row does not exist. Use `get`, which returns `null`, where a missing row is expected,
and map `NoResultsError` to a 404 where it is not (see
[Framework integration](/guide/frameworks#express)).

### `StaleEntryError` on update

No row matched the update: the row was deleted, or the
[optimistic lock](/recipes/optimistic-locking) found a newer version. Pass
`{ staleError: { field } }` to report it on the changeset instead.

## Questions

### Why is there no `user.save()`?

Rows are data: they hold no connection and track no changes. A change is a changeset,
written by the repo; see [Introduction](/guide/#why-keep-them-apart).

### Why does `repo.insert` not throw on invalid input?

Invalid input is an expected outcome of a form, so it is a typed result you handle where
you call it. Every write has an `OrThrow` twin for code where a failure is a bug.

### Can I use my existing tables?

Yes. Declare schema classes that match them, with `.column("…")` where a column name is not
the snake_case form of the field. A table needs no migration history to be used; see
[Adopting an existing database](/guide/migrations#adopting-an-existing-database) to start
migrating it.

### Does it work with SQLite and MySQL?

Yes, with the gaps listed in [Dialect support](/reference/dialect-support). Postgres
supports every feature.

### Is it fast?

It is designed to stay close to the driver (no `Proxy`, rows built from precomputed
tables, compiled SQL cached per query shape). Its overhead is measured in step 19 of the
plan; no numbers are published yet.

## See also

- [Errors](/reference/errors): every error class and code.
- [Glossary](/reference/glossary)
