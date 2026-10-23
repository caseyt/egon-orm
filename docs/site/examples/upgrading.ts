// The checked sources of the code blocks in reference/upgrading.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
import { DatabaseError } from "egon-orm";

declare function openConnection(): Promise<{ close(): Promise<void> }>;

export async function connect() {
  // #region adapter-error
  try {
    return await openConnection();
  } catch (cause) {
    // Was: new DatabaseError("Could not connect to the database.", { code: "connection", cause })
    throw new DatabaseError("database.connectionFailed", "Could not connect to the database.", {
      code: "connection",
      cause,
    });
  }
  // #endregion adapter-error
}
