// The migration name rule, the version and the template of `egon migrate create`.
import { describe, expect, test } from "vitest";
import { MIGRATION_NAME, migrationTemplate, versionAt } from "./create.js";

describe("versions and the template", () => {
  test("the version is the UTC time as YYYYMMDDHHMMSS", () => {
    expect(versionAt(new Date("2026-10-12T09:30:05Z"))).toBe("20261012093005");
    expect(versionAt(new Date("2027-01-02T03:04:05.999+05:00"))).toBe("20270101220405");
  });

  test("names are lower-case letters, digits and underscores", () => {
    expect(MIGRATION_NAME.test("create_users_2")).toBe(true);
    for (const bad of ["CreateUsers", "create-users", "create users", ""])
      expect(MIGRATION_NAME.test(bad)).toBe(false);
  });

  test("the empty template has an up and a down to fill in", () => {
    expect(migrationTemplate()).toMatchInlineSnapshot(`
      "import { defineMigration } from "egon-orm/migration";

      export const migration = defineMigration({
        up(m) {
          // the change
        },
        down() {
          // undo the change (write down(m) to use m), or leave a // noop comment
        },
      });
      "
    `);
  });
});
