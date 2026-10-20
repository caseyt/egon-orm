# Associations and preloading

An association says how two schemas are connected. It is used for three things: joining
in a query, loading related rows (preloading), and saving related rows through a parent
([Nested changesets](/guide/nested-changesets)).

Other libraries call these relations. In Postgres a "relation" is a table, so this
library says association.

## Defining associations

Associations are `static` members of the schema class. Each takes a function returning
the target class, so two schemas can refer to each other.

<<< @/examples/associations.ts#define

| Function | Meaning | Loaded as |
|---|---|---|
| `belongsTo(() => T, opts?)` | This table holds the foreign key. | `T`, or `T \| null` when the foreign-key field is nullable |
| `hasOne(() => T, opts)` | The other table holds the foreign key; at most one row. | `T \| null` |
| `hasMany(() => T, opts)` | The other table holds the foreign key; any number of rows. | `T[]` |
| `manyToMany(() => T, opts)` | Connected through a join table. | `T[]` |

Rules:

- **The foreign-key column is an ordinary field.** `belongsTo` does not create `authorId`;
  you declare it, and the association refers to it by **field name**.
- **`foreignKey` is required on `hasOne` and `hasMany`.** On `belongsTo` it defaults to
  the property name plus `Id` (`author` gives `authorId`). A composite key is an array of
  field names.
- **`references`** is the key on the other side and defaults to the primary key.
- **`manyToMany` with a table name requires `joinKeys`**, holding the join table's column
  names: `owner` points at this schema, `target` at the other. `joinThrough` may instead
  be a function returning a join schema class.
- **`through: ["posts", "comments"]`** follows a chain of associations. It is read-only.

### Options

| Option | On | Effect |
|---|---|---|
| `foreignKey` | all but `manyToMany` | The field holding the key. |
| `references` | all but `manyToMany` | The field the key points at. Defaults to the primary key. |
| `where` | `hasOne`, `hasMany`, `manyToMany` | A condition always applied when joining or preloading. |
| `orderBy` | `hasMany`, `manyToMany` | The default order of preloaded rows. |
| `onReplace` | all | What a nested write does with children that were left out. See [Nested changesets](/guide/nested-changesets#onreplace). |
| `through` | `hasOne`, `hasMany` | A chain of association names. |
| `joinThrough`, `joinKeys`, `joinWhere`, `unique` | `manyToMany` | The join table, its columns, a condition on it, and whether pairs are unique. |

Deleting a parent never touches its children. Use `ON DELETE` in the database.

Associations are checked the first time one is used. A wrong field name or a path that
does not resolve throws `SchemaDefinitionError` naming the schema, the association and
the fix.

## Joining through an association

`joinAssoc(from, name, alias)` is an ordinary SQL join whose `ON` condition is written
from the association. These two are the same query:

<<< @/examples/associations.ts#join

It reads: starting from the binding `u`, follow its `posts` association, and call the
joined table `p`. Beyond saving typing, it adds the join table for a many-to-many, the
whole chain for a `through`, and the association's `where`. `leftJoinAssoc` is the
left-join form. Both take an optional extra condition as a fourth argument.

A join does not load anything onto the parent rows. That is what preloading is for.

## Preloading

Nothing is loaded lazily. An association is on a row only when you ask for it, and the
row's type changes to say so.

There are three ways to preload, and they mix freely in one query:

| Strategy | Written | Statements | Use it when |
|---|---|---|---|
| Separate queries | `preload("posts")`, arrays, nested objects | one per association level | the default: any number of parents, no repeated rows |
| Callback | `preload("posts", (q) => …)` | one per association level | you filter, order, limit (per parent) or select |
| From a join | `preload({ posts: "p" })` | none of its own: the join's | you join the association anyway, to filter on it |

### Short forms

<<< @/examples/associations.ts#short

Each level is **one** extra statement, whatever the number of rows: three nested levels
over ten thousand users is four statements. The preload collects the distinct keys of the
parents and reads all their children at once (`where "posts"."author_id" = any($1)` on
Postgres), then groups the children by key. Siblings at one level are separate
statements, run one after the other.

- `hasMany` and `manyToMany` give an array (empty when there are none), in the
  association's `orderBy`; `hasOne` and `belongsTo` the row or `null`.
- A `null` foreign key is not sent; that parent gets `null`. A level with no keys at all
  (no parents, or only `null` keys) sends no statement.
- **Many-to-many** reads the target joined to the join table, with the parent's key from
  the join table beside each row; the join table's `joinWhere` applies.
- **Has-through** reads the target with the chain joined backwards, in one statement for
  the whole chain. A row reached along several paths (a tag on two of a user's posts) is
  loaded once per parent (as whole rows; a selected shape comes once per path). The
  associations in between are not loaded. A per-parent `limit` is refused on a chain
  along which a row can repeat (one with a `belongsTo` or many-to-many step after the
  first), since it would count that row more than once.
- **Composite keys** are matched on every part, as a row of values.
- Over 10,000 distinct keys, the keys are sent in statements of 10,000 (fewer where the
  database limits the number of parameters).
- Children are read from the database schema their parents were read from, unless the
  parents' schema class declares a database schema of its own: that one says nothing
  about the children's, which are then read with the call's (the query's `.schema(…)`,
  else the call's `schema` option, else the repo's default).

### Callback form

To filter, order, limit or select, pass one association name and a function. The function
receives a query for the associated table, whose binding is named after the association,
and returns a query.

<<< @/examples/associations.ts#callback

- **`limit` and `offset` are per parent.** The example loads the three newest published
  posts of *each* user, still in one statement: the rows are numbered per parent with
  `row_number() over (partition by …)` and filtered on that number. A limit needs an
  order: the callback's `orderBy`, or the association's own. Without one the query throws
  `QueryError` when it is built (`limit in preload "posts" needs an orderBy`).
- **The association's `where` always applies**, in addition to the callback's.
- **Any function from query to query works**, so scopes are reusable (below).
- **Several `.preload()` calls merge.** Two callbacks for one association are an error.
- Named parameters in a callback are the query's: they are passed with the query's, when
  it runs.

<<< @/examples/associations.ts#scope

### Selecting columns in a preload

A callback may `select`. The association is then loaded as plain objects of that shape:

<<< @/examples/associations.ts#select

**The select must include the association's key, under its field name**: the field the
association is matched on (`authorId` for `User.posts`, `id` for `Post.author`). Nothing
is added for you. If it is missing, the query does not compile, and if the types cannot
tell, it throws when it is built:

```
QueryError: preload "posts" selects without its key. Add `authorId: posts.authorId` to the select.
```

Many-to-many and has-through are the exceptions: their key is in another table, so the
preload reads it itself.

A selected shape is not rows. To preload further below it, or to use the association in a
nested write, load whole rows.

### From a join

When the query already joins the association, the join can fill it in the same SQL
statement. Give the binding's alias:

<<< @/examples/associations.ts#join-preload

A string is read as a binding alias only when the query has a binding of that name joined
through that association. Otherwise it is the name of a nested association.

Join preloads nest: `{ posts: { $from: "p", comments: "c" } }` fills `posts` from the
binding `p` and each post's `comments` from the binding `c`. Separate preloads can sit
below them (`{ posts: { $from: "p", tags: true } }`).

<<< @/examples/associations.ts#join-nested

A join returns one row per parent-child pair, so a parent with many children is sent
many times. The rows are merged back by primary key, in the order they came (a parent or
a child first seen first), so the parent schema needs a primary key. Prefer the
separate-query forms unless you are filtering on the join anyway: two to-many joins
multiply each other.

A `limit` or `offset` on the query counts the joined rows, not the parents, so it is
refused (a `QueryError` before anything is sent) on a query with a to-many join preload,
and so is `repo.first`, which adds a limit. Preload such an association with a separate
query, whose per-parent limit is its own. The same holds one level down: a callback's
`limit` or `offset` is refused when the callback join-preloads a to-many association.

### After the fact

<<< @/examples/associations.ts#after

`repo.preload` takes the schema class, then one row, an array or `null`, then the same
specs as a query's `preload`. It returns **new** rows: the inputs are not changed,
because their type is. An association already loaded on a row is skipped (nested
preloads still apply to the rows it holds) unless `force: true`. Rows of another schema
are refused. It takes no `schema` option: each row's associations are read from where
the row was read.

The schema class comes first because a row's type does not say which class it is an
instance of, and so which associations it has. The callback runs at once, so its query
takes values, not named parameters.

`repo.reload` loads again what a row was loaded with: a row read by a query, by
`repo.preload` or by a preload remembers its preloads, callbacks (filter, order, limit,
select) and named values included, and gets exactly those again, at every depth, also
below a level that was loaded empty, and from the database schema the call used. A
join preload is loaded again by a separate query (the join's own conditions, and the
query's `where` on the joined binding, are not kept). A row a write returned remembers
what the row it was given remembered.

### The `Loaded` type

<<< @/examples/associations.ts#loaded

On a plain `User`, `user.posts` does not exist and is a compile error. `isLoaded(User,
user, "posts")` is the runtime check, and narrows the type.

### Things to know

::: tip Good to know
- **No lazy loading.** Reading an association that was not preloaded is a compile error,
  and at run time it is not there.
- **No identity map.** The same record reached through two parents is two objects. Ten
  posts by the same author each get their own `User` object (the author is read once,
  and copied).
- **Sibling associations load one at a time**, so a call holds one connection. The
  `maxConcurrency` option of the call (`repo.all(q, { maxConcurrency: 3 })`) raises
  that; inside a transaction they are always sequential.
- **`timeoutMs` covers the whole call**: the query and every preload statement.
- **Streams do not support preloads.** Read in batches with `limit` and `offset`, and
  preload each batch.
:::

## Querying an association directly

`assoc(Schema, parents, name)` returns a query for the associated rows of one or many
parents, rooted at the target and named after the association. It composes like any
other query:

<<< @/examples/associations.ts#assoc

The association's `where` applies; its `orderBy` does not (add one). A many-to-many or
has-through is found by the target's primary key, which must be a single field.

## Avoiding N+1 queries

A loop that reads each parent's children is one statement per parent. Preload instead:
the number of statements depends on the number of association levels, never on the
number of rows. To keep it that way, assert it in your tests: every statement is a
`query` event, and preload statements report the operation `"preload"`.

<<< @/examples/associations.ts#count

## See also

- [Nested changesets](/guide/nested-changesets): saving a parent with its children.
- [Queries](/guide/queries#joins-and-nullability): joins.
- [Top N per parent](/recipes/top-n-per-parent)
