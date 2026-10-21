// The checked sources of the code blocks in guide/types.md. Each `#region` is included
// in the page by name; everything outside a region is the scaffolding that makes the
// regions compile.
// #region imports
import { defineType, parameterized, Schema, t } from "egon-orm";

// #endregion imports

/** A stand-in for the decimal class of a library such as decimal.js. */
class Money {
  private constructor(readonly cents: bigint) {}

  static parse(text: string): Money {
    const [whole = "0", fraction = ""] = text.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")) * (whole.startsWith("-") ? -1n : 1n);
    return new Money(cents);
  }

  eq(other: Money): boolean {
    return this.cents === other.cents;
  }

  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  }
}

function isMoneyLike(input: unknown): input is string {
  return typeof input === "string" && /^-?\d{1,15}(\.\d{1,2})?$/.test(input);
}

// #region custom-type
export const MoneyType = defineType<Money, string>({
  name: "money",
  db: { kind: "decimal" },
  cast(input) {
    return isMoneyLike(input)
      ? { success: true, data: Money.parse(input) }
      : { success: false, message: "is not a valid amount" };
  },
  fromDb: (stored) => Money.parse(stored),
  toDb: (money) => money.toString(),
  equal: (a, b) => a.eq(b),
});
// #endregion custom-type

// #region custom-type-field
export class Product extends Schema("products", {
  id: t.integer().primaryKey().dbGenerated(),
  price: t.type(MoneyType),
}) {}
// #endregion custom-type-field

// #region identity-type
/** Lower-cased text. The driver's value is already the value, so there is no `fromDb` or `toDb`. */
export const SlugType = defineType<string>({
  name: "slug",
  db: { kind: "text" },
  cast: (input) =>
    typeof input === "string" && /^[a-z0-9-]+$/i.test(input)
      ? { success: true, data: input.toLowerCase() }
      : { success: false, message: "may only contain letters, digits and dashes" },
});
// #endregion identity-type

// #region parameterized
export const currency = parameterized((options: { code: string }) =>
  defineType<Money, string>({
    name: `money(${options.code})`,
    db: { kind: "decimal" },
    cast: (input) =>
      isMoneyLike(input)
        ? { success: true, data: Money.parse(input) }
        : { success: false, message: "is not a valid {code} amount", meta: { code: options.code } },
    fromDb: (stored) => Money.parse(stored),
    toDb: (money) => money.toString(),
    equal: (a, b) => a.eq(b),
  }),
);

// Equal options give the same type object: euros === alsoEuros.
export const euros = currency({ code: "EUR" });
export const alsoEuros = currency({ code: "EUR" });
// #endregion parameterized

export class Order extends Schema("orders", {
  id: t.integer().primaryKey().dbGenerated(),
  // #region parameterized-field
  price: t.type(currency({ code: "EUR" })),
  // #endregion parameterized-field
}) {}

// #region custom-sql
/** A Postgres `citext` column: the type name is written into the SQL, so it is a constant. */
export const CaseInsensitiveText = defineType<string>({
  name: "citext",
  db: { kind: "custom", sql: "citext" },
  cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
  equal: (a, b) => a.toLowerCase() === b.toLowerCase(),
});
// #endregion custom-sql
