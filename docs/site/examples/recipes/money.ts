// @run
// The checked source of recipes/money.md. Each `#region` is included in the page by name;
// the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, defineType, from, Schema, sum, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

// The tables, created by a migration.
const tables = defineMigration({
  up(m) {
    m.createTable("products", (table) => {
      table.id({ type: "integer" });
      table.text("name").notNull();
      table.decimal("price", { precision: 12, scale: 2 }).notNull();
    });
  },
  down(m) {
    m.dropTable("products");
  },
});

/** Creates the tables, in the database that DATABASE_URL names. */
export async function createTables(): Promise<void> {
  const admin = postgres({ connectionString: process.env.DATABASE_URL });
  await createMigrator({
    adapter: admin,
    migrations: [{ version: 1, name: "tables", migration: tables }],
  }).up();
  await admin.close();
}
// #endregion setup

// #region type
const AMOUNT = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/;

/** "19.99" -> 1999, read digit by digit so that no floating-point error creeps in. */
function toCents(text: string): number | undefined {
  const match = AMOUNT.exec(text.trim());
  if (match === null) return undefined;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

/** An amount of money as a whole number of cents, stored in a numeric(12, 2) column. */
export const Cents = defineType<number, string>({
  name: "cents",
  db: { kind: "decimal" },
  cast(input) {
    const cents = typeof input === "string" || typeof input === "number" ? toCents(String(input)) : undefined;
    return cents === undefined
      ? { success: false, message: "is not an amount" }
      : { success: true, data: cents };
  },
  fromDb: (stored) => toCents(stored) ?? Number.NaN, // "19.99" -> 1999
  toDb: (cents) =>
    `${cents < 0 ? "-" : ""}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`,
});
// #endregion type

// #region schema
class Product extends Schema("products", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  price: t.type(Cents),
}) {
  static changeset(product: Product | typeof Product, params: unknown) {
    return cast(product, params, ["name", "price"]).validateRequired(["name", "price"]);
  }

  get displayPrice(): string {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(this.price / 100);
  }
}
// #endregion schema

export async function run(): Promise<void> {
  await createTables();

  // #region use
  const pen = await repo.insertOrThrow(Product.changeset(Product, { name: "Pen", price: "19.99" }));
  pen.price; // => 1999
  pen.displayPrice; // => "$19.99"

  Product.changeset(Product, { name: "Pen", price: "19.999" }).errorMessages(); // => { price: ["is not an amount"] }
  // #endregion use

  await repo.insertOrThrow(Product.changeset(Product, { name: "Ink", price: 5.01 }));
  // #region total
  const total = await repo.one(from(Product, "p").select(({ p }) => sum(p.price))); // summed by the database
  // #endregion total
  total === 2500; // => true

  await repo.close();
}
