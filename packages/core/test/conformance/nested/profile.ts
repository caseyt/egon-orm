// What a dialect package tells the nested-write conformance suite about its database: how
// to make the adapter under test, and the DDL of the suite's own tables. Everything the
// suite checks is behaviour of nested changesets, embeds and the repo's nested writes.
import type { DatabaseAdapter } from "egon-orm";
import type { TestDatabase } from "../../support/index.js";

export interface NestedConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** Creates the adapter under test, connected to `db`. */
  readonly makeAdapter: (db: TestDatabase, options: { readonly poolMax: number }) => DatabaseAdapter;
  /**
   * DDL (`;`-separated) for the suite's own tables, besides the blog fixture:
   *
   * - `orders (id <generated key>, customer text not null)`;
   * - `line_items (id <generated key>, order_id bigint not null` referencing `orders`
   *   `on delete cascade, sku text not null, qty integer not null)` with the check
   *   constraint `line_items_qty_check` (`qty > 0`), and a trigger that makes an insert of
   *   a row whose `sku` is `'slow'` take 0.3 seconds;
   * - `contacts (id <generated key>, name text not null, address <json>, phones <json>
   *   not null default '[]', card <json>)`.
   */
  readonly schema: string;
}
