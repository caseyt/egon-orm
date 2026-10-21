// CommonJS consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
//
// The packages are ESM only (decision D14): there is no CommonJS build. A CommonJS project
// still loads them with a plain `require()`, because Node loads ES modules that way from
// 22.12 on (checked: 22.11.0 fails with ERR_REQUIRE_ESM, 22.12.0 works with an
// ExperimentalWarning, 22.23.1 and 24.14.1 work silently). `engines.node` is `>=22.12`
// for that reason. This script proves it on the Node that runs it.
const assert = require("node:assert/strict");
const { postgres, VERSION: postgresVersion } = require("@egon-orm/postgres");
const { VERSION: zodVersion } = require("@egon-orm/zod");
const { VERSION: sqliteVersion } = require("@egon-orm/sqlite");
const { VERSION: mysqlVersion } = require("@egon-orm/mysql");
const { VERSION: cliVersion, defineConfig } = require("@egon-orm/cli");
const { VERSION, QueryError, EgonError, createRepo, isEgonError, success } = require("egon-orm");
const { MigrationError } = require("egon-orm/migration");
const { createSandbox } = require("egon-orm/testing");

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);
assert.equal(sqliteVersion, VERSION);
assert.equal(mysqlVersion, VERSION);
assert.equal(cliVersion, VERSION);
assert.equal(typeof defineConfig, "function");

// The subpath `egon-orm/migration` loads the same way and shares the main entry's classes.
assert.ok(new MigrationError("x") instanceof EgonError);

// What was loaded is the one ES module build, not a CommonJS copy of it.
const resolved = require.resolve("egon-orm");
assert.ok(resolved.endsWith("/dist/index.js"), resolved);

// `egon-orm/testing` shares egon-orm's code: its sandbox recognises a repo that
// `require("egon-orm")` made (it refuses anything else). Nothing connects here.
const testingResolved = require.resolve("egon-orm/testing");
assert.ok(testingResolved.endsWith("/dist/testing.js"), testingResolved);
const repo = createRepo({ adapter: postgres({ connectionString: "postgres://localhost/unused" }) });

// The same module instance as an `import` gets, so classes and symbols are shared.
Promise.all([import("egon-orm"), createSandbox(repo), createSandbox({}).catch((error) => error)])
  .then(async ([esm, sandbox, refused]) => {
    assert.equal(esm.QueryError, QueryError);
    const error = new QueryError("x");
    assert.ok(error instanceof esm.EgonError);
    assert.ok(isEgonError(error, "query"));
    assert.deepEqual(success(1), { success: true, data: 1 });
    assert.equal(typeof sandbox.begin, "function");
    assert.ok(refused instanceof TypeError, String(refused));
    await repo.close();
    console.log(
      `cjs: require("egon-orm") loaded the ES module ${VERSION} on Node ${process.version} (${resolved}); require("egon-orm/testing") shares it (${testingResolved})`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
