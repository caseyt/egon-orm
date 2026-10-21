# Errors as HTTP responses

Egon ships no HTTP helper: which status an error deserves is your application's decision.
This recipe maps the expected outcomes of a read or a write to responses in one function,
and types the response body on the client.

| Outcome | Status | Body |
|---|---|---|
| An invalid changeset (`result.success` is `false`) | 422 | `result.error.errorMessages()` |
| `NoResultsError` from a `...OrThrow` read | 404 | |
| `StaleEntryError`: the row changed or was deleted since it was read | 409 | |
| `ConstraintError` with `type: "unique"`, for a constraint the changeset did not declare | 409 | |
| Anything else | 500 | Nothing about the error: log it instead |

## Setup

<<< @/examples/recipes/error-responses.ts#setup

## One function for the errors

<<< @/examples/recipes/error-responses.ts#map

## The handlers

<<< @/examples/recipes/error-responses.ts#handlers

A write returns a result, so the invalid changeset is handled where it happens, with its
messages. The exceptions are the outcomes a handler does not expect, and go to
`errorResponse`.

## On the client

<<< @/examples/recipes/error-responses.ts#client

- `Json<User>` is the user as `JSON.stringify` writes it: `createdAt` is a string, and the
  virtual `password` is not there (nor would a redacted field be).
- `ErrorMessages<typeof User>` is the type of `errorMessages()`: one optional key per field
  and association, plus the keys that `User.changeset` adds (`passwordConfirmation`) and
  `$base`.

::: tip Good to know
- Declare the constraints a user can violate (`uniqueConstraint("email")`): the write then
  returns an invalid changeset with `has already been taken` on the field, which belongs in
  a 422, instead of throwing.
- A 500 response says nothing about the error. Its message can name tables and
  constraints, which is for your logs, not your users.
:::

## See also

- [Showing form errors (React)](/recipes/form-errors)
- [Errors](/guide/changesets#errors) in the changesets guide
- [Frameworks](/guide/frameworks)
