// @run
// The checked source of recipes/multi-tenancy.md. Each `#region` is included in the page by
// name; the rest makes it compile and run (docs:integration checks the `// =>` comments).
// #region setup
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, from, type Repo, Schema, t } from "egon-orm";
import { createMigrator, defineMigration } from "egon-orm/migration";

class Project extends Schema("projects", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
}) {
  static changeset(project: Project | typeof Project, params: unknown) {
    return cast(project, params, ["name"]).validateRequired(["name"]).uniqueConstraint("name");
  }
}

const adapter = postgres({ connectionString: process.env.DATABASE_URL });
// #endregion setup

// #region migration
// The tables of one tenant, created in that tenant's database schema.
const tenantTables = (schema: string) =>
  defineMigration({
    up(m) {
      m.createSchema(schema, { ifNotExists: true });
      m.createTable(
        "projects",
        (table) => {
          table.id("id", { type: "integer" });
          table.text("name").notNull().unique();
        },
        { schema },
      );
    },
    down(m) {
      m.dropTable("projects", { schema });
      m.dropSchema(schema);
    },
  });

// `tenant` is one of your own identifiers (a slug), never raw user input.
export async function provision(tenant: string) {
  const schema = `tenant_${tenant}`;
  await createMigrator({
    adapter,
    table: `${schema}_migrations`, // a history per tenant, beside the tables it creates
    migrations: [{ version: 20261020090000, name: "tenant_tables", migration: tenantTables(schema) }],
  }).up();
}
// #endregion migration

// #region per-call
const repo = createRepo({ adapter });

export function projectsOf(tenant: string) {
  return repo.all(
    from(Project, "p").orderBy(({ p }) => p.name),
    { schema: `tenant_${tenant}` },
  );
}

export function addProject(tenant: string, params: unknown) {
  return repo.insert(Project.changeset(Project, params), { schema: `tenant_${tenant}` });
}
// #endregion per-call

// #region per-tenant-repo
// One repo per tenant, sharing the adapter (and its pool): every call defaults to the schema.
const tenantRepos = new Map<string, Repo>();

export function repoFor(tenant: string): Repo {
  let tenantRepo = tenantRepos.get(tenant);
  if (tenantRepo === undefined) {
    tenantRepo = createRepo({ adapter, schema: `tenant_${tenant}` });
    tenantRepos.set(tenant, tenantRepo);
  }
  return tenantRepo;
}
// #endregion per-tenant-repo

export async function run(): Promise<void> {
  await provision("acme");
  await provision("globex");

  (await addProject("acme", { name: "Rocket" })).success; // => true
  (await addProject("globex", { name: "Rocket" })).success; // => true
  const twice = await addProject("acme", { name: "Rocket" });
  twice.success ? null : twice.error.errorMessages(); // => { name: ["has already been taken"] }

  // #region use
  await repoFor("acme").insertOrThrow(Project.changeset(Project, { name: "Anvil" }));
  const acme = await repoFor("acme").all(from(Project, "p").orderBy(({ p }) => p.name));
  // #endregion use
  acme.map((p) => p.name); // => ["Anvil", "Rocket"]
  (await projectsOf("globex")).map((p) => p.name); // => ["Rocket"]

  await adapter.close();
}
