// The checked source of the example in packages/zod/README.md.
// scripts/check-release-config.mjs checks that the README's copy is this region.
// #region example
import { castWith, toZod } from "@egon-orm/zod";
import { Schema, t } from "egon-orm";
import { z } from "zod";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {}

// A Zod schema derived from the Egon schema, with one rule added.
const SignUp = toZod(User, { mode: "insert", pick: ["email", "name"] }).extend({
  email: z.string().email(),
});
type SignUp = z.infer<typeof SignUp>; // { email: string; name?: string | null }

// Cast the picked fields and validate them with SignUp, in one call.
const cs = castWith(User, { email: "not an email" }, SignUp);
cs.valid; // false

// #endregion example

export type { SignUp };
export { cs };
