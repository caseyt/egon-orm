// #region registration
// src/accounts.ts: signing up
import { randomBytes, scryptSync } from "node:crypto";
import { type Changeset, cast } from "egon-orm";
import { z } from "zod";
import { repo } from "./db.js";
import { User } from "./schemas.js";

// The rules for the values that are there. Whether they are there is validateRequired's job,
// so the schema is partial: a missing name gets one message, "can't be blank", not two.
const Registration = z
  .object({
    email: z.email(),
    name: z.string().trim().max(80),
    password: z.string().min(12),
  })
  .partial();

export function registrationChangeset(params: unknown) {
  return cast(User, params, ["email", "name", "password"])
    .validateRequired(["email", "name", "password"]) // "", null, blank or missing: can't be blank
    .validate(Registration) // every issue becomes an error on its field
    .uniqueConstraint("email") // a duplicate email becomes { email: ["has already been taken"] }
    .pipe(hashPassword);
}

// A step of the changeset: hash the password once the input is known to be valid.
function hashPassword(cs: Changeset<typeof User, true>) {
  const password = cs.getChange("password");
  if (!cs.valid || password === undefined) return cs;
  const salt = randomBytes(16).toString("hex");
  return cs.putChange("passwordHash", `${salt}:${scryptSync(password, salt, 32).toString("hex")}`);
}
// #endregion registration

// #region register
export async function register(params: unknown) {
  const result = await repo.insert(registrationChangeset(params));
  if (!result.success) return { errors: result.error.errorMessages() };
  return { user: result.data };
}
// #endregion register
