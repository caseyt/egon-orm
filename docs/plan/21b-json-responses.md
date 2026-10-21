# Step 21b — JSON responses

**Depends on:** 20 (merged). Runs before 21. Can run in parallel with 21a; both touch
`packages/core/src/schema/schema.ts` (21a its code generation, this step `toJSON`), so
whichever merges second rebases.
**Owns:** the row and changeset `toJSON` (`packages/core/src/schema/`, the `toJSON` of
`changeset/changeset.ts`), the field flags in `packages/core/src/contracts/schema.ts`, the
`Loaded` types' markers, `ErrorTree` and `errorMessages()` typing (`changeset/types.ts`), a
new `packages/core/src/json.ts` (or similar) for `Json` and `JsonReturn`, their type tests,
`docs/site/recipes/error-responses.md` (new), `docs/plan/status/21b.md`.

> **Owner decisions, 2026-10-21:** add typed JSON responses before the release:
> `Json<User>` (the row type, not the class), `JsonReturn<typeof fn>`, the recommended
> value mapping, virtual fields left out of JSON unless a field opts in, and `toJSON()`
> returning the JSON-ready shape. Typed error trees are included. The safe JSON form of
> thrown errors (`error.toJSON()`) belongs to step 21a, which adds the error identifiers.

## Goal

A row sent to a client has a type that matches what the client receives:
`Json<User>` has `createdAt: string`, no `passwordHash` and no virtual `password`, and
includes exactly the associations that were preloaded. `JSON.stringify` never throws on a
row, and `errorMessages()` is typed by field name.

## Background (2026-10-21, `main` at `5059d6b`)

- `rowToJSON` (`schema/schema.ts`) already drops redacted fields, recurses into preloaded
  associations and embeds, and leaves out getters and methods. Nothing types its result,
  so a frontend uses `User`, which says `Date` and includes `passwordHash`.
- `JSON.stringify` of a row with a `t.bigint()` field throws ("Do not know how to
  serialize a BigInt"); a `t.binary()` value becomes `{"0":1,"1":2}`.
- Virtual fields are included: `toJSON()` of a row holds `password`. A write returns a row
  whose virtual fields keep their changes (`guide/repo.md`), so `JSON.stringify(result.data)`
  after a sign-up holds the plaintext password. `JSON.stringify(changeset)` does too
  (`{"changes":{"password":"hunter2hunter2"},…}`): the changeset's `toJSON` leaves out only
  redacted fields. Fix both first (part 2), with tests, even if the rest of the step slips.
- `toJSON()` returns `Date` objects, which `JSON.stringify` converts afterwards; called
  directly (for a React client component) it returns a third shape.
- `errorMessages()` returns `ErrorTree<string>`, whose keys are untyped.
- The row type (`RowOf<F>` plus the class's members) does not lead back to its fields: a
  getter and a field look the same. `Loaded<S, P>` does not record what was preloaded.

## Work

### 1. One flag for "in JSON"

- `FieldFlags` gets one flag, `json` (true by default). `.redact()` and `.virtual()` set it
  to false; `.virtual({ json: true })` keeps it true. Redaction always wins: a redacted
  field is never in JSON, whatever order the modifiers are called in (`.redact()` never
  changes the flag back). `FieldMeta` gets the same value at runtime.
- Update `DefaultFieldFlags`, `WithFlag` and every hand-written flags type in the source,
  tests and docs.

### 2. `toJSON` returns the JSON-ready shape

- A row's `toJSON()` returns exactly what `Json<Row>` describes, so `JSON.parse(JSON.stringify(row))`
  deep-equals `row.toJSON()`. Fields whose `json` flag is false are left out; preloaded
  associations and embeds recurse; associations that were not preloaded stay absent.
- The value mapping, per field type, from a table built once per schema (hot-path rules,
  README §7, apply: no per-row closures, spread or `delete`; a fixed order of keys):

  | Field type | In JSON |
  |---|---|
  | `t.timestamp()`, `t.localTimestamp()` | ISO string (`toISOString()`) |
  | `t.date({ as: "date" })` | `"YYYY-MM-DD"` (the calendar date, not a UTC midnight timestamp) |
  | `t.date()`, `t.time()`, `t.decimal()`, `t.uuid()`, `t.string()`, `t.enum()` | unchanged (strings) |
  | `t.bigint()` | decimal string |
  | `t.bigint({ mode: "number" })`, `t.integer()`, `t.float()` | number (`NaN` and `±Infinity` become `null`, as `JSON.stringify` does) |
  | `t.binary()` | base64 string (own encoder: Node 22 has no `Uint8Array.prototype.toBase64`, and core has no dependency) |
  | `t.boolean()` | boolean |
  | `t.json<T>()`, arrays, embeds | mapped element by element / field by field |
  | a custom type (`defineType`) | the value's own `toJSON()` when it has one, else unchanged |
- A class's own `toJSON` (allowed by the schemas guide) still replaces the default, at
  every level.
- A changeset's `toJSON()` leaves out of `changes` every field whose `json` flag is false.
- Tests: each row of the table; a row with every type through `JSON.stringify`; nested
  preloads (to-one, to-many, `null`); embeds; an override at a nested level; the sign-up
  case (the returned row and the changeset have no `password`); `.virtual({ json: true })`;
  `.virtual({ json: true }).redact()` and `.redact().virtual({ json: true })`.

### 3. `Json<T>` and `JsonReturn<F>`

Type-only exports from `egon-orm`; they add nothing to any bundle.

- A type-only marker on every row type carries its fields' builders (an optional property
  keyed by a `declare`d unique symbol, so nothing exists at runtime and editors do not
  suggest it). `Json<User>` takes the fields whose `json` flag is true, mapped as in part 2.
  Getters and methods are left out.
- `Loaded`, `LoadedUnchecked` and `LoadedAs` carry a second marker: the preloaded
  associations as an object type (`{ author: true; comments: true }`, not a union of
  names), so a row with more preloads is still assignable where fewer are expected. `Json`
  includes exactly those associations, recursively; a nullable `belongsTo` stays `| null`.
- A row type with its own `toJSON` member (an override; `toJSON` cannot be a field name) is
  `Json` of that member's return type.
- Outside rows, `Json` follows `JSON.stringify` exactly: `Date` becomes `string`, a value
  with `toJSON` becomes `Json` of its return type, `undefined`, functions and symbols are
  dropped from objects and become `null` in arrays, and a plain `bigint` is `never` (it
  throws). Plain objects and arrays are mapped recursively, so `Json<{ post: Loaded<…>;
  related: Post[] }>` works. Shapes selected in a preload (`LoadedAs` with a `select`) are
  plain objects and follow these rules.
- Rows' `toJSON()` is typed as returning `Json` of the row.
- `JsonReturn<F> = Json<Awaited<ReturnType<F>>>`. It keeps `null`: the docs show the
  `...OrThrow` reads, or `NonNullable`, for handlers that answer a miss with 404.
- Type tests (`*.test-d.ts`): every rule above; the preload forms (string, array, nested
  object, `true`); a row with more preloads where fewer are expected; a getter returning a
  row is not included; `JsonReturn` of a function returning a row, an array, `| null`, a
  write's `Result`, and an object of rows. Record the type-check time of the core type tests
  before and after in the status note.

### 4. Error trees typed by field

- `errorMessages()` (and `traverseErrors`) return a tree typed by the changeset's schema:
  field names, associations and embeds as nested trees (arrays for to-many), and the extra
  keys that validations add (`validateConfirmation`'s `<field>Confirmation`; a literal key
  passed to `addError`), which the changeset type collects as they are added.
- If collecting the extra keys costs too much type-checking time (measure as in part 3),
  propose the fallback (field names plus any string key) under "Needs the owner's
  decision" in the status note before building it.
- Export the tree type (`ErrorMessages<…>`) for clients; `JsonReturn` of a server action
  returning `errorMessages()` gives the same type.
- Type tests: autocomplete keys, a typo is a compile error, nested trees, extra keys.

### 5. Docs

- `guide/schemas.md` (Serialisation): the new `toJSON` shape, the value table, virtual
  fields and `.virtual({ json: true })`.
- `guide/frameworks.md`: typing responses with `Json` and `JsonReturn`, the three ways to
  name a type with preloads (from the function; `Json<Loaded<typeof Post, …>>`; one spec
  `as const satisfies PreloadSpec<typeof Post>` used by both the query and the type), and
  `user.toJSON()` for React client components.
- `recipes/form-errors.md`: the typed error tree on the client.
- `recipes/error-responses.md` (new): mapping errors to HTTP responses in application
  code (`NoResultsError` → 404, `StaleEntryError` and a unique `ConstraintError` → 409, an
  invalid changeset → 422 with `errorMessages()`, others → 500 with `error.toJSON()` from
  step 21a). The library ships no HTTP helper.
- The guide pages belong to step 20: list the changes in the status note for the owner
  (plan README §8). Every example compiles (`docs/site/examples`).

## Acceptance

- [ ] `JSON.stringify` never throws on a row or a changeset of any built-in type (tested
  with every type).
- [ ] No virtual field without `json: true`, and no redacted field, in any row's or
  changeset's JSON, at any depth (tested, including the row a write returns).
- [ ] `JSON.parse(JSON.stringify(row))` deep-equals `row.toJSON()` for every type (tested).
- [ ] `Json<User>`, `Json<typeof loadedRow>` and `JsonReturn<typeof fn>` match the runtime
  output in every case listed in part 3 (type tests).
- [ ] `errorMessages()` keys are typed, with nested trees and the extra keys (or the
  owner-approved fallback).
- [ ] No runtime cost outside `toJSON`: no change on the query or hydration paths.
- [ ] `pnpm check`, `pnpm test:integration` (both tiers), `pnpm lint:packages`,
  `pnpm smoke` and `pnpm docs:build` pass; no check weakened.
- [ ] Benchmark and budget items: deferred to step 19 (owner decision, 2026-10-14).

## Out of scope

- `Plain<T>` and a `toPlain(row)` keeping `Date` and `bigint` (`toJSON()` is the one shape).
- Revivers that turn strings back into `Date` on the client.
- A browser entry point (`egon-orm/client` with `cast` and the validations).
- A `defineType` hook declaring a custom type's JSON form (add to "Requests" if a test
  case needs it).
- An HTTP helper in the library (part 5's recipe instead).
- The JSON form of thrown errors (step 21a, part 4).
