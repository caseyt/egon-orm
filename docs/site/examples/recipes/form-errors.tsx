// The checked source of recipes/form-errors.md: a sign-up form in React 19 whose server
// action returns the changeset's errors. Type-checked; it is not run.
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, type ErrorTree, Schema, t } from "egon-orm";
import { useActionState } from "react";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"])
      .validateRequired(["email", "name"])
      .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
      .uniqueConstraint("email");
  }
}

// #region action
// actions.ts: runs on the server ("use server" in Next.js). The state is plain data, so it
// crosses from server to client as it is.
export type SignUpState = {
  values: Record<string, string>;
  errors: ErrorTree<string>;
  saved: boolean;
};

export async function signUp(_previous: SignUpState, form: FormData): Promise<SignUpState> {
  const values = { email: String(form.get("email") ?? ""), name: String(form.get("name") ?? "") };
  const result = await repo.insert(User.changeset(User, values));
  return result.success
    ? { values: {}, errors: {}, saved: true }
    : { values, errors: result.error.errorMessages(), saved: false }; // { email: ["has already been taken"] }
}
// #endregion action

// #region form
// SignUpForm.tsx: a client component.
const initial: SignUpState = { values: {}, errors: {}, saved: false };

export function SignUpForm() {
  const [state, action, pending] = useActionState(signUp, initial);
  if (state.saved) return <p>Welcome!</p>;

  return (
    <form action={action} noValidate>
      <Field name="email" label="Email" state={state} />
      <Field name="name" label="Name" state={state} />
      <button type="submit" disabled={pending}>
        Sign up
      </button>
    </form>
  );
}

// The messages of one field. (A nested form, with castAssoc, has a tree under its key instead.)
function messagesOf(errors: ErrorTree<string>, field: string): readonly string[] {
  const entry = errors[field];
  return Array.isArray(entry) ? entry.filter((e): e is string => typeof e === "string") : [];
}

function Field({ name, label, state }: { name: string; label: string; state: SignUpState }) {
  const errors = messagesOf(state.errors, name);
  const errorId = `${name}-errors`;
  return (
    <p>
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        defaultValue={state.values[name] ?? ""}
        aria-invalid={errors.length > 0}
        aria-describedby={errors.length > 0 ? errorId : undefined}
      />
      {errors.length > 0 && (
        <span id={errorId} role="alert">
          {label} {errors.join(", ")}
        </span>
      )}
    </p>
  );
}
// #endregion form
