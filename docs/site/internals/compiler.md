# How a query becomes SQL

This page is for contributors and for anyone who wants to know what the SQL compiler does
with a query and how to keep it fast. You do not need it to use Egon.

## From a query to a plan

A query is data: `from(User, "u").where(…)` builds a tree that describes the query and
holds its values separately. Nothing is sent to the database until the repo runs it.

Each adapter owns one compiler. When the repo runs a query, the compiler turns the tree
into a **plan**:

- the **SQL text**, with a placeholder wherever a value goes;
- one **slot** per placeholder, saying where its value comes from (the query's values, a
  named parameter) and how to convert it for the driver;
- an **output plan**, saying which result column becomes which part of the value you
  selected (a field of a row, a key of an object).

A plan holds no values. Two queries that differ only in their values share one plan; each
run binds its own values to it.

## What the SQL looks like

<<< @/examples/compiler.ts#to-sql

```sql
select "u"."id" as "c0", "u"."email" as "c1" from "users" as "u"
where "u"."age" >= $1 order by "u"."created_at" desc limit $2
-- params: [18, 10]
```

- **Every name is quoted**: tables, aliases, columns. A quote character inside a name is
  doubled, so any name is safe.
- **Selected values are named `c0`, `c1`, …** in select order. A whole row is expanded to
  its columns, in field order, without virtual fields. The compiler never writes
  `select *`.
- **Every value is a placeholder.** `limit` and `offset` too. A list is one array
  parameter on Postgres (`"u"."id" = any($1)`, `<> all($1)` for `notIn`), so a list of any
  length has the same SQL. Only `lit(true | false | null | number)` is written into the
  text.
- **Parentheses come from operator precedence.** `where(a).where(b).orWhere(c)` is
  `(a and b) or c`, and an `and` inside an `or` always gets its parentheses. A fragment is
  parenthesised whenever it is an operand, since its text is unknown.
- **A value with nothing around it to give it a type is cast to its own**: a value in the
  select list (`cast($1 as integer)`), a cell of a values list, a typed value inside a
  fragment. A value with no type at all may only be a string or `null` there (cast to
  `text`); anything else is refused with `QueryError` naming the place, and `val(5)` in a
  `select` does not compile: give it a type, `val(5, t.integer())`.
- **An `exists(…)` subquery selects `1`** when it has no select of its own.

### Database schemas

Each table's database schema is decided where the table is read, in this order: the
schema given to that source, the schema the schema class declares, the query's
`.schema(…)` (a nested query inherits its enclosing query's), then the per-call `schema`
option or the repo default. Each row remembers the schema it was read from, so it is
written back to the same table.

## The plan cache

| Level | Key | Finds |
|---|---|---|
| By identity | the query object | the same query object, compiled before |
| By shape | a hash of the query's structure, checked structurally on a hit | a query built again with other values |

A query object defined once is compiled once per database schema and found again without
hashing anything. A query built anew on every call is hashed (the hash is computed while
it is built) and found by its shape. Its structure is then compared with the cached one,
because two shapes can hash alike. A mismatch is a miss and counts as a **collision**.

The shape cache keeps the 1,000 most recently used shapes by default. Set the adapter's
`planCacheSize` option to change that.

Row-level writes (`insert`, `update` and `delete` of one row) are cached by schema,
operation, column list and options, so inserting the same set of fields reuses one plan.
An insert of many rows is split into chunks whose sizes are powers of two, largest first
(1,000 rows: 512 + 256 + 128 + 64 + 32 + 8). One column list therefore has at most about
17 insert plans, however many rows are inserted.

## Getting the most from it

**Define queries once.** A query at module level is compiled on its first run and found
by identity after that:

<<< @/examples/compiler.ts#module-level

**Building a query per call is fine** when only its values change. Each call pays for
building the query and one lookup, not for writing SQL:

<<< @/examples/compiler.ts#per-request

**Keep the structure stable.** These make a different shape, and so a different plan:

- different clauses, operators, columns or functions;
- a different number of conditions (an `or` of as many conditions as the request has items);
- a different type for a value, or a value compared with a redacted field;
- a literal from `lit()`, since it is part of the text;
- a different database schema;
- on MySQL and SQLite, a different list length: they have no array parameters, so a list
  is written as `in (?, ?, …)`.

These do not: values, a list's length on Postgres, constants in a select, and what a
preload loads.

**`prepare(q)`** ([Advanced queries](/guide/queries-advanced#prepared-queries)) keeps the
plan on the returned object and skips even the lookup.

## Reading `toSql` output

`repo.toSql(q, params?)` returns the SQL and the parameter array exactly as they would be
sent: values are converted for the driver, and named parameters are filled from the
`params` argument. It returns real values, redacted ones included: it is a debugging tool,
not a log. Logs and telemetry show `**redacted**` in their place.

Placeholders are numbered in the order they appear in the text, which is not always the
order you wrote the clauses: the select list comes before `where`, a CTE before the query
that reads it.

## Cache statistics

The plan cache counts:

| Counter | Meaning |
|---|---|
| `hits` | lookups answered from the cache |
| `misses` | lookups that compiled a new plan |
| `collisions` | lookups whose key matched a plan of another shape (also misses) |
| `size` | plans held (shapes and row-level writes) |

`collisions` should stay at 0. A steady stream of misses means queries change shape from
call to call; the list above says what to look for.

## For contributors

The compiler lives in `packages/core/src/compiler/`:

| File | What it does |
|---|---|
| `dialect.ts` | A dialect is a plain table: quote character, placeholder style, capabilities, and the SQL of every operator, function, aggregate, lock clause and type. |
| `plan.ts` | Bindings, database schemas and the output plan of a query, computed without writing SQL. |
| `emit.ts` | Writes SQL in one pass over the tree, by node kind. |
| `write.ts` | Row-level `insert`, `update` and `delete`. |
| `cache.ts`, `same-shape.ts` | The plan cache and the structural comparison that confirms a hit. |
| `bind.ts` | Builds the parameter array of one run from a plan's slots. |
| `registry.ts` | Precedence levels, and `registerNodeEmitter` for node kinds added later. |

The rules every change keeps:

1. **SQL text has three sources**: the compiler's own code and tables, the static strings
   of a `fragment`, and a custom type's `sql` (only when it is a plain type name). A name
   from the tree that selects SQL (an operator, a function, a lock clause) is looked up in
   a table and refused when it is not there.
2. **A value is a placeholder and a slot**, written together, so the slots are in
   placeholder order.
3. **Every identifier is quoted.**
4. **Parentheses are the compiler's job.**
5. **One emitter, one table per dialect.** Differences between databases are capabilities
   and table entries, never a check of the dialect's name.

**Parameter numbering.** A query keeps its values in one array, in a fixed order: a walk of
the tree in the order its properties are declared. A slot refers to a value by its position
in that array. The SQL writes clauses in another order (the select list before `from`, a
CTE first), so before writing each clause the emitter moves its position counter to where
that clause's values start. Text is always written in text order, and placeholders are
numbered in that order.

**Tests.** Every clause and operator has an expected statement per dialect in the
`*.sql.test.ts` tables (`sql-cases.ts`), and `sql.itest.ts` runs every one of them on
Postgres. `precedence.itest.ts` lets Postgres evaluate random expression trees and checks
the results against JavaScript's. `property.test.ts` checks that a value never reaches
the SQL text, that a name is always quoted, and that a plan bound with another query's
values equals a fresh compile of that query.
