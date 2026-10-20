# Coming from Sequelize

Sequelize models are active records: an instance knows how to save, reload and destroy
itself, and validation lives on the model. Egon splits those jobs apart. This page maps
everyday Sequelize code to Egon, task by task. The Sequelize calls are shown inline for
reference; every Egon block is a checked, runnable example (it runs in CI against
Postgres, and the `// =>` comments are the values it produces).

The Sequelize calls are those of Sequelize 6 (npm's `latest`, 6.37, in October 2026). The
examples use a `User` with many `Post`s.

## The model in one paragraph

A `Model` becomes a **schema class**: it describes the table, and its instances are rows,
but a row has no `save()` or `destroy()`. To change data you build a **changeset**: the
input a form sent, filtered to the fields it may change, converted and validated. The
**repo** writes the changeset and returns a result, with validation and constraint errors
on their fields. Reads are **queries**, immutable values built with `from(User, "u")`.

## Defining models

Sequelize: `class User extends Model {}` with `User.init({ email: { type: DataTypes.STRING, allowNull: false, unique: true, validate: { isEmail: true } } }, { sequelize })`,
then `User.hasMany(Post, { foreignKey: "authorId" })`.

<<< @/examples/coming-from.ts#define

- **Non-null by default.** Sequelize attributes allow `null` unless `allowNull: false`;
  Egon fields are non-null unless `.nullable()`.
- **Associations are `static` members**, not calls made after both models exist. The
  foreign key (`authorId`) is a field you declare: `belongsTo` does not add it.
- **Validation is per form, not per model.** `validate: { isEmail: true }` becomes a call
  in a changeset function. A sign-up form and an admin form are two functions that permit
  and check different fields.
- `unique: true` and indexes belong to the database: declare them in a
  [migration](/guide/migrations), and declare `uniqueConstraint("email")` on the changeset
  to get a field error back.
- `timestamps: true` is `...timestamps()`. What Sequelize calls `underscored: true` is the
  default here: `createdAt` is stored in `created_at`.

## Connecting

Sequelize: `new Sequelize(process.env.DATABASE_URL)`.

<<< @/examples/coming-from.ts#connect

## Common tasks

### Create a record

Sequelize: `User.create({ email, name })`, which throws `ValidationError` for invalid input.

<<< @/examples/coming-from.ts#create

### Handle a unique violation

Sequelize: catch `UniqueConstraintError`.

<<< @/examples/coming-from.ts#create-error

See [Constraints](/guide/constraints).

### Create with associated records

Sequelize: `User.create({ email, posts: [{ title }] }, { include: [User.associations.posts] })`.

<<< @/examples/coming-from.ts#nested-create

See [Nested changesets](/guide/nested-changesets).

### Find by primary key

Sequelize: `User.findByPk(id)`, or with `{ rejectOnEmpty: true }` to throw.

<<< @/examples/coming-from.ts#find-by-id

### Find one by a column

Sequelize: `User.findOne({ where: { email } })`.

<<< @/examples/coming-from.ts#find-unique

`getBy` is strict: two matches throw `MultipleResultsError`. `repo.first(query)` is the
"any one" form.

### Filter, order and limit

Sequelize: `Post.findAll({ where: { published: true }, order: [["views", "DESC"]], limit: 10 })`.

<<< @/examples/coming-from.ts#find-many

### The first match

Sequelize: `Post.findOne({ order: [["id", "DESC"]] })`.

<<< @/examples/coming-from.ts#find-first

### Select some attributes

Sequelize: `User.findAll({ attributes: ["id", "email"] })`.

<<< @/examples/coming-from.ts#select

The result is plain objects typed by the `select`, not partly filled model instances.

### Operators: `Op.like`, `Op.or`, `Op.in`, `null`

Sequelize: `where: { email: { [Op.like]: "%@example.com" }, [Op.or]: [{ name: null }, { id: ids }] }`.

<<< @/examples/coming-from.ts#operators

The object form of `where` takes values, `null` (`IS NULL`) and arrays (`IN`), like
Sequelize's shorthand; everything else is a method on the column. See
[Expressions](/guide/query-expressions).

### Count

Sequelize: `Post.count({ where: { published: true } })`.

<<< @/examples/coming-from.ts#count

### Paginate

Sequelize: `limit` and `offset`, or `where: { id: { [Op.gt]: afterId } }` for a cursor.

<<< @/examples/coming-from.ts#paginate

### Eager loading

Sequelize: `User.findAll({ include: Post })`, or `include: [{ model: Post, where: { published: true } }]`.

<<< @/examples/coming-from.ts#include

Each level of `preload` is one extra query, whatever the number of parents, and `limit`
in a preload callback applies to each parent. To load from a join instead, as `include`
does, join and pass the alias: `.joinAssoc("u", "posts", "p").preload({ posts: "p" })`.
See [Preloading](/guide/associations#preloading).

### Filter by an association

Sequelize: `include: [{ model: Post, where: { published: true }, required: true }]`.

<<< @/examples/coming-from.ts#filter-relation

### Group and aggregate

Sequelize: `Post.findAll({ attributes: ["authorId", [fn("COUNT", col("id")), "posts"]], group: ["authorId"] })`.

<<< @/examples/coming-from.ts#group-by

The result is typed: `posts` is a `number`.

### Update a record

Sequelize: `await user.update({ name })`, or set the attribute and `user.save()`.

<<< @/examples/coming-from.ts#update

The row you loaded is not changed: `updateOrThrow` returns a new `User`.

### Update many, and increment

Sequelize: `Post.increment("views", { where: { published: true } })`, or `Post.update(values, { where })`.

<<< @/examples/coming-from.ts#update-many

### Upsert

Sequelize: `User.upsert({ email, name }, { conflictFields: ["email"] })`.

<<< @/examples/coming-from.ts#upsert

### Transactions

Sequelize: `sequelize.transaction(async (t) => { await Post.update(values, { where, transaction: t }); })`.

<<< @/examples/coming-from.ts#transaction

There is no `transaction: t` option to forget: the queries run on `tx`, a repo bound to the
transaction, and only those are inside. There is no automatic passing through CLS either.
See [Transactions](/guide/transactions).

### Raw SQL

Sequelize: `sequelize.query("select … where views > :min", { replacements: { min }, type: QueryTypes.SELECT })`.

<<< @/examples/coming-from.ts#raw

`fragment` interpolations are bound parameters; a plain string is refused.

### Delete

Sequelize: `await post.destroy()`, or `Post.destroy({ where })`.

<<< @/examples/coming-from.ts#delete

<<< @/examples/coming-from.ts#delete-many

## Not supported, and what to do instead

| Sequelize | In Egon |
|---|---|
| `instance.save()`, `instance.reload()`, `instance.destroy()` | Rows have no methods that touch the database: `repo.update(changeset)`, `repo.reload(row)`, `repo.delete(row)`. |
| Lazy loading with getters (`user.getPosts()`) | Not supported. Preload, or query with `assoc(User, user, "posts")`. |
| Hooks (`beforeCreate`, `afterUpdate`, …) | `prepareChanges(fn)` on a changeset runs just before the write, inside its transaction. For work after a write, call it yourself, or use a [batch](/guide/batch). |
| Model validators and `allowNull` checks | Changeset validations; see [Validation](/guide/validation). |
| Scopes (`defaultScope`, `User.scope("active")`) | Functions from query to query: see [Reusable pieces](/guide/queries#reusable-pieces). There is no default scope. |
| Paranoid models (`paranoid: true`) | No built-in. See the [Soft deletes](/recipes/soft-deletes) recipe. |
| `sequelize.sync()` | Not supported. Use [migrations](/guide/migrations). |
| CLS transactions (`Sequelize.useCLS`) | Not supported on purpose: pass `tx`. |
| Getters, setters and virtual attributes on the model | Getters and methods on the class; `.virtual()` fields for values that are not stored. |
| Microsoft SQL Server, MariaDB, Db2, Snowflake | Not supported: Postgres, SQLite and MySQL only. |

## What works differently

::: tip Good to know
- **Rows are data.** There is no `save()` and no dirty tracking on a row. A change is a
  changeset, written by the repo.
- **Writes return a result.** Invalid input and declared constraint violations come back
  as `{ success: false, error }` with messages per field; the `OrThrow` twins throw.
- **Input is filtered.** `cast` takes only the permitted fields from `params`, so there is
  no `fields` option to remember on each `create`.
- **No lazy loading.** An association is on a row only if you preloaded it, and the type
  says so.
- **Fields are non-null by default**, the opposite of `allowNull`'s default.
- **Explicit transactions**, with no `transaction` option to pass on each call.
:::

## See also

- [Introduction](/guide/): the four concepts and why they are separate.
- [Changesets](/guide/changesets): where model validation goes.
- [Recipes](/recipes/): pagination, soft deletes, multi-tenancy and more.
