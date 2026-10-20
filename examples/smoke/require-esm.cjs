// CommonJS consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
//
// The packages are ESM only (decision D14): there is no CommonJS build. A CommonJS project
// still loads them with a plain `require()`, because Node loads ES modules that way from
// 22.12 on (checked: 22.11.0 fails with ERR_REQUIRE_ESM, 22.12.0 works with an
// ExperimentalWarning, 22.23.1 and 24.14.1 work silently). `engines.node` is `>=22.12`
// for that reason. This script proves it on the Node that runs it.
const assert = require("node:assert/strict");
const { VERSION: postgresVersion } = require("@egon-orm/postgres");
const { VERSION: zodVersion } = require("@egon-orm/zod");
const { VERSION, QueryError, EgonError, isEgonError, success } = require("egon-orm");
const { MigrationError } = require("egon-orm/migration");

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);

// The subpath `egon-orm/migration` loads the same way and shares the main entry's classes.
assert.ok(new MigrationError("x") instanceof EgonError);

// What was loaded is the one ES module build, not a CommonJS copy of it.
const resolved = require.resolve("egon-orm");
assert.ok(resolved.endsWith("/dist/index.js"), resolved);

// The same module instance as an `import` gets, so classes and symbols are shared.
import("egon-orm").then((esm) => {
  assert.equal(esm.QueryError, QueryError);
  const error = new QueryError("x");
  assert.ok(error instanceof esm.EgonError);
  assert.ok(isEgonError(error, "query"));
  assert.deepEqual(success(1), { success: true, data: 1 });
  console.log(
    `cjs: require("egon-orm") loaded the ES module ${VERSION} on Node ${process.version} (${resolved})`,
  );
});
