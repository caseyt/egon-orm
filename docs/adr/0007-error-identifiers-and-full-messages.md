# 0007 — Error identifiers, short messages, and full text by explicit opt-in

- **Status:** proposed (awaiting the owner's decision; part 4's opt-in mechanism is not
  built until this is accepted)
- **Date:** 2026-10-21
- **Step:** 21a (edge readiness, part 4)
- **Affects:** `EgonError` and every subclass (`packages/core/src/errors.ts`); every site
  that throws one, in every package; a new public entry `egon-orm/messages`; the public
  API (one new function, one new field `error.id`, `error.toJSON()`); `reference/errors.md`
  and the guide pages that quote error messages

## Context

The error text Egon throws is about 15% of the minified bundle: 60 KB over roughly 640
sites. Each message says what failed and, usually in a second sentence, what to do about
it. On edge runtimes the bundle is shipped with every deployment and parsed on every cold
start, so the owner decided (2026-10-20) that thrown errors switch to codes: by default a
thrown error carries an identifier, a short sentence and a link to the docs, and the full
text is an explicit opt-in that ships in a separate entry, `egon-orm/messages`. Simulated,
this saves about 46 KB minified and 14 KB gzip on the reference app.

Three things need deciding:

1. **The identifier.** `error.code` already exists, but it names the class (`"query"`,
   `"cast"`), and `QueryError` alone is thrown from more than 200 sites. Every distinct
   message needs an identifier of its own, which tests, callers and the docs can match.
2. **The default message.** What the short form contains.
3. **The opt-in.** How an application asks for the full text. Constraints from the step
   file: explicit rather than inferred (the owner's standing preference); works on
   Cloudflare Workers and Vercel Edge, so no `process`; the default bundle must not grow.

Changeset validation messages (`can't be blank`, …) are data for end users, not thrown
errors, and are not affected.

## Options

### A. The identifier's format

1. **Descriptive, namespaced by the error class:** `query.aliasTaken`,
   `schema.duplicateColumn`, `database.connectionLost`. The namespace is the class
   (`query` for `QueryError`, `cast`, `schema` for `SchemaDefinitionError`, `constraint`,
   `database`, `migration`, `changeset` for `InvalidChangesetError`); a class that throws
   one message only uses its `code` as the whole identifier (`noResults`,
   `multipleResults`, `staleEntry`, `notLoaded`, `rollback`). camelCase, like every other
   name in the API.
   - Readable in a log line and in a test (`expect(e.id).toBe("query.aliasTaken")`),
     without looking anything up.
   - Costs about 20 bytes per site in the default bundle (roughly 13 KB minified over all
     sites, a few KB gzip, because the prefixes compress well); a consumer pays only for
     the modules it bundles.
   - A name can turn out to be badly chosen; renaming it is a breaking change, so names
     are reviewed once, in this step, and frozen at 1.0.
2. **Numeric, like a compiler's:** `EGON1042`, grouped in ranges per class.
   - About 8 bytes per site; immune to naming arguments.
   - Means nothing without the docs; tests and `switch` statements read as magic numbers.
3. **Both** (`EGON1042 query.aliasTaken`): the costs of both, and two things to keep stable.

### B. The default message

`<id>: <short sentence> See <docs link>`, for example

```
query.aliasTaken: join() was given the alias "u", which this query already uses. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-aliastaken
```

The short sentence names what failed (the clause, schema, field, parameter or SQL state)
and keeps every value that is interpolated today; nothing that is redacted today becomes
visible. It carries no advice. The link's base is one constant in `errors.ts`. There is no
real alternative to choose between here, only details; listed so the owner can object.

### C. The opt-in to the full text

The full text is the short sentence followed by the advice ("Each binding needs its own
alias; for a self-join, give the second one another name."). The advice for every
identifier lives in `egon-orm/messages` as a catalog: `{ "query.aliasTaken": "Each binding
needs …", … }`, with `{name}` placeholders where the advice repeats a value. The catalog is
also what the docs pages are generated from. How does an application turn it on?

1. **An explicit call, once, at startup.**

   ```ts
   import { useFullErrorMessages } from "egon-orm";
   import { messages } from "egon-orm/messages";

   useFullErrorMessages(messages);
   ```

   `useFullErrorMessages` stores the catalog in a module-level variable in `errors.ts`;
   the `EgonError` constructor appends the advice when a catalog is set. Passing `null`
   turns it off again.
   - Explicit, and visible in the code that does it. Works anywhere JavaScript runs: no
     `process`, no bundler configuration, no export condition.
   - The default bundle grows only by the lookup in the constructor and the small setter
     (tree-shaken when not imported); the catalog is in the bundle only of an application
     that imports `egon-orm/messages`.
   - Because the catalog is passed in, an application can pass its own: a translated one,
     or one with its own advice. Missing entries fall back to the short message.
   - Global state: it applies to every repo in the process. An error constructed before
     the call (for example a `SchemaDefinitionError` thrown while a schema module is
     imported ahead of the setup code) keeps its short message, so the call belongs in the
     first module the application imports. Two copies of `egon-orm` in one dependency tree
     each have their own setting.
2. **An option on `createRepo`:** `createRepo({ adapter, errorMessages: messages })`.
   - Explicit, and scoped to one repo.
   - Most errors are not thrown by a repo: schema definitions fail when the class is
     defined, queries when they are built (`from(User, "u").where(...)`), `cast` when it is
     called. None of these has a repo to read the option from, so this needs option 1
     underneath anyway, and suggests a scope it cannot keep.
3. **The `development` export condition:** `egon-orm` resolves to a build with the full
   text when the bundler or runtime sets the `development` condition (Vite and webpack in
   dev mode, Node with `--conditions=development`).
   - Nothing to write in the application.
   - Inferred, not explicit: whether a developer sees the full text depends on the
     bundler's configuration, which differs between tools (esbuild and wrangler do not set
     it by default) and is easy to get wrong in production. A second build of the package
     means two copies of every class when both conditions are resolved in one process,
     which decision D14 exists to avoid. The published package roughly doubles.
4. **Formatting at the catch site:** `explain(error)` from `egon-orm/messages` returns the
   full text of an error, without global state:

   ```ts
   import { explain } from "egon-orm/messages";

   try { … } catch (error) { console.error(explain(error)); throw error; }
   ```

   - Explicit, no global state, no ordering problem.
   - `error.message` and the stack trace stay short, so an uncaught error, a test
     failure or a framework's error page still shows only the short form. Useful as an
     addition to option 1, not as a replacement for it.

## Decision (recommended; not yet accepted)

- **Identifiers:** option A1, descriptive and namespaced by class (`query.aliasTaken`),
  exposed as `error.id` and typed as a union (`ErrorId`), so a `switch` on it is checked.
  Each identifier is frozen once released.
- **Default message:** as in B.
- **Opt-in:** option C1, `useFullErrorMessages(messages)`, with `messages` from
  `egon-orm/messages`. It is the only option that is explicit, covers errors thrown
  outside a repo, and needs nothing from the runtime. Option C4 (`explain(error)`) may be
  added beside it if the owner wants a stateless form as well; it is cheap, since it reads
  the same catalog.
- **`error.toJSON()`** returns `{ name, code, id }` in every mode (owner decision,
  2026-10-21): the message, the cause and any SQL stay on the server.

## Consequences

- Every throw site names its identifier and keeps only the short sentence; the advice moves
  to the catalog. Tests that matched message text match `error.id` (or the opt-in text).
- The docs list every identifier with its short message and its advice, generated from the
  catalog and the throw sites; `pnpm docs:check` fails when an identifier is thrown without
  a catalog entry or an entry is never thrown.
- Guide pages that quote error messages are updated to the short form.
- Developers who want the old experience add two lines at startup. A Worker can do the
  same in development; the catalog adds its own size (roughly the 46 KB this saves) only
  to bundles that import it.
- Revisit if a common runtime turns out to need a per-request setting (for example
  different catalogs per tenant), which option C1's global state cannot give.
