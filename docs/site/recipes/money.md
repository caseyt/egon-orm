# Money

Amounts of money must not be JavaScript floats: `0.1 + 0.2` is not `0.3`. Two safe
choices are a decimal string (what `t.decimal()` gives) or a whole number of cents. This
recipe defines a custom type that keeps cents in your code and a `numeric` column in the
database.

## Setup

The code of this recipe depends on these declarations: the imports, the schema classes, the
repo, and the migration that creates the tables. Run the recipe in an empty database of its
own: each recipe creates its own tables, and some have the same names (`posts`) with other
columns.

<<< @/examples/recipes/money.ts#setup

## The type

<<< @/examples/recipes/money.ts#type

- `cast` accepts what forms and JSON send (`"19.99"`, `19.99`) and refuses anything with
  more than two decimals, instead of rounding.
- `fromDb` and `toDb` convert between the driver's decimal string and cents, digit by
  digit.
- `equal` is left out: cents are numbers, and `Object.is` compares them.

## Using it

<<< @/examples/recipes/money.ts#schema

The examples below start from these rows, after creating the tables:

<<< @/examples/recipes/money.ts#seed

<<< @/examples/recipes/money.ts#use

The database does the arithmetic on the column, and the result is read back with the
type:

<<< @/examples/recipes/money.ts#total

::: tip Good to know
- A number of cents is exact up to `Number.MAX_SAFE_INTEGER` (about 90 trillion dollars).
  For larger amounts, or for exchange rates, use `t.decimal()` and a decimal library.
- Store the currency next to the amount when there is more than one. A
  [parameterized type](/guide/types#types-that-take-options) can carry it as an option.
- On SQLite a decimal is stored as text and compares as text; integer cents in an
  `integer` column sort correctly everywhere.
:::

## See also

- [Custom types](/guide/types#custom-types)
- [Why dates and decimals are strings](/guide/types#why-dates-and-decimals-are-strings)
