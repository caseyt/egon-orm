// The checked sources of the code blocks in reference/errors.md. Each `#region` is included
// in the page by name; everything outside a region is the scaffolding that makes the regions
// compile.
import {
  type Changeset,
  ConstraintError,
  DatabaseError,
  InvalidChangesetError,
  isEgonError,
  type Repo,
  type Schema,
  type t,
  useFullErrorMessages,
} from "egon-orm";
import { explain, messages } from "egon-orm/messages";

declare const repo: Repo;
declare class User extends Schema("users", { id: t.integer().primaryKey(), email: t.string() }) {}
declare const cs: Changeset<typeof User, true>;

export async function handle() {
  // #region handle
  try {
    await repo.insertOrThrow(cs);
  } catch (error) {
    if (error instanceof InvalidChangesetError) return error.changeset.errorMessages();
    if (error instanceof ConstraintError) return { [error.column ?? "$base"]: [`violates ${error.type}`] };
    if (error instanceof DatabaseError && error.retryable) return "busy: try again";
    throw error;
  }
  // #endregion handle
  return null;
}

export function byCode(error: unknown) {
  // #region by-code
  // Works when two copies of the package are loaded, where instanceof would not.
  if (isEgonError(error, "noResults")) return 404;
  if (isEgonError(error) && error.code === "timeout") return 503;
  // #endregion by-code
  return 500;
}

export function byId(error: unknown) {
  // #region by-id
  if (isEgonError(error) && error.id === "query.aliasTaken") return "pick another alias";
  // #endregion by-id
  return undefined;
}

export function toClient(error: unknown): Response {
  // #region to-json
  // { "name": "NoResultsError", "code": "noResults", "id": "noResults" }: no message, cause or SQL.
  if (isEgonError(error)) return new Response(JSON.stringify(error), { status: 400 });
  // #endregion to-json
  throw error;
}

export function fullMessages(development: boolean) {
  // #region full-messages
  // In the first module the application imports, before any schema is defined:
  if (development) useFullErrorMessages(messages);
  // #endregion full-messages
}

export async function explained() {
  // #region explain
  try {
    await repo.insertOrThrow(cs);
  } catch (error) {
    console.error(explain(error)); // the full text of this one error, whenever it was made
    throw error;
  }
  // #endregion explain
}

export function translated() {
  // #region translated
  useFullErrorMessages({
    noResults: "Es wurde keine Zeile gefunden.",
    "query.aliasTaken": "Jede Bindung braucht einen eigenen Alias.",
  });
  // #endregion translated
}

export async function result() {
  // #region result
  const result = await repo.insert(cs);
  if (!result.success) result.error.errorMessages(); // { email: ["has already been taken"] }
  // #endregion result
}
