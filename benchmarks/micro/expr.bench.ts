// Micro-benchmarks for packages/core/src/query (step 07): what building an expression
// costs. Step target: `a.gte(1).and(b.eq("x"))` < 250 ns. Expressions are part of the
// README §7 budget for building a 3-clause query (< 1.5 µs), which step 08 measures.
//
// Columns are made by the query builder (step 08), and no public function makes one, so
// this file loads the expression classes and functions from the package's built
// `dist/internal.js` (see internal.bench.ts). Everything that touches an expression comes
// from there: the classes of dist/internal.js are not those of dist/index.js. The schema
// and the field types come from the public entry point; they are plain data to the
// expressions.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { meta, Schema, t } from "egon-orm";
import { bench, doNotOptimize, group, resolveBuiltEgon, runBenchmarks } from "../src/harness.js";

type Internal = typeof import("../../packages/core/src/internal/index.js");

const builtInternal = join(dirname(resolveBuiltEgon()), "internal", "index.js");
if (!existsSync(builtInternal)) {
  throw new Error(`${builtInternal} does not exist. Run \`pnpm build\` first.`);
}
const { expr, expressions } = (await import(pathToFileURL(builtInternal).href)) as Internal;
const { Col } = expr;
const { and, caseWhen, coalesce, count, fragment, param, sum } = expressions;

class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  views: t.integer().default(0),
  published: t.boolean().default(false),
  settings: t.json<{ theme: string }>().nullable(),
}) {}

function column<T>(name: string) {
  const field = meta(Account).fieldsByName.get(name);
  if (field === undefined) throw new Error(`no field ${name}`);
  return new Col<T>("a", field);
}

const age = column<number | null>("age");
const email = column<string>("email");
const name = column<string | null>("name");
const role = column<"admin" | "member">("role");
const views = column<number>("views");
const published = column<boolean>("published");
const settings = column<{ theme: string } | null>("settings");

// A changing value, so that the JIT cannot fold a build into a constant.
let counter = 0;

group("query/expr: operators", () => {
  bench('a.gte(1).and(b.eq("x")) (target < 250 ns)', () =>
    doNotOptimize(age.gte(counter++ & 63).and(email.eq("x"))),
  );
  bench("a.eq(1): one comparison", () => doNotOptimize(age.eq(counter++ & 63)));
  bench("a.gte(1).and(b).and(c): a flat and of three", () =>
    doNotOptimize(
      age
        .gte(counter++ & 63)
        .and(published)
        .and(name.isNull()),
    ),
  );
  bench('and(a.gte(1), b.eq("x"), c): the free function', () =>
    doNotOptimize(and(age.gte(counter++ & 63), email.eq("x"), published)),
  );
  bench('role.in(["admin", "member"]): a list of two', () => doNotOptimize(role.in(["admin", "member"])));
  bench("age.between(18, 65)", () => doNotOptimize(age.between(18, counter++ & 63)));
  bench('name.ilike("%ann%")', () => doNotOptimize(name.ilike("%ann%")));
  bench("views.add(1).gt(10): arithmetic and a comparison", () =>
    doNotOptimize(views.add(1).gt(counter++ & 63)),
  );
  bench("age.gte(param(...)): a named parameter", () => doNotOptimize(age.gte(param("minAge", t.integer()))));
  bench('settings.pathText("theme").eq("dark")', () => doNotOptimize(settings.pathText("theme").eq("dark")));
  bench("createdAt.desc().nullsLast()", () => doNotOptimize(age.desc().nullsLast()));
});

group("query/expr: functions", () => {
  bench("fragment with three interpolations", () =>
    doNotOptimize(fragment`similarity(${name}, ${"ann"}) > ${counter++ & 63}`),
  );
  bench("fragment with no interpolation", () => doNotOptimize(fragment`now()`));
  bench("count()", () => doNotOptimize(count()));
  bench("sum(views).filter(published)", () => doNotOptimize(sum(views).filter(published)));
  bench('coalesce(name, "anonymous")', () => doNotOptimize(coalesce(name, "anonymous")));
  bench('caseWhen(age.lt(18), "minor").else("adult")', () =>
    doNotOptimize(caseWhen(age.lt(counter++ & 63), "minor").else("adult")),
  );
});

await runBenchmarks();
