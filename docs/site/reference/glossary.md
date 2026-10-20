# Glossary

The words these pages use, each in one sense.

| Term | Meaning |
|---|---|
| **Adapter** | The object that connects a repo to one database through its driver: `postgres(…)`, `sqlite(…)`, `mysql(…)`. It owns the connection pool and the plan cache. See [Adapters](/guide/adapters). |
| **Association** | A connection between two schemas, declared as a `static` member: `belongsTo`, `hasOne`, `hasMany`, `manyToMany`, or a chain with `through`. Other libraries call these relations. See [Associations](/guide/associations). |
| **Batch** | A list of named steps that runs in one transaction, built with `createBatch()`. See [Batch](/guide/batch). |
| **Binding** | The name a table has inside a query (`u` in `from(User, "u")`), and the object of its columns that clause callbacks receive (`({ u }) => u.email`). See [Bindings](/guide/queries#bindings). |
| **Capability** | Something an adapter's database can or cannot do, such as `fullJoin`. A query that needs a missing one throws `QueryError`. See [Dialect support](/reference/dialect-support). |
| **Changeset** | An immutable description of a change to one record: the permitted input, converted, the changes, the validation errors, and the constraints to expect. See [Changesets](/guide/changesets). |
| **Changeset function** | A function, usually a static method such as `User.changeset`, that builds the changeset for one form. |
| **Constraint declaration** | A call such as `uniqueConstraint("email")` on a changeset, which turns that database violation into a field error. See [Constraints](/guide/constraints). |
| **Database schema** | A namespace of tables in the database (a Postgres schema, a MySQL database), chosen with the `schema` option. Not to be confused with a schema class. |
| **Dialect** | One of the databases the library writes SQL for: `postgres`, `sqlite` or `mysql`. |
| **Embed** | A structured value stored in one JSON column of its parent, declared with `t.embedOne` or `t.embedMany` and an `EmbeddedSchema`. See [Embeds](/guide/embeds). |
| **Expression** | A typed piece of SQL inside a query: a column, a value, an operator applied to them (`u.age.gte(18)`). See [Expressions](/guide/query-expressions). |
| **Field** | One property of a schema, declared with a type from `t` (`email: t.string()`), stored in a column. |
| **Fragment** | Raw SQL written with the `fragment` tagged template; its interpolations are bound parameters. |
| **Migration** | A versioned change to the database's structure, written by hand. See [Migrations](/guide/migrations). |
| **Named parameter** | A placeholder in a query, `param("minAge", t.integer())`, given a value when the query runs. |
| **Plan** | The compiled form of a query: SQL text, slots for its values, and how to build the result. Cached per query shape. See [How a query becomes SQL](/internals/compiler). |
| **Preload** | Loading the associated rows of a query's rows, with `.preload("posts")` or `repo.preload(…)`. Nothing is loaded lazily. See [Preloading](/guide/associations#preloading). |
| **Query** | An immutable value that describes a read or a bulk write, started with `from(Schema, alias)`. Building it runs nothing. See [Queries](/guide/queries). |
| **Queryable** | What the repo's read methods accept: a schema class (every row) or a query. |
| **Repo** | The object that runs queries and writes changesets, created with `createRepo({ adapter })`. `tx`, in a transaction, is a repo too. See [Repo](/guide/repo). |
| **Result** | What a write returns: `{ success: true, data }` or `{ success: false, error }`. |
| **Row** | An instance of a schema class, as the database returned it. Rows come only from the database; there is no public constructor. |
| **Sandbox** | The test helper that runs each test in a transaction that is rolled back. See [Testing](/guide/testing). |
| **Schema**, **schema class** | A class made with `class User extends Schema("users", { … }) {}` that describes a table. "Model" in other libraries. |
