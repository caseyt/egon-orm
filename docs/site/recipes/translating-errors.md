# Translating error messages

Changeset errors keep their message template and its values apart until you render them,
which is what makes translation and plurals possible.

::: details The schema this recipe uses
No database is needed: the errors come from a changeset alone.

<<< @/examples/recipes/error-messages.ts#setup
:::

## A catalogue

<<< @/examples/recipes/error-messages.ts#catalogue

- The keys are the default messages (`can't be blank`, `should be at least {count}
  character(s)`, …), listed with each validation in [Changesets](/guide/changesets#validations).
- `error.meta` holds the values for the placeholders: `{ count: 2 }`, `{ number: 13 }`.
- `Intl.PluralRules` picks the plural form for the language.

## Using it

<<< @/examples/recipes/error-messages.ts#use

`traverseErrors` returns the same tree as `errorMessages()`, with your function's result
for each error, and descends into nested changesets.

::: tip Good to know
- A custom message (`{ message: "…" }` on a validation) is a key like any other.
- `error.validation` (`"required"`, `"length"`, `"schema"`, …) and `error.constraint`
  (`"unique"`, …) say where an error came from, if you prefer to key the catalogue by
  them.
- Messages from a schema validator such as Zod are already rendered by that library: use
  its own translation support (in Zod 4, `z.config(z.locales.fr())`, for example).
:::

## See also

- [Errors](/guide/changesets#errors) in the changesets guide
- [Showing form errors](/recipes/form-errors)
