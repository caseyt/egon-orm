# Step 21 (changeset gaps): every logic survivor of the changeset area, status

Branch `step/21-changeset-gaps`, 2026-10-24, rebased on `main` at `1f83d77` (#73,
robustness). Owner decision 4 of 2026-10-23: the changeset survivors are a `0.1.0` gate,
closed with tests only; a real bug would stop the work and be reported first. Input: the
changeset run of `status/21-robustness.md` §4 (83.14%, `7bda82b`), its 530 logic survivors.

## Summary

| Item | Result |
|---|---|
| Logic survivors of the base run, each looked at | **530 of 530**: 165 now tested, 164 equivalent, 201 low value |
| Real gaps closed | **166** (165 of the 530, and one the final run showed), each with a test checked against its hand-applied mutant |
| Production bugs found | **None**. Every gap was a missing test |
| Changeset area, Stryker after the tests | **87.21%** (from 83.14%), on `c655c31` |
| Files changed | Four test files only; no source change |

Tests added (all unit tests, no database):

- `packages/core/src/changeset/gaps.test.ts` (36 tests): `changeset.ts`, `nested/embed.ts`,
  `spec.ts`, `nested/build.ts`.
- `packages/core/src/changeset/nested/gaps.test.ts` (27 tests): `nested/change.ts`,
  `nested/relation.ts`.
- `packages/core/src/changeset/validators/gaps.test.ts` (15 tests): `validators/validate.ts`,
  `validators/generated.ts`.
- `packages/core/src/changeset/validators/codegen-late.test.ts` (9 cases): a runtime that
  refuses `new Function` after N constructions still validates with the loops.

## Method

1. The base run is the changeset run of the robustness step: `7bda82b`, 4,077 mutants,
   3,358 killed, 29 timeouts, 662 survived, 25 without coverage, 3 runtime errors, 83.14%.
   Its 687 survivors split, by `scripts/mutation-sample.mjs`, into 81 error ids (rejected by
   tsc, verified by sample in `status/21-robustness.md`), 76 error-message texts (low value,
   as there) and **530 logic survivors**. This step is about the 530.
2. Each logic survivor was read against the source, file by file: `changeset.ts`,
   `nested/change.ts`, then `nested/relation.ts`, `validators/validate.ts`,
   `nested/embed.ts`, `spec.ts`, `measure.ts`, `nested/build.ts`, `validators/generated.ts`.
3. Each was put in one class:
   - **tested**: a real gap. A test was written and run against the mutant applied by hand
     (one replacement in the source, the test file run, the source put back); the test fails
     with the mutant and passes without it.
   - **equivalent**: the mutant cannot change behaviour in a state the API can reach (a
     check that another check already makes, a shortcut to the same result, a value that
     cannot occur there). The reason is given per mutant.
   - **low value**: only a message, a function name in a message, an advice parameter, or
     a state the types forbid.
   - **tool artifact (verified by hand)**: a mutant the test suite kills but Stryker reports
     as survived. None of the 530 broke a test file at load time; one is a coverage
     artifact (below). It is counted under tested, since the test that kills it exists.
4. When a hand-applied mutant and Stryker disagreed, the hand result decided, and the
   mutant was applied again with care: the harness replaces the first occurrence of a text,
   and two blocks in `validate.ts` and `changeset.ts` exist twice, so those were mutated by
   hand at the right place.
5. Stryker was re-run on the whole changeset area at the end, and its survivors were
   matched with the ledger.

Mutant ids in the ledger are those of the base run. Ids change when the sources or tests
change, so the runs were compared by content: file, mutator, original text, replacement and
the order of equal keys (4,075 of 4,082 mutants matched; the 7 unmatched were all killed).

## Results

| File | Logic survivors | Tested now | Equivalent | Low value |
|---|---|---|---|---|
| `changeset.ts` | 149 | 37 | 31 | 81 |
| `nested/change.ts` | 117 | 50 | 30 | 37 |
| `nested/relation.ts` | 97 | 17 | 30 | 50 |
| `validators/validate.ts` | 93 | 33 | 39 | 21 |
| `nested/embed.ts` | 33 | 22 | 11 | 0 |
| `spec.ts` | 20 | 3 | 7 | 10 |
| `measure.ts` | 12 | 0 | 12 | 0 |
| `nested/build.ts` | 6 | 2 | 2 | 2 |
| `validators/generated.ts` | 3 | 1 | 2 | 0 |
| **all** | **530** | **165** | **164** | **201** |

Plus one gap outside the 530 (`nested/relation.ts`, below), so 166 tested in all. Two
mutants classed equivalent were killed by the final run anyway (a test written for another
mutant reaches them), so the final run has 162 equivalent survivors; they stay classed as
equivalent in the ledger. The full ledger, one row per mutant, is in the appendix.

What the real gaps were, in short (the ledger names the test for each):

- `changeset.ts`: `merge` of actions and constraint errors, `optimisticLock`, null skipped
  by every validator, `validateSubset` compared by value, `validations()` exactly,
  `getField`/`fetchField` on built rows, composite constraint names, `applyChanges` with
  and without a schema class, `change()` refusing an embed, schemaless merges, `buildAssoc`.
- `nested/change.ts` and `nested/relation.ts`: parent validity from children, `required`,
  stored rows put back, duplicates in a cast, to-one `onReplace` paths, `putAssoc(null)`,
  key casting of to-one embeds, keyless list comparison (null, dates, lists, defaults given
  by a function), `leaves()` per relation kind, `indexOfRow`, `NotLoadedError` fields,
  `keyFinder` with a key two rows share.
- `validators/validate.ts`: routing of issues to children (leaving children, embedded
  lists, positions as text), `only`, `apply` over nulls, dates, undefined and a field with
  no value yet, a Standard Schema result with `issues: []`, a rejected promise from
  `validateField`.
- `nested/embed.ts`: `missingEmbedded` and `embedChanges` in full, virtual fields of
  embedded rows.
- `validators/generated.ts`: a runtime that refuses code generation late, and the builders
  of a schema class made once and kept.

## The final Stryker run

`pnpm test:mutation changeset`, started 00:48:25 on `c655c31` (committed 00:48:13, clean
tree), concurrency 2, `ignoreStatic: false`, 34 min. Free disk stayed at 57-58 GB;
`.stryker-tmp` 19 MB, `reports/` 62 MB.

| Run | Mutants | Killed | Timeout | Survived | No coverage | Runtime error | Score |
|---|---|---|---|---|---|---|---|
| base (`7bda82b`) | 4,077 | 3,358 | 29 | 662 | 25 | 3 | 83.14% |
| final (`c655c31`) | 4,082 | 3,527 | 32 | 511 | 11 | 1 | **87.21%** |

Per file, base to final: `changeset.ts` 85.96% to 88.38%, `nested/change.ts` 79.19% to
86.03%, `nested/relation.ts` 69.21% to 73.42%, `validators/validate.ts` 86.51% to 90.86%,
`nested/embed.ts` 83.16% to 94.39%, `spec.ts` 84.85% to 86.43%, `nested/build.ts` 82.43%
to 85.14%, `validators/generated.ts` 88.46% to 92.31%, `measure.ts` 88.12% (unchanged: its
12 survivors are all equivalent). `nested/relation.ts` stays low because most of its
survivors are error messages and their advice parameters (low value).

The final run's 522 survivors: 81 error ids, 76 error messages, 365 logic. The 365 logic
survivors are 162 equivalent, 201 low value, and two more:

- **`nested/change.ts:632`, `false` → `true` (the `required` argument of `putAssoc(null)`):
  tool artifact (verified by hand).** The test "putAssoc(null) on an optional relation is
  no error" (`nested/gaps.test.ts`) kills it when applied by hand (2 tests fail), but
  Stryker's per-test coverage did not list that test for the mutant, so it never ran it.
  Not patched: no second runner patch (owner, 2026-10-23).
- **`nested/relation.ts:310`, `!level.has(value)` → `true`** (the last of two rows with one
  key would win in `keyFinder`'s index). Killed in the base run, survived in the final one:
  the only test that reached it was a fast-check property in
  `test/security/hostile-params.test.ts` without a fixed seed, which draws a shared key only
  sometimes. A fixed test was added after the run (`a7ed0dd`, "keyFinder over many rows")
  and checked against the hand-applied mutant (fails with it). The score above is of
  `c655c31`, without that test; it was not re-run for one mutant.

A first re-run on `f8a70ba` (87.11%; its report was overwritten by the final run) showed eight more mutants the ledger had wrong or
that the merge of `main` had changed; each was applied by hand again:

- `validate.ts:539`, three mutants of `staying()`: my tests did not kill them. Reclassified
  **equivalent**: every item of a nested list in the changes is a changeset of a relation
  (`change()` and `putChange` refuse relation fields, cast and put make every item a
  changeset), so the two conditions before `leaves()` never decide the result.
- `validate.ts:630`, `a === undefined` → `false` in `apply`'s `same()`: not killed by the
  test I had named. A real gap: a non-nullable field without a default of a new record has
  no value yet, and a date type then compared `undefined`. **Tested** in `c655c31`.
- `validate.ts:630`, `b === undefined` → `false`: **low value**. Output values of
  `undefined` are skipped before `same()`; only a custom type whose cast succeeds with
  `undefined` reaches it.
- `generated.ts:71-74`, four static mutants that make `generatedBuilders` never generate
  (or never cache). Killed in the base run by the old test that a schemaless changeset
  generates code; owner decision F5 (#72) reversed that, and the new test counts
  `new Function` calls that schema definition also makes, so it no longer sees them.
  **Tested** in `c655c31` ("generated builders": defined, the same object twice, the right
  values).

## Checks

- `pnpm check` (lint, typecheck, unit with coverage, type tests, build) passed on
  `f8a70ba`, and again on `a7ed0dd` (unit: 158 files, 6,552 tests; type tests: 35 files,
  608 tests).
- `pnpm typecheck` and Biome passed on each changed test file.
- No integration test was run: this step changes unit tests only.

## Checks I changed, exempted or worked around

None. No configuration changed, no Stryker patch, no TypeScript checker for Stryker.

## Gaps and unverified claims

- The equivalent and low-value classes are my reading of the source; each has its reason
  in the ledger, but they were not each proven by a test.
- The score of the final commit (`a7ed0dd`) was not measured; it differs from `c655c31` by
  one test, checked by hand against its one mutant.
- `nested/relation.ts:310` shows that a fast-check property without a fixed seed can kill a
  mutant in one run and not the next. Other mutants killed only by such properties may
  pass or fail between runs; I did not look for them.

## Requests

- None for other steps.

## Appendix: the ledger

One row per logic survivor of the base run (`7bda82b`), by file and line. Ids are those of
that run. "Tested now" rows name the test that kills the mutant.

### `changeset.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 30 | 200 | ConditionalExpression: `spec.model === null` → `true` | equivalent | schema rows hold every field as an own property; only schemaless data can lack one |
| 49 | 207 | ConditionalExpression: `b === null` → `false` | tested | null over a stored date on a nullable column (gaps.test.ts) |
| 51 | 207 | ConditionalExpression: `b === undefined` → `false` | low value | new value undefined reaches same() only through changed({ to: undefined }) |
| 64 | 213 | ConditionalExpression: `typeof value !== "string"` → `false` | tested | validateRequired: an empty list is not blank (gaps.test.ts) |
| 92 | 231 | ConditionalExpression: `validation === undefined` → `false` | low value | an own validation: undefined key on the error; invisible to equality and JSON |
| 100 | 236 | ConditionalExpression: `a === b` → `false` | equivalent | identity shortcut; the field comparison gives the same answer |
| 112 | 239 | ConditionalExpression: `a.constraint === b.constraint` → `true` | tested | merge keeps errors that differ only in constraint (gaps.test.ts) |
| 134 | 263 | ConditionalExpression: `existing !== undefined && list.length === exi` → `false` | equivalent | returns an equal new object instead of the same one |
| 147 | 268 | ConditionalExpression: `typeof key !== "string"` → `false` | low value | a non-string error key (misuse) is accepted instead of refused |
| 199 | 505 | BooleanLiteral: `false` → `true` | equivalent | #check appends only when the key has no error yet, so dedupe cannot change the list |
| 203 | 535 | StringLiteral (static): `"putChange"` → `""` | low value | function name in an error message |
| 207 | 549 | StringLiteral: `"forceChange"` → `""` | low value | function name in an error message |
| 209 | 549 | StringLiteral: `"forceChange"` → `""` | low value | function name in an error message |
| 249 | 586 | StringLiteral: `"deleteChange"` → `""` | low value | function name in an error message |
| 251 | 603 | StringLiteral: `"updateChange"` → `""` | low value | function name in an error message |
| 256 | 606 | StringLiteral: `"updateChange"` → `""` | low value | function name in an error message |
| 281 | 631 | ConditionalExpression: `this.action !== null` → `true` | tested | merge takes the other side's action when this one has none (gaps.test.ts) |
| 285 | 631 | ConditionalExpression: `this.action !== other.action` → `true` | tested | merge of two changesets with the same action (gaps.test.ts) |
| 306 | 698 | StringLiteral: `"getField"` → `""` | low value | function name in an error message |
| 307 | 702 | StringLiteral: `"built"` → `""` | tested | getField gives an embed change as a built row (gaps.test.ts) |
| 313 | 721 | StringLiteral: `"getChange"` → `""` | low value | function name in an error message |
| 315 | 741 | StringLiteral: `"fetchField"` → `""` | low value | function name in an error message |
| 319 | 744 | StringLiteral: `"built"` → `""` | tested | fetchField gives an embed change as a built row (gaps.test.ts) |
| 329 | 764 | StringLiteral: `"fetchChange"` → `""` | low value | function name in an error message |
| 332 | 786 | StringLiteral: `"isChanged"` → `""` | low value | function name in an error message |
| 372 | 859 | StringLiteral: `"validateRequired"` → `""` | low value | function name in an error message |
| 379 | 863 | ConditionalExpression: `typeof names === "string"` → `false` | tested | validateRequired with one name as a string adds one error (gaps.test.ts) |
| 381 | 863 | StringLiteral: `"string"` → `""` | tested | validateRequired with one name as a string adds one error (gaps.test.ts) |
| 391 | 866 | StringLiteral: `"validateRequired"` → `""` | low value | function name in an error message |
| 408 | 880 | ConditionalExpression: `hasOwn(nextChanges, name)` → `true` | equivalent | without() of a key that is not there copies the same changes |
| 411 | 881 | BooleanLiteral: `false` → `true` | low value | dedupes only a name listed twice in one validateRequired call |
| 416 | 897 | StringLiteral: `"validateFormat"` → `""` | low value | function name in an error message |
| 432 | 904 | ConditionalExpression: `value !== null` → `true` | tested | validateFormat skips null (gaps.test.ts) |
| 439 | 905 | StringLiteral: `"validateFormat"` → `""` | low value | function name in an error message |
| 460 | 959 | ConditionalExpression: `validation === "inclusion"` → `true` | low value | chooses the function name used in error messages |
| 461 | 959 | ConditionalExpression: `validation === "inclusion"` → `false` | low value | chooses the function name used in error messages |
| 462 | 959 | EqualityOperator: `validation === "inclusion"` → `validation !== "inclusion"` | low value | chooses the function name used in error messages |
| 463 | 959 | StringLiteral: `"inclusion"` → `""` | low value | chooses the function name used in error messages |
| 464 | 959 | StringLiteral: `"validateInclusion"` → `""` | low value | function name in an error message |
| 465 | 959 | StringLiteral: `"validateExclusion"` → `""` | low value | function name in an error message |
| 472 | 962 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 473 | 963 | ObjectLiteral: `{ fn }` → `{}` | low value | advice parameters of an error |
| 483 | 968 | ConditionalExpression: `value !== null` → `true` | tested | validateInclusion and validateExclusion skip null (gaps.test.ts) |
| 493 | 991 | StringLiteral: `"validateSubset"` → `""` | low value | function name in an error message |
| 508 | 997 | ConditionalExpression: `value !== null` → `true` | tested | validateSubset skips null (gaps.test.ts) |
| 514 | 998 | StringLiteral: `"validateSubset"` → `""` | low value | function name in an error message |
| 524 | 1000 | LogicalOperator: `allowed === element \|\| deepEqual(allowed, e` → `allowed === element && deepEqual(al` | tested | validateSubset compares object elements by value (gaps.test.ts) |
| 525 | 1000 | ConditionalExpression: `allowed === element` → `false` | equivalent | identity shortcut; deepEqual gives the same answer |
| 532 | 1007 | StringLiteral: `"subset"` → `""` | tested | validations() names the subset entry and its values (gaps.test.ts) |
| 533 | 1007 | StringLiteral: `"values"` → `""` | tested | validations() names the subset entry and its values (gaps.test.ts) |
| 536 | 1029 | StringLiteral: `"validateLength"` → `""` | low value | function name in an error message |
| 540 | 1030 | ConditionalExpression: `typeof options !== "object"` → `false` | low value | options that are not an object are refused anyway, by the no-limit check |
| 564 | 1037 | CallExpression: `checkLimit(is);` → `;` | tested | validateLength checks is (gaps.test.ts) |
| 588 | 1047 | StringLiteral: `"validateLength"` → `""` | low value | function name in an error message |
| 621 | 1065 | StringLiteral: `"validateLength"` → `""` | low value | function name in an error message |
| 634 | 1070 | ConditionalExpression: `min !== undefined` → `true` | equivalent | length < undefined is false |
| 643 | 1072 | ConditionalExpression: `max !== undefined` → `true` | equivalent | length > undefined is false |
| 666 | 1097 | StringLiteral: `"validateNumber"` → `""` | low value | function name in an error message |
| 668 | 1098 | ConditionalExpression: `typeof options !== "object" \|\| options === ` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 669 | 1098 | LogicalOperator: `typeof options !== "object" \|\| options === ` → `typeof options !== "object" && opti` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 670 | 1098 | ConditionalExpression: `typeof options !== "object"` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 673 | 1098 | ConditionalExpression: `options === null` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 675 | 1098 | BlockStatement: `(several lines)` → `{}` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 687 | 1105 | UpdateOperator: `limits++` → `limits--` | equivalent | the count is only compared with zero; a negative count is not zero either |
| 725 | 1123 | ConditionalExpression: `value !== null` → `true` | tested | validateNumber skips null (gaps.test.ts) |
| 738 | 1125 | StringLiteral: `"validateNumber"` → `""` | low value | function name in an error message |
| 757 | 1162 | StringLiteral: `"validateConfirmation"` → `""` | low value | function name in an error message |
| 760 | 1163 | StringLiteral: `"validateConfirmation"` → `""` | low value | function name in an error message |
| 767 | 1168 | ConditionalExpression: `params !== null` → `true` | tested | validateConfirmation on a changeset without params (gaps.test.ts) |
| 796 | 1199 | StringLiteral: `"validateAcceptance"` → `""` | low value | function name in an error message |
| 799 | 1200 | StringLiteral: `"validateAcceptance"` → `""` | low value | function name in an error message |
| 821 | 1231 | StringLiteral: `"validateChange"` → `""` | low value | function name in an error message |
| 844 | 1241 | StringLiteral: `"change"` → `""` | tested | validations() records a passing validateChange (gaps.test.ts) |
| 845 | 1245 | StringLiteral: `"change"` → `""` | tested | validations() records a failing validateChange (gaps.test.ts) |
| 846 | 1248 | BooleanLiteral: `false` → `true` | low value | dedupes only two identical issues returned by one validator call |
| 847 | 1249 | BooleanLiteral: `false` → `true` | tested | a failing validateChange makes the changeset invalid (gaps.test.ts) |
| 858 | 1453 | StringLiteral: `"addError"` → `""` | low value | function name in an error message |
| 868 | 1456 | ConditionalExpression: `meta === undefined` → `false` | equivalent | a copy of undefined meta is an empty object, as EMPTY is |
| 889 | 1508 | StringLiteral: `"uniqueConstraint"` → `""` | low value | function name in an error message |
| 896 | 1515 | StringLiteral: `"uniqueConstraint"` → `""` | low value | function name in an error message |
| 898 | 1532 | StringLiteral: `"foreignKeyConstraint"` → `""` | low value | function name in an error message |
| 902 | 1536 | StringLiteral: `"foreignKeyConstraint"` → `""` | low value | function name in an error message |
| 904 | 1539 | StringLiteral: `"foreignKeyConstraint"` → `""` | low value | function name in an error message |
| 906 | 1555 | StringLiteral: `"assocConstraint"` → `""` | low value | function name in an error message |
| 919 | 1566 | StringLiteral: `"assocConstraint"` → `""` | low value | function name in an error message |
| 920 | 1566 | StringLiteral: `"_"` → `""` | tested | assocConstraint default name of a two-column key (gaps.test.ts) |
| 922 | 1569 | StringLiteral: `"assocConstraint"` → `""` | low value | function name in an error message |
| 924 | 1587 | StringLiteral: `"noAssocConstraint"` → `""` | low value | function name in an error message |
| 951 | 1599 | StringLiteral: `"_"` → `""` | tested | noAssocConstraint default name of a two-column key (gaps.test.ts) |
| 953 | 1602 | StringLiteral: `"noAssocConstraint"` → `""` | low value | function name in an error message |
| 956 | 1618 | StringLiteral: `"checkConstraint"` → `""` | low value | function name in an error message |
| 972 | 1622 | ArrowFunction: `() => options.name` → `() => undefined` | equivalent | checkConstraint always has a name, which wins over the default |
| 976 | 1637 | StringLiteral: `"exclusionConstraint"` → `""` | low value | function name in an error message |
| 980 | 1641 | StringLiteral: `"exclusionConstraint"` → `""` | low value | function name in an error message |
| 982 | 1644 | StringLiteral: `"exclusionConstraint"` → `""` | low value | function name in an error message |
| 996 | 1653 | ConditionalExpression: `this.#spec.model === null` → `true` | low value | chooses the wording of an error message |
| 1083 | 1736 | StringLiteral: `"optimisticLock"` → `""` | low value | function name in an error message |
| 1101 | 1741 | ConditionalExpression: `current === undefined` → `false` | tested | optimisticLock refuses a field with no current value (gaps.test.ts) |
| 1112 | 1744 | ConditionalExpression: `increment === undefined` → `true` | tested | optimisticLock with a custom incrementer on a non-number (gaps.test.ts) |
| 1141 | 1819 | StringLiteral: `"validateUniqueAsync"` → `""` | low value | function name in an error message |
| 1167 | 1892 | ConditionalExpression: `value !== undefined` → `true` | low value | a JSON key holding undefined, which JSON.stringify drops |
| 1207 | 1930 | ConditionalExpression: `value <= limit` → `true` | tested | equalTo fails for a value above the limit (gaps.test.ts) |
| 1231 | 1946 | ConditionalExpression: `confirmation === undefined \|\| confirmation ` → `false` | equivalent | the type's cast refuses null and undefined, so confirms is false either way |
| 1232 | 1946 | LogicalOperator: `confirmation === undefined \|\| confirmation ` → `confirmation === undefined && confi` | equivalent | the type's cast refuses null and undefined, so confirms is false either way |
| 1233 | 1946 | ConditionalExpression: `confirmation === undefined` → `false` | equivalent | the type's cast refuses null and undefined, so confirms is false either way |
| 1235 | 1946 | ConditionalExpression: `confirmation === null` → `false` | equivalent | the type's cast refuses null and undefined, so confirms is false either way |
| 1251 | 1952 | ConditionalExpression: `typeof limit !== "number"` → `false` | equivalent | a limit that is not a number fails Number.isInteger too |
| 1262 | 1960 | BlockStatement: `(several lines)` → `{}` | tested | a validator given a value of the wrong type throws a QueryError (gaps.test.ts) |
| 1271 | 1969 | ConditionalExpression: `result === null` → `false` | tested | validateChange returning null is no issue (gaps.test.ts) |
| 1274 | 1970 | ConditionalExpression: `Array.isArray(result) && result.length === 0` → `false` | equivalent | an empty list maps to an empty list |
| 1288 | 1975 | ConditionalExpression: `(several lines)` → `true` | low value | a validator result of the wrong shape (misuse) is taken instead of refused |
| 1289 | 1975 | LogicalOperator: `(several lines)` → `typeof item === "object" \|\| item ` | low value | a validator result of the wrong shape (misuse) is taken instead of refused |
| 1290 | 1975 | ConditionalExpression: `typeof item === "object"` → `true` | equivalent | a non-object item has no string message and is refused anyway |
| 1293 | 1976 | ConditionalExpression: `item !== null` → `true` | low value | a null item (misuse) throws a TypeError instead of a QueryError |
| 1329 | 2000 | ConditionalExpression: `at.validation !== undefined` → `true` | equivalent | the descriptor of an entry without a validation already holds its options |
| 1361 | 2025 | ConditionalExpression: `hasOwn(data, field.name) \|\| hasOwn(changes,` → `false` | tested | schemaless applyChanges keeps the data's value over the default (gaps.test.ts) |
| 1362 | 2025 | LogicalOperator: `hasOwn(data, field.name) \|\| hasOwn(changes,` → `hasOwn(data, field.name) && hasOwn(` | tested | schemaless applyChanges keeps the data's value over the default (gaps.test.ts) |
| 1363 | 2027 | ConditionalExpression: `value !== undefined` → `true` | low value | a key holding undefined in the applied object; invisible to equality and JSON |
| 1371 | 2034 | ConditionalExpression: `!hasOwn(changes, name)` → `false` | tested | schemaless applyChanges keeps an embed with no change (gaps.test.ts) |
| 1373 | 2036 | StringLiteral: `"built"` → `""` | tested | schemaless applyChanges gives a built embed row (gaps.test.ts) |
| 1382 | 2046 | StringLiteral: `"built"` → `""` | tested | applyChanges gives a built embed row (gaps.test.ts) |
| 1397 | 2070 | MethodExpression: `value.some((item) => item instanceof Changese` → `value.every(item => item instanceof` | equivalent | a nested list is all changesets or none |
| 1404 | 2088 | ConditionalExpression: `shown !== changes[key]` → `true` | equivalent | copies the changes when nothing differs; the same values |
| 1413 | 2099 | BooleanLiteral: `false` → `true` | equivalent | the struct formatter redacts the same fields again; the output is the same |
| 1435 | 2146 | ConditionalExpression: `value.length > 0` → `true` | equivalent | an empty list has no child errors either way |
| 1436 | 2146 | EqualityOperator: `value.length > 0` → `value.length >= 0` | equivalent | an empty list has no child errors either way |
| 1438 | 2146 | MethodExpression: `value.every((item) => item instanceof Changes` → `value.some(item => item instanceof ` | equivalent | a nested list is all changesets or none |
| 1464 | 2239 | BlockStatement: `(several lines)` → `{}` | low value | cast() permitted that is not an array (misuse) is not refused |
| 1526 | 2265 | ConditionalExpression: `base !== undefined` → `true` | equivalent | a first cast has no earlier error to dedupe against |
| 1527 | 2265 | ConditionalExpression: `base !== undefined` → `false` | tested | casting null twice reports the required error once (gaps.test.ts) |
| 1528 | 2265 | EqualityOperator: `base !== undefined` → `base === undefined` | tested | casting null twice reports the required error once (gaps.test.ts) |
| 1536 | 2273 | ConditionalExpression: `result.meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |
| 1544 | 2278 | ConditionalExpression: `base !== undefined` → `true` | equivalent | a first cast has no earlier error to dedupe against |
| 1552 | 2286 | ConditionalExpression: `hasOwn(baseChanges, name)` → `true` | equivalent | a name with no earlier change reaches the same continue through the other branch |
| 1573 | 2305 | ConditionalExpression: `base.params === null` → `false` | equivalent | spreading null params adds nothing |
| 1600 | 2353 | StringLiteral (static): `"change"` → `""` | low value | function name in an error message |
| 1606 | 2370 | ConditionalExpression (static): `typeof values !== "object" \|\| values === nu` → `false` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1607 | 2370 | LogicalOperator (static): `typeof values !== "object" \|\| values === nu` → `typeof values !== "object" && value` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1608 | 2370 | ConditionalExpression (static): `typeof values !== "object"` → `false` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1611 | 2370 | ConditionalExpression (static): `values === null` → `false` | low value | change() with null values (misuse) throws a TypeError instead of a QueryError |
| 1613 | 2370 | BlockStatement: `(several lines)` → `{}` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1622 | 2377 | StringLiteral (static): `"change"` → `""` | low value | function name in an error message |
| 1624 | 2378 | ConditionalExpression (static): `spec.embeds.has(key)` → `false` | tested | change() refuses an embed with query.changeEmbed (gaps.test.ts) |
| 1625 | 2378 | BlockStatement: `(several lines)` → `{}` | tested | change() refuses an embed with query.changeEmbed (gaps.test.ts) |
| 1629 | 2379 | ObjectLiteral: `{ params: { key } }` → `{}` | low value | advice parameters of an error |
| 1630 | 2379 | ObjectLiteral: `{ key }` → `{}` | low value | advice parameters of an error |
| 1639 | 2410 | ConditionalExpression: `changeset.data === null` → `true` | equivalent | applied() of a loaded row's changeset is harmless; its result is discarded |
| 1658 | 2556 | BooleanLiteral: `false` → `true` | low value | dedupes only identical issues added in one call |
| 1662 | 2583 | StringLiteral: `"valueBefore"` → `""` | low value | function name in an error message |

### `nested/change.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1846 | 41 | StringLiteral (static): `"required"` → `""` | tested | a nested required error has the validation required (nested/gaps.test.ts) |
| 1867 | 73 | LogicalOperator: `typeof options !== "object" \|\| options === ` → `(typeof options !== "object" \|\| o` | equivalent | isItem refuses the same options anyway |
| 1868 | 73 | ConditionalExpression: `typeof options !== "object" \|\| options === ` → `false` | equivalent | isItem refuses the same options anyway |
| 1869 | 73 | LogicalOperator: `typeof options !== "object" \|\| options === ` → `typeof options !== "object" && opti` | equivalent | isItem refuses the same options anyway |
| 1870 | 73 | ConditionalExpression: `typeof options !== "object"` → `false` | equivalent | isItem refuses the same options anyway |
| 1873 | 73 | ConditionalExpression: `options === null` → `false` | equivalent | isItem refuses the same options anyway |
| 1945 | 119 | ConditionalExpression: `child.model === null` → `true` | low value | wording of an error message |
| 1946 | 119 | ConditionalExpression: `child.model === null` → `false` | low value | wording of an error message |
| 1947 | 119 | EqualityOperator: `child.model === null` → `child.model !== null` | low value | wording of an error message |
| 1949 | 120 | ObjectLiteral: `{ params: { target: relation.targetMeta.name ` → `{}` | low value | advice parameters of an error |
| 1950 | 120 | ObjectLiteral: `{ target: relation.targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 1956 | 152 | ConditionalExpression: `!hasOwn(changes, key)` → `false` | equivalent | the changes are a plain object with no inherited keys |
| 1958 | 154 | ConditionalExpression: `value instanceof Changeset` → `false` | tested | an invalid single child makes the parent invalid (nested/gaps.test.ts) |
| 1959 | 154 | BlockStatement: `(several lines)` → `{}` | tested | an invalid single child makes the parent invalid (nested/gaps.test.ts) |
| 1962 | 155 | ConditionalExpression: `!value.valid` → `false` | tested | an invalid single child makes the parent invalid (nested/gaps.test.ts) |
| 1963 | 155 | BooleanLiteral: `false` → `true` | tested | an invalid single child makes the parent invalid (nested/gaps.test.ts) |
| 1974 | 164 | ConditionalExpression: `hasOwn(errors, key)` → `true` | equivalent | the errors are a plain object with no inherited keys |
| 1980 | 174 | ConditionalExpression: `existing === undefined` → `true` | tested | a relation keeps both of two errors of its own (nested/gaps.test.ts) |
| 1984 | 174 | ArrayDeclaration (no coverage): `[...existing, error]` → `[]` | tested | a relation keeps both of two errors of its own (nested/gaps.test.ts) |
| 1987 | 190 | ConditionalExpression: `value === undefined` → `false` | tested | dropping a nested change leaves no key holding undefined (nested/gaps.test.ts) |
| 1992 | 191 | ConditionalExpression: `!hasOwn(before, relation.name)` → `false` | equivalent | a copy without an absent key holds the same changes |
| 1995 | 194 | ConditionalExpression: `key !== relation.name` → `false` | tested | dropping a nested change keeps the other changes (nested/gaps.test.ts) |
| 2000 | 202 | ConditionalExpression: `changes === before && errors === parent.error` → `false` | equivalent | rebuilds an equal changeset instead of returning the same one |
| 2012 | 208 | ConditionalExpression: `relation.kind === "embed"` → `true` | low value | chooses the advice of an error |
| 2013 | 208 | ConditionalExpression: `relation.kind === "embed"` → `false` | low value | chooses the advice of an error |
| 2014 | 208 | EqualityOperator: `relation.kind === "embed"` → `relation.kind !== "embed"` | low value | chooses the advice of an error |
| 2019 | 210 | StringLiteral: `'{ onReplace: "${relation.many ? "delete" : "` → `''` | low value | advice of an error |
| 2020 | 210 | StringLiteral: `"delete"` → `""` | low value | advice of an error |
| 2021 | 210 | StringLiteral: `"update"` → `""` | low value | advice of an error |
| 2026 | 214 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 2027 | 215 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 2030 | 218 | ConditionalExpression: `relation.kind === "embed"` → `true` | low value | advice parameters of an error |
| 2031 | 218 | ConditionalExpression: `relation.kind === "embed"` → `false` | low value | advice parameters of an error |
| 2032 | 218 | EqualityOperator: `relation.kind === "embed"` → `relation.kind !== "embed"` | low value | advice parameters of an error |
| 2033 | 218 | StringLiteral: `"embed"` → `""` | low value | advice parameters of an error |
| 2034 | 218 | StringLiteral: `""` → `"Stryker was here!"` | low value | advice parameters of an error |
| 2035 | 218 | StringLiteral: `', "deleteIfExists", "setNull"'` → `""` | low value | advice parameters of an error |
| 2036 | 219 | StringLiteral: `""` → `"Stryker was here!"` | low value | advice parameters of an error |
| 2037 | 219 | StringLiteral: `' and "update"'` → `""` | low value | advice parameters of an error |
| 2042 | 233 | ConditionalExpression: `assoc === undefined` → `false` | equivalent | only embeds have no association, and an embed cannot take setNull |
| 2068 | 254 | OptionalChaining: `assoc?.relatedKey` → `assoc.relatedKey` | equivalent | only embeds have no association, and an embed cannot take setNull |
| 2069 | 254 | ArrayDeclaration (no coverage): `[]` → `["Stryker was here"]` | equivalent | only embeds have no association, and an embed cannot take setNull |
| 2082 | 284 | ConditionalExpression: `relation.kind === "embed"` → `true` | equivalent | an association's key is never empty |
| 2110 | 295 | ConditionalExpression: `children.length === 0` → `true` | tested | required is met by children (nested/gaps.test.ts) |
| 2118 | 297 | ConditionalExpression: `extra.length === 0` → `true` | tested | with an error on it, the relation keeps its change (nested/gaps.test.ts) |
| 2125 | 307 | ConditionalExpression: `!child.valid \|\| child.action !== "update"` → `false` | tested | a stored row put back with an error and no change makes the parent invalid (nested/gaps.test.ts) |
| 2126 | 307 | LogicalOperator: `!child.valid \|\| child.action !== "update"` → `!child.valid && child.action !== "u` | tested | a stored row put back with an error and no change makes the parent invalid (nested/gaps.test.ts) |
| 2128 | 307 | ConditionalExpression: `child.action !== "update"` → `false` | equivalent | a matched child always comes from childOf as an update |
| 2131 | 307 | BooleanLiteral (no coverage): `false` → `true` | tested | a stored row put back with an error and no change makes the parent invalid (nested/gaps.test.ts) |
| 2132 | 308 | ConditionalExpression: `hasOwn(child.changes, key)` → `true` | equivalent | the changes are a plain object with no inherited keys |
| 2148 | 322 | ConditionalExpression: `child.action !== "insert" \|\| !child.valid` → `false` | tested | an invalid keyless item equal to the stored one is a change (nested/gaps.test.ts) |
| 2149 | 322 | LogicalOperator: `child.action !== "insert" \|\| !child.valid` → `child.action !== "insert" && !child` | tested | an invalid keyless item equal to the stored one is a change (nested/gaps.test.ts) |
| 2150 | 322 | ConditionalExpression: `child.action !== "insert"` → `false` | low value | only decides whether stored rows put back into a keyless list are written again with the same values |
| 2167 | 336 | ConditionalExpression: `value instanceof Changeset \|\| Array.isArray` → `false` | tested | a keyless item with a list value is always a change (nested/gaps.test.ts) |
| 2168 | 336 | LogicalOperator: `value instanceof Changeset \|\| Array.isArray` → `value instanceof Changeset && Array` | tested | a keyless item with a list value is always a change (nested/gaps.test.ts) |
| 2169 | 336 | BooleanLiteral (no coverage): `false` → `true` | tested | a keyless item with a list value is always a change (nested/gaps.test.ts) |
| 2171 | 338 | ConditionalExpression: `value === stored` → `false` | tested | a keyless item with an equal null is no change (nested/gaps.test.ts) |
| 2174 | 339 | ConditionalExpression: `value === null \|\| value === undefined \|\| ` → `false` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/gaps.test.ts) |
| 2175 | 339 | LogicalOperator: `value === null \|\| value === undefined \|\| ` → `(value === null \|\| value === unde` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/gaps.test.ts) |
| 2176 | 339 | ConditionalExpression: `value === null \|\| value === undefined \|\| ` → `false` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/gaps.test.ts) |
| 2177 | 339 | LogicalOperator: `value === null \|\| value === undefined \|\| ` → `(value === null \|\| value === unde` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/gaps.test.ts) |
| 2178 | 339 | ConditionalExpression: `value === null \|\| value === undefined` → `false` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/gaps.test.ts) |
| 2179 | 339 | LogicalOperator: `value === null \|\| value === undefined` → `value === null && value === undefin` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/gaps.test.ts) |
| 2180 | 339 | ConditionalExpression: `value === null` → `false` | tested | a keyless item with a date replaced by null is a change (nested/gaps.test.ts) |
| 2182 | 339 | ConditionalExpression: `value === undefined` → `false` | tested | a keyless item missing a required date is a change (nested/gaps.test.ts) |
| 2184 | 339 | ConditionalExpression: `stored === null` → `false` | tested | a keyless item with null replaced by a date is a change (nested/gaps.test.ts) |
| 2186 | 339 | ConditionalExpression: `stored === undefined` → `false` | equivalent | a stored row holds every field, so no stored value is undefined |
| 2188 | 339 | BooleanLiteral (no coverage): `false` → `true` | tested | a keyless item with a date replaced by null is a change (nested/gaps.test.ts) |
| 2195 | 347 | ConditionalExpression: `fallback !== undefined` → `true` | tested | a keyless item compares with a default given by a function (nested/gaps.test.ts) |
| 2198 | 347 | ConditionalExpression: `fallback.kind === "value"` → `true` | tested | a keyless item compares with a default given by a function (nested/gaps.test.ts) |
| 2207 | 354 | ConditionalExpression: `data === null \|\| typeof data !== "object" \` → `true` | tested | a change of a copy with the stored key is that row (nested/gaps.test.ts) |
| 2214 | 354 | ConditionalExpression: `typeof data !== "object"` → `false` | equivalent | a child's data is a row or null, never a primitive |
| 2215 | 354 | EqualityOperator: `typeof data !== "object"` → `typeof data === "object"` | tested | a change of a copy with the stored key is that row (nested/gaps.test.ts) |
| 2216 | 354 | StringLiteral: `"object"` → `""` | tested | a change of a copy with the stored key is that row (nested/gaps.test.ts) |
| 2217 | 354 | ConditionalExpression: `relation.key.length === 0` → `false` | equivalent | indexOfRow with an empty key finds nothing anyway |
| 2218 | 354 | EqualityOperator: `relation.key.length === 0` → `relation.key.length !== 0` | tested | a change of a copy with the stored key is that row (nested/gaps.test.ts) |
| 2221 | 355 | ConditionalExpression: `indexOfRow([current], relation.key, data) ===` → `false` | tested | a change of a copy with the stored key is that row (nested/gaps.test.ts) |
| 2223 | 355 | ArrayDeclaration: `[current]` → `[]` | tested | a change of a copy with the stored key is that row (nested/gaps.test.ts) |
| 2259 | 389 | ConditionalExpression: `(several lines)` → `default:` | equivalent | both cases only break |
| 2270 | 395 | OptionalChaining: `relation.assoc?.ownerKey` → `relation.assoc.ownerKey` | equivalent | a belongsTo relation always has its association |
| 2271 | 395 | ArrayDeclaration (no coverage): `[]` → `["Stryker was here"]` | equivalent | a belongsTo relation always has its association |
| 2283 | 405 | ConditionalExpression: `next === null` → `true` | tested | required is met by a value on a to-one relation (nested/gaps.test.ts) |
| 2290 | 407 | ConditionalExpression: `extra.length === 0` → `true` | tested | a blank to-one relation keeps its change (nested/gaps.test.ts) |
| 2304 | 408 | ConditionalExpression: `next !== null` → `true` | equivalent | kept is false when next is null, so the rest is never read |
| 2308 | 434 | StringLiteral: `"castEmbed"` → `""` | low value | function name in an error message |
| 2309 | 434 | StringLiteral: `"castAssoc"` → `""` | low value | function name in an error message |
| 2311 | 435 | StringLiteral: `"assoc"` → `""` | low value | kind name in an error message |
| 2319 | 442 | ObjectLiteral: `{ params: { embed: embed ? "putEmbed" : "putA` → `{}` | low value | advice parameters of an error |
| 2320 | 442 | ObjectLiteral: `{ embed: embed ? "putEmbed" : "putAssoc" }` → `{}` | low value | advice parameters of an error |
| 2365 | 465 | ConditionalExpression: `at >= 0` → `true` | equivalent | taken never holds -1 |
| 2377 | 469 | UnaryOperator: `-1` → `+1` | tested | a duplicate in a cast does not keep another stored row (nested/gaps.test.ts) |
| 2378 | 472 | ConditionalExpression: `at >= 0` → `true` | equivalent | adding -1 to taken changes nothing that is read |
| 2399 | 485 | BooleanLiteral: `true` → `false` | tested | a to-one cast key given as text is cast before it is matched (nested/gaps.test.ts) |
| 2403 | 487 | ConditionalExpression: `existing !== undefined` → `true` | tested | onReplace update with no row there inserts (nested/gaps.test.ts) |
| 2441 | 518 | ObjectLiteral: `{ params: { target: relation.targetMeta.name ` → `{}` | low value | advice parameters of an error |
| 2442 | 518 | ObjectLiteral: `{ target: relation.targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 2448 | 527 | BooleanLiteral: `false` → `true` | tested | putAssoc matches a plain object by its key as given, without casting (nested/gaps.test.ts) |
| 2455 | 529 | EqualityOperator: `at >= 0` → `at > 0` | tested | putAssoc of a plain object for the first stored row is an update (nested/gaps.test.ts) |
| 2460 | 530 | EqualityOperator: `at >= 0` → `at > 0` | tested | putAssoc of a plain object for the first stored row is an update (nested/gaps.test.ts) |
| 2467 | 535 | ObjectLiteral: `{ params: { target: relation.targetMeta.name ` → `{}` | low value | advice parameters of an error |
| 2468 | 535 | ObjectLiteral: `{ target: relation.targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 2474 | 549 | ConditionalExpression: `field !== undefined` → `true` | equivalent | a key that is not a field is no embed either way |
| 2492 | 552 | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a placeholder entry reads an undefined value and is skipped |
| 2498 | 558 | ObjectLiteral: `{ params: { target: targetMeta.name } }` → `{}` | low value | advice parameters of an error |
| 2499 | 558 | ObjectLiteral: `{ target: targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 2501 | 563 | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a placeholder entry reads an undefined value and is skipped |
| 2504 | 565 | ConditionalExpression: `value === undefined` → `false` | tested | an association key holding undefined in a plain object is skipped (nested/gaps.test.ts) |
| 2506 | 566 | MethodExpression: `targetMeta.embeds.some((embed) => embed.name ` → `targetMeta.embeds.every(embed => em` | tested | an association of a target without embeds is put as an association (nested/gaps.test.ts) |
| 2508 | 566 | ConditionalExpression: `embed.name === key` → `true` | tested | an association of a target with embeds is put as an association (nested/gaps.test.ts) |
| 2512 | 586 | StringLiteral: `"putEmbed"` → `""` | low value | function name in an error message |
| 2515 | 587 | StringLiteral: `"assoc"` → `""` | low value | kind name in an error message |
| 2523 | 589 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 2524 | 590 | ObjectLiteral: `{ what: relation.many ? "a list" : "a value o` → `{}` | low value | advice parameters of an error |
| 2540 | 604 | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a placeholder row has no key fields and matches nothing |
| 2569 | 629 | ConditionalExpression: `at < 0` → `true` | equivalent | a matched value gives the same update of the stored row either way |
| 2570 | 629 | EqualityOperator: `at < 0` → `at <= 0` | equivalent | a matched value gives the same update of the stored row either way |
| 2578 | 632 | BooleanLiteral: `false` → `true` | tested | putAssoc(null) on an optional relation is no error (nested/gaps.test.ts); killed by hand, Stryker's per-test coverage did not list that test (tool artifact, verified by hand) |

### `nested/relation.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 2775 | 57 | BlockStatement: `(several lines)` → `{}` | low value | describe() words a value for error messages only |
| 2776 | 58 | ConditionalExpression: `value === null` → `true` | low value | describe() words a value for error messages only |
| 2777 | 58 | ConditionalExpression: `value === null` → `false` | low value | describe() words a value for error messages only |
| 2778 | 58 | EqualityOperator: `value === null` → `value !== null` | low value | describe() words a value for error messages only |
| 2779 | 58 | StringLiteral (no coverage): `"null"` → `""` | low value | describe() words a value for error messages only |
| 2780 | 59 | ConditionalExpression: `Array.isArray(value)` → `true` | low value | describe() words a value for error messages only |
| 2781 | 59 | ConditionalExpression: `Array.isArray(value)` → `false` | low value | describe() words a value for error messages only |
| 2782 | 59 | StringLiteral (no coverage): `"an array"` → `""` | low value | describe() words a value for error messages only |
| 2783 | 60 | ConditionalExpression: `typeof value === "object"` → `true` | low value | describe() words a value for error messages only |
| 2784 | 60 | ConditionalExpression: `typeof value === "object"` → `false` | low value | describe() words a value for error messages only |
| 2785 | 60 | EqualityOperator: `typeof value === "object"` → `typeof value !== "object"` | low value | describe() words a value for error messages only |
| 2786 | 60 | StringLiteral: `"object"` → `""` | low value | describe() words a value for error messages only |
| 2787 | 60 | StringLiteral (no coverage): `"an object"` → `""` | low value | describe() words a value for error messages only |
| 2788 | 60 | StringLiteral: `'a ${typeof value}'` → `''` | low value | describe() words a value for error messages only |
| 2790 | 78 | ConditionalExpression: `model === null` → `true` | equivalent | the relation cache; without it the same relation is built again |
| 2793 | 80 | ConditionalExpression: `byName === undefined` → `true` | equivalent | the relation cache; without it the same relation is built again |
| 2797 | 82 | CallExpression: `relations.set(cacheKey, byName);` → `;` | equivalent | the relation cache; without it the same relation is built again |
| 2807 | 88 | ConditionalExpression: `known !== undefined` → `false` | equivalent | the relation cache; without it the same relation is built again |
| 2813 | 91 | CallExpression: `byName.set(id, relation);` → `;` | equivalent | the relation cache; without it the same relation is built again |
| 2814 | 95 | BlockStatement: `(several lines)` → `{}` | low value | owner name in an error message |
| 2815 | 96 | ConditionalExpression: `model === null` → `true` | low value | owner name in an error message |
| 2816 | 96 | ConditionalExpression: `model === null` → `false` | low value | owner name in an error message |
| 2817 | 96 | EqualityOperator: `model === null` → `model !== null` | low value | owner name in an error message |
| 2818 | 96 | StringLiteral (no coverage): `"this changeset without a schema class"` → `""` | low value | owner name in an error message |
| 2826 | 107 | ConditionalExpression: `field === undefined` → `false` | equivalent | a missing field has no embed type either, so the same branch is taken |
| 2840 | 112 | ObjectLiteral: `{ params: { fn: fn === "castEmbed" ? "castAss` → `{}` | low value | advice parameters of an error |
| 2841 | 112 | ObjectLiteral: `{ fn: fn === "castEmbed" ? "castAssoc" : "put` → `{}` | low value | advice parameters of an error |
| 2842 | 112 | ConditionalExpression: `fn === "castEmbed"` → `true` | low value | advice parameters of an error |
| 2843 | 112 | ConditionalExpression: `fn === "castEmbed"` → `false` | low value | advice parameters of an error |
| 2844 | 112 | EqualityOperator: `fn === "castEmbed"` → `fn !== "castEmbed"` | low value | advice parameters of an error |
| 2855 | 120 | ObjectLiteral: `{ params: { fn, other: fn === "castEmbed" ? "` → `{}` | low value | advice parameters of an error |
| 2856 | 120 | ObjectLiteral: `{ fn, other: fn === "castEmbed" ? "cast" : "p` → `{}` | low value | advice parameters of an error |
| 2857 | 120 | ConditionalExpression: `fn === "castEmbed"` → `true` | low value | advice parameters of an error |
| 2858 | 120 | ConditionalExpression: `fn === "castEmbed"` → `false` | low value | advice parameters of an error |
| 2859 | 120 | EqualityOperator: `fn === "castEmbed"` → `fn !== "castEmbed"` | low value | advice parameters of an error |
| 2864 | 127 | ConditionalExpression: `model === null` → `true` | low value | owner name shown in errors of a changeset without a schema class |
| 2867 | 127 | StringLiteral: `"schemaless"` → `""` | low value | owner name shown in errors of a changeset without a schema class |
| 2896 | 159 | ObjectLiteral: `{ params: { fn: fn === "castAssoc" ? "castEmb` → `{}` | low value | advice parameters of an error |
| 2897 | 159 | ObjectLiteral: `{ fn: fn === "castAssoc" ? "castEmbed" : "put` → `{}` | low value | advice parameters of an error |
| 2898 | 159 | ConditionalExpression: `fn === "castAssoc"` → `true` | low value | advice parameters of an error |
| 2899 | 159 | ConditionalExpression: `fn === "castAssoc"` → `false` | low value | advice parameters of an error |
| 2900 | 159 | EqualityOperator: `fn === "castAssoc"` → `fn !== "castAssoc"` | low value | advice parameters of an error |
| 2904 | 162 | ArrayDeclaration: `[...ownerMeta.assocs().keys()]` → `[]` | low value | list of associations in an error message |
| 2908 | 165 | ConditionalExpression: `names.length === 0` → `true` | low value | list of associations in an error message |
| 2949 | 202 | ConditionalExpression: `value === null` → `false` | tested | a to-one embed stored as null holds no row (nested/gaps.test.ts) |
| 2957 | 206 | ConditionalExpression: `!hasOwn(data, name)` → `false` | equivalent | an absent association reads as undefined, which fails the row check and throws the same NotLoadedError |
| 2958 | 206 | BlockStatement: `(several lines)` → `{}` | equivalent | an absent association reads as undefined, which fails the row check and throws the same NotLoadedError |
| 2960 | 207 | ObjectLiteral: `{ schema: relation.ownerName, association: na` → `{}` | tested | NotLoadedError names the schema and the association (nested/gaps.test.ts) |
| 2974 | 213 | ObjectLiteral: `{ schema: relation.ownerName, association: na` → `{}` | tested | NotLoadedError names the schema and the association (nested/gaps.test.ts) |
| 2989 | 232 | ConditionalExpression: `value === undefined \|\| value === null` → `false` | equivalent | a missing key value matches no stored row either way (stored keys are never null) |
| 2990 | 232 | LogicalOperator: `value === undefined \|\| value === null` → `value === undefined && value === nu` | equivalent | a missing key value matches no stored row either way (stored keys are never null) |
| 2991 | 232 | ConditionalExpression: `value === undefined` → `false` | equivalent | a missing key value matches no stored row either way (stored keys are never null) |
| 2993 | 232 | ConditionalExpression: `value === null` → `false` | equivalent | a missing key value matches no stored row either way (stored keys are never null) |
| 3000 | 233 | ConditionalExpression: `!cast` → `false` | tested | putAssoc matches a key as given, without casting (nested/gaps.test.ts) |
| 3001 | 233 | BlockStatement: `(several lines)` → `{}` | tested | putAssoc matches a key as given, without casting (nested/gaps.test.ts) |
| 3005 | 238 | ConditionalExpression: `!result.success` → `false` | equivalent | a key value the type refuses matches no stored row either way |
| 3009 | 245 | ConditionalExpression: `a === b` → `false` | equivalent | identity shortcut; key values are never null |
| 3013 | 246 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3014 | 246 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined \|` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3015 | 246 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3016 | 246 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined) &` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3017 | 246 | ConditionalExpression: `a === null \|\| a === undefined` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3018 | 246 | LogicalOperator: `a === null \|\| a === undefined` → `a === null && a === undefined` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3019 | 246 | ConditionalExpression: `a === null` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3021 | 246 | ConditionalExpression: `a === undefined` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3023 | 246 | ConditionalExpression: `b === null` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3025 | 246 | ConditionalExpression: `b === undefined` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3050 | 276 | UnaryOperator: `-0` → `+0` | equivalent | treating 0 as inexact only falls back to a scan, which finds the same row |
| 3056 | 297 | ConditionalExpression: `rows.length < INDEX_MIN_ROWS` → `false` | equivalent | indexing a short list finds the same rows as scanning it |
| 3057 | 297 | EqualityOperator: `rows.length < INDEX_MIN_ROWS` → `rows.length <= INDEX_MIN_ROWS` | equivalent | indexing a short list finds the same rows as scanning it |
| 3075 | 307 | ConditionalExpression: `value === null \|\| value === undefined` → `false` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3076 | 307 | LogicalOperator: `value === null \|\| value === undefined` → `value === null && value === undefin` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3077 | 307 | ConditionalExpression: `value === null` → `false` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3079 | 307 | ConditionalExpression: `value === undefined` → `false` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3083 | 308 | ConditionalExpression: `!mapsExactly(value)` → `false` | low value | only a key of -0 would be matched differently |
| 3107 | 325 | ConditionalExpression: `!mapsExactly(value)` → `false` | low value | only a key of -0 would be matched differently |
| 3114 | 336 | ConditionalExpression: `key.length === 0` → `false` | tested | indexOfRow without a key finds a row by identity (nested/gaps.test.ts) |
| 3116 | 337 | BooleanLiteral: `false` → `true` | equivalent | casting a stored row's key values gives the same values |
| 3118 | 338 | ConditionalExpression: `values === undefined` → `false` | tested | indexOfRow of a row with no key value is -1 (nested/gaps.test.ts) |
| 3120 | 338 | UnaryOperator (no coverage): `-1` → `+1` | tested | indexOfRow of a row with no key value is -1 (nested/gaps.test.ts) |
| 3128 | 348 | ConditionalExpression: `assoc === undefined \|\| (assoc.kind !== "has` → `false` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3129 | 348 | LogicalOperator: `assoc === undefined \|\| (assoc.kind !== "has` → `assoc === undefined && assoc.kind !` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3130 | 348 | ConditionalExpression: `assoc === undefined` → `false` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3132 | 348 | ConditionalExpression: `assoc.kind !== "hasMany" && assoc.kind !== "h` → `false` | equivalent | a belongs-to parent or many-to-many target cannot have its key set to null by a child change |
| 3137 | 348 | ConditionalExpression (no coverage): `assoc.kind !== "hasOne"` → `true` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3138 | 348 | EqualityOperator (no coverage): `assoc.kind !== "hasOne"` → `assoc.kind === "hasOne"` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3139 | 348 | StringLiteral (no coverage): `"hasOne"` → `""` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3140 | 348 | BooleanLiteral (no coverage): `false` → `true` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3143 | 350 | LogicalOperator: `!hasOwn(changes, name) \|\| changes[name] !==` → `!hasOwn(changes, name) && changes[n` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3145 | 350 | ConditionalExpression: `changes[name] !== null` → `false` | tested | leaves() for has-many, has-one and embed relations (nested/gaps.test.ts) |
| 3152 | 356 | LogicalOperator: `typeof value === "object" && value !== null &` → `typeof value === "object" && value ` | equivalent | isPlainObject refuses null, arrays and primitives anyway |
| 3153 | 356 | ConditionalExpression: `typeof value === "object" && value !== null &` → `true` | equivalent | isPlainObject refuses null, arrays and primitives anyway |
| 3154 | 356 | LogicalOperator: `typeof value === "object" && value !== null &` → `typeof value === "object" && value ` | equivalent | isPlainObject refuses null, arrays and primitives anyway |
| 3155 | 356 | ConditionalExpression: `typeof value === "object" && value !== null` → `true` | equivalent | isPlainObject refuses null, arrays and primitives anyway |
| 3156 | 356 | LogicalOperator: `typeof value === "object" && value !== null` → `typeof value === "object" \|\| valu` | equivalent | isPlainObject refuses null, arrays and primitives anyway |
| 3157 | 356 | ConditionalExpression: `typeof value === "object"` → `true` | equivalent | isPlainObject refuses null, arrays and primitives anyway |
| 3160 | 356 | ConditionalExpression: `value !== null` → `true` | equivalent | isPlainObject refuses null, arrays and primitives anyway |

### `validators/validate.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 3402 | 65 | ConditionalExpression: `fields === lastFields` → `false` | equivalent | the value-table cache; without it the same table is built again |
| 3404 | 67 | ConditionalExpression: `table === undefined` → `true` | equivalent | the value-table cache; without it the same table is built again |
| 3409 | 72 | ConditionalExpression: `builders === undefined` → `true` | equivalent | the generic builder gives the same values as the generated one |
| 3414 | 75 | CallExpression: `tables.set(fields, table);` → `;` | equivalent | the value-table cache; without it the same table is built again |
| 3479 | 141 | ConditionalExpression: `typeof props !== "object"` → `false` | equivalent | props that are not an object fail the version check anyway |
| 3513 | 173 | ObjectLiteral (static): `(several lines)` → `{}` | equivalent | the empty default options read as the same falsy options |
| 3582 | 204 | ConditionalExpression: `typeof name === "string"` → `true` | equivalent | a name that is not a string finds no field either way, and the error is chosen again below |
| 3596 | 209 | ArrayDeclaration: `[...fields.keys()]` → `[]` | low value | list of fields in an error message |
| 3608 | 231 | ConditionalExpression: `value !== undefined` → `true` | tested | with only, a listed field without a value is not a key (validators/gaps.test.ts) |
| 3613 | 243 | ConditionalExpression: `data !== null && changeset.model !== null` → `false` | equivalent | the values before the changes of a loaded row are the row's values |
| 3641 | 287 | ConditionalExpression: `typeof value === "function"` → `false` | low value | only a function with a then method would be taken for a promise |
| 3643 | 287 | StringLiteral: `"function"` → `""` | low value | only a function with a then method would be taken for a promise |
| 3655 | 300 | ConditionalExpression: `typeof result !== "object"` → `false` | low value | a Standard Schema result that is not an object (a broken library) is taken as a success |
| 3675 | 322 | ConditionalExpression: `result.length > 0` → `true` | equivalent | an empty list of issues and no list both mean no issues to the caller |
| 3677 | 322 | EqualityOperator: `result.length > 0` → `result.length >= 0` | equivalent | an empty list of issues and no list both mean no issues to the caller |
| 3696 | 342 | EqualityOperator: `last >= 0xd800` → `last > 0xd800` | low value | truncation of a value shown in an error message |
| 3699 | 342 | EqualityOperator: `last <= 0xdbff` → `last < 0xdbff` | low value | truncation of a value shown in an error message |
| 3756 | 382 | ConditionalExpression: `Object.getPrototypeOf(raw) === Array.prototyp` → `false` | equivalent | copying a plain array path gives the same path |
| 3771 | 390 | ConditionalExpression: `typeof segment === "object" && segment !== nu` → `true` | equivalent | a primitive segment has no key and is refused anyway |
| 3773 | 390 | LogicalOperator: `typeof segment === "object" && segment !== nu` → `typeof segment === "object" \|\| se` | low value | a null path segment (misuse) throws a TypeError of another wording |
| 3774 | 390 | ConditionalExpression: `typeof segment === "object"` → `true` | equivalent | a primitive segment has no key and is refused anyway |
| 3777 | 390 | ConditionalExpression: `segment !== null` → `true` | low value | a null path segment (misuse) throws a TypeError of another wording |
| 3792 | 411 | ConditionalExpression: `typeof raw !== "object" \|\| raw === null` → `false` | low value | a null issue (misuse) throws a TypeError of another wording |
| 3793 | 411 | LogicalOperator: `typeof raw !== "object" \|\| raw === null` → `typeof raw !== "object" && raw === ` | low value | a null issue (misuse) throws a TypeError of another wording |
| 3794 | 411 | ConditionalExpression: `typeof raw !== "object"` → `false` | equivalent | a primitive issue has no string message and is refused anyway |
| 3797 | 411 | ConditionalExpression: `raw === null` → `false` | low value | a null issue (misuse) throws a TypeError of another wording |
| 3815 | 421 | ConditionalExpression: `meta === null` → `false` | low value | an issue meta of null (misuse) is accepted instead of refused |
| 3825 | 432 | ConditionalExpression: `meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |
| 3850 | 478 | ConditionalExpression: `typeof head === "string"` → `true` | equivalent | a head that is not a string is no field and no nested key either way |
| 3859 | 479 | ConditionalExpression: `options.only === undefined \|\| options.only.` → `true` | tested | with only, an issue on a relation that is not listed is dropped (validators/gaps.test.ts) |
| 3885 | 495 | ConditionalExpression: `typeof head === "string"` → `true` | equivalent | a head that is not a string is no field and no nested key either way |
| 3903 | 501 | ConditionalExpression: `path.length === 1` → `false` | equivalent | slice(1) of a one-key path is the same empty path |
| 3912 | 522 | ConditionalExpression: `!hasOwn(changes, head)` → `false` | equivalent | an absent key reads as undefined, which is no nested change either way |
| 3916 | 524 | UnaryOperator: `-1` → `+1` | equivalent | the index of a single nested child is not read |
| 3919 | 525 | ConditionalExpression: `!Array.isArray(value) \|\| !isNestedValue(val` → `false` | tested | an issue on an item of a plain list field stays on the field (validators/gaps.test.ts) |
| 3920 | 525 | LogicalOperator: `!Array.isArray(value) \|\| !isNestedValue(val` → `!Array.isArray(value) && !isNestedV` | tested | an issue on an item of a plain list field stays on the field (validators/gaps.test.ts) |
| 3923 | 527 | ConditionalExpression: `typeof at === "number"` → `true` | equivalent | a position that is not a whole number finds no child either way |
| 3927 | 527 | ConditionalExpression: `typeof at === "string" && /^\\d+$/.test(at)` → `true` | equivalent | a position that is not a whole number finds no child either way |
| 3929 | 527 | LogicalOperator: `typeof at === "string" && /^\\d+$/.test(at)` → `typeof at === "string" \|\| /^\\d+$` | equivalent | a position that is not a whole number finds no child either way |
| 3930 | 527 | ConditionalExpression: `typeof at === "string"` → `true` | equivalent | a position that is not a whole number finds no child either way |
| 3933 | 527 | Regex: `/^\\d+$/` → `/\\d+$/` | equivalent | a position that is not a whole number finds no child either way |
| 3934 | 527 | Regex: `/^\\d+$/` → `/^\\d+/` | equivalent | a position that is not a whole number finds no child either way |
| 3935 | 527 | Regex: `/^\\d+$/` → `/^\\d$/` | tested | a position given as text from 10 on, and one that is not a number (validators/gaps.test.ts) |
| 3937 | 527 | UnaryOperator (no coverage): `-1` → `+1` | tested | a position given as text from 10 on, and one that is not a number (validators/gaps.test.ts) |
| 3939 | 528 | ConditionalExpression: `position < 0` → `false` | equivalent | a position that is not a whole number finds no child either way |
| 3951 | 539 | ConditionalExpression: `!(item instanceof Changeset) \|\| relation ==` → `true` | tested | a child that leaves the relation is skipped when positions are counted (validators/gaps.test.ts) |
| 3954 | 539 | ConditionalExpression: `!(item instanceof Changeset) \|\| relation ==` → `false` | equivalent | every item of a nested list in the changes is a changeset of a relation (change() and putChange refuse relation fields), so the condition is the same as !leaves(...) |
| 3955 | 539 | LogicalOperator: `!(item instanceof Changeset) \|\| relation ==` → `!(item instanceof Changeset) && rel` | equivalent | every item of a nested list in the changes is a changeset of a relation, so || and && give the same result |
| 3956 | 539 | BooleanLiteral: `!(item instanceof Changeset)` → `item instanceof Changeset` | tested | a child that leaves the relation is skipped when positions are counted (validators/gaps.test.ts) |
| 3957 | 539 | ConditionalExpression: `relation === undefined` → `false` | equivalent | a list holding changesets always belongs to a relation: a changeset without a schema class has only embed fields |
| 3958 | 539 | EqualityOperator: `relation === undefined` → `relation !== undefined` | tested | a child that leaves the relation is skipped when positions are counted (validators/gaps.test.ts) |
| 3961 | 545 | BlockStatement: `(several lines)` → `{}` | tested | a child that leaves the relation is skipped when positions are counted (validators/gaps.test.ts) |
| 3963 | 546 | ConditionalExpression: `fieldsOf(changeset).has(key)` → `false` | tested | an issue reaches an item of an embedded list (validators/gaps.test.ts) |
| 3964 | 546 | StringLiteral (no coverage): `"validate"` → `""` | low value | function name in an error message |
| 3965 | 546 | StringLiteral (no coverage): `"embed"` → `""` | tested | an issue reaches an item of an embedded list (validators/gaps.test.ts) |
| 3966 | 547 | ConditionalExpression: `changeset.model === null` → `true` | tested | a child that leaves the relation is skipped when positions are counted (validators/gaps.test.ts) |
| 3967 | 547 | ConditionalExpression: `changeset.model === null` → `false` | equivalent | a changeset without a schema class has no associations to route into |
| 3968 | 547 | EqualityOperator: `changeset.model === null` → `changeset.model !== null` | tested | a child that leaves the relation is skipped when positions are counted (validators/gaps.test.ts) |
| 3969 | 547 | StringLiteral: `"validate"` → `""` | low value | function name in an error message |
| 3970 | 547 | StringLiteral: `"assoc"` → `""` | equivalent | any relation kind but embed is looked up as an association |
| 3976 | 559 | BooleanLiteral: `false` → `true` | equivalent | the children's apply option is never read: only routed issues reach them |
| 3979 | 563 | MethodExpression: `value.slice()` → `value` | tested | validate leaves the earlier changeset's nested list alone (validators/gaps.test.ts) |
| 3988 | 580 | ConditionalExpression: `hasOwn(out.errors, key)` → `true` | equivalent | the loop only visits keys the errors have |
| 3989 | 580 | ConditionalExpression: `hasOwn(out.errors, key)` → `false` | tested | the parent's own error keeps it invalid when every routed issue is dropped (validators/gaps.test.ts) |
| 3990 | 580 | BooleanLiteral: `false` → `true` | tested | the parent's own error keeps it invalid when every routed issue is dropped (validators/gaps.test.ts) |
| 3999 | 595 | ConditionalExpression: `!hasOwn(changes, key)` → `false` | equivalent | the changes are a plain object with no inherited keys |
| 4000 | 597 | ConditionalExpression: `fields.has(key)` → `true` | equivalent | only lists field names, so an association name is never in it |
| 4013 | 599 | ConditionalExpression: `only !== undefined` → `false` | tested | with only, an association change is left out (validators/gaps.test.ts) |
| 4017 | 602 | ConditionalExpression: `Array.isArray(value)` → `true` | tested | a to-one change of null is seen as null (validators/gaps.test.ts) |
| 4031 | 630 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4032 | 630 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined \|` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4033 | 630 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4034 | 630 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined) &` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4035 | 630 | ConditionalExpression: `a === null \|\| a === undefined` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4036 | 630 | LogicalOperator: `a === null \|\| a === undefined` → `a === null && a === undefined` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4037 | 630 | ConditionalExpression: `a === null` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4039 | 630 | ConditionalExpression: `a === undefined` → `false` | tested | apply: a field of a new record with no value yet takes the output, also for a date type (validators/gaps.test.ts) |
| 4041 | 630 | ConditionalExpression: `b === null` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/gaps.test.ts) |
| 4043 | 630 | ConditionalExpression: `b === undefined` → `false` | low value | the output value: undefined is skipped before same(); only a custom type whose cast succeeds with undefined reaches it |
| 4050 | 645 | ConditionalExpression: `typeof output !== "object"` → `false` | equivalent | Object.keys of a primitive output names no field |
| 4061 | 652 | ConditionalExpression: `value === undefined` → `false` | tested | apply ignores an output key holding undefined (validators/gaps.test.ts) |
| 4074 | 660 | ConditionalExpression: `result.meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |
| 4132 | 736 | ConditionalExpression: `issues.length === 0` → `false` | tested | a result with an empty list of issues is a success and its output is applied (validators/gaps.test.ts) |
| 4139 | 763 | StringLiteral: `"validate"` → `""` | low value | function name in an error message |
| 4149 | 789 | StringLiteral: `"validateAsync"` → `""` | low value | function name in an error message |
| 4168 | 822 | ConditionalExpression: `issues.length === 0` → `false` | equivalent | adding no issues to a field leaves the changeset valid |
| 4173 | 846 | StringLiteral: `"validateField"` → `""` | low value | function name in an error message |
| 4175 | 847 | StringLiteral: `"validateField"` → `""` | low value | function name in an error message |
| 4187 | 852 | CallExpression: `discard(result);` → `;` | tested | a rejected promise from validateField is refused without an unhandled rejection (validators/gaps.test.ts) |
| 4196 | 878 | StringLiteral: `"validateFieldAsync"` → `""` | low value | function name in an error message |
| 4198 | 879 | StringLiteral: `"validateFieldAsync"` → `""` | low value | function name in an error message |
| 4204 | 881 | ConditionalExpression: `value === null` → `false` | tested | validateFieldAsync skips a null value and records the validator (validators/gaps.test.ts) |
| 4206 | 881 | ObjectLiteral: `{ schema: validator }` → `{}` | tested | validateFieldAsync skips a null value and records the validator (validators/gaps.test.ts) |

### `nested/embed.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 2587 | 26 | ConditionalExpression: `item instanceof Changeset` → `true` | tested | a plain list field is no nested change (validators/gaps.test.ts, an issue on a plain list field) |
| 2590 | 27 | BooleanLiteral: `false` → `true` | tested | a plain list field is no nested change (validators/gaps.test.ts, an issue on a plain list field) |
| 2596 | 41 | LogicalOperator: `!Array.isArray(value) \|\| !isNestedValue(val` → `!Array.isArray(value) && !isNestedV` | equivalent | a list that is no nested change is copied with the same items |
| 2601 | 44 | ConditionalExpression: `item instanceof Changeset` → `true` | equivalent | the items of a nested embed list are all changesets |
| 2619 | 59 | ConditionalExpression: `hasOwn(changeset.changes, key)` → `true` | equivalent | the changes are a plain object with no inherited keys |
| 2622 | 60 | BooleanLiteral (no coverage): `false` → `true` | tested | an unchanged stored embed item is the stored row (changeset/gaps.test.ts) |
| 2625 | 66 | ConditionalExpression: `data !== null && !hasChanges(child)` → `false` | tested | an unchanged stored embed item is the stored row (changeset/gaps.test.ts) |
| 2647 | 76 | ConditionalExpression: `data !== null` → `false` | equivalent | only a field both defaulted and generated on every write would take the other branch |
| 2651 | 76 | ConditionalExpression: `field.default === undefined` → `true` | equivalent | only a field both defaulted and generated on every write would take the other branch |
| 2667 | 89 | ConditionalExpression: `hasOwn(changes, field.name)` → `true` | tested | a built embed row keeps a stored virtual field, and a new one has none (changeset/gaps.test.ts) |
| 2670 | 90 | ConditionalExpression: `data !== null` → `false` | tested | a built embed row keeps a stored virtual field, and a new one has none (changeset/gaps.test.ts) |
| 2678 | 103 | StringLiteral (static): `"required"` → `""` | tested | missingEmbedded reports with the required validation (changeset/gaps.test.ts) |
| 2682 | 123 | ConditionalExpression: `embedTypeInfo(field.type) === undefined \|\| ` → `false` | equivalent | a field that is no embed holds no nested change, so nothing is checked either way |
| 2683 | 123 | LogicalOperator: `embedTypeInfo(field.type) === undefined \|\| ` → `embedTypeInfo(field.type) === undef` | equivalent | a field that is no embed holds no nested change, so nothing is checked either way |
| 2684 | 123 | ConditionalExpression: `embedTypeInfo(field.type) === undefined` → `false` | equivalent | a field that is no embed holds no nested change, so nothing is checked either way |
| 2695 | 128 | ObjectLiteral: `{ ...changes }` → `{}` | tested | missingEmbedded keeps the other changes (changeset/gaps.test.ts) |
| 2696 | 131 | ConditionalExpression: `Array.isArray(value)` → `true` | tested | missingEmbedded of a null embed change (changeset/gaps.test.ts) |
| 2702 | 134 | ConditionalExpression: `!(item instanceof Changeset) \|\| (item as An` → `false` | tested | missingEmbedded skips a deleted item (changeset/gaps.test.ts) |
| 2703 | 134 | LogicalOperator: `!(item instanceof Changeset) \|\| (item as An` → `!(item instanceof Changeset) && (it` | tested | missingEmbedded skips a deleted item (changeset/gaps.test.ts) |
| 2705 | 134 | ConditionalExpression: `(item as AnyChangeset).action === "delete"` → `false` | tested | missingEmbedded skips a deleted item (changeset/gaps.test.ts) |
| 2707 | 134 | StringLiteral: `"delete"` → `""` | tested | missingEmbedded skips a deleted item (changeset/gaps.test.ts) |
| 2712 | 137 | MethodExpression: `value.slice()` → `value` | tested | missingEmbedded leaves the earlier list alone (changeset/gaps.test.ts) |
| 2713 | 140 | ConditionalExpression: `list !== undefined` → `true` | tested | a second embed with nothing missing keeps its change (changeset/gaps.test.ts) |
| 2718 | 141 | ObjectLiteral: `{ ...changes }` → `{}` | tested | missingEmbedded keeps the other changes (changeset/gaps.test.ts) |
| 2723 | 146 | BooleanLiteral: `false` → `true` | tested | missingEmbedded marks the parent invalid (changeset/gaps.test.ts) |
| 2733 | 159 | ConditionalExpression: `data === null` → `true` | tested | a stored row with null in its generated key is reported (changeset/gaps.test.ts) |
| 2756 | 165 | BooleanLiteral: `false` → `true` | tested | missingEmbedded marks the child invalid (changeset/gaps.test.ts) |
| 2761 | 182 | ConditionalExpression: `!hasOwn(changes, key)` → `false` | equivalent | the changes are a plain object with no inherited keys |
| 2764 | 184 | ConditionalExpression: `!isNestedValue(value)` → `false` | equivalent | a value that is no nested change becomes the same value |
| 2766 | 186 | ConditionalExpression: `field === undefined \|\| embedTypeInfo(field.` → `false` | tested | embedChanges leaves an association change as it is (changeset/gaps.test.ts) |
| 2767 | 186 | LogicalOperator: `field === undefined \|\| embedTypeInfo(field.` → `field === undefined && embedTypeInf` | tested | embedChanges leaves an association change as it is (changeset/gaps.test.ts) |
| 2768 | 186 | ConditionalExpression: `field === undefined` → `false` | tested | embedChanges leaves an association change as it is (changeset/gaps.test.ts) |
| 2770 | 186 | ConditionalExpression: `embedTypeInfo(field.type) === undefined` → `false` | equivalent | a field that is no embed holds no nested change |

### `spec.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 3200 | 66 | ConditionalExpression: `typeof types !== "object"` → `false` | equivalent | types that are not an object fail isPlainObject anyway |
| 3211 | 73 | ConditionalExpression: `spec !== undefined` → `false` | tested | two changesets of the same data and types are of the same record (changeset/gaps.test.ts) |
| 3254 | 98 | LogicalOperator: `state.column ?? name` → `state.column && name` | equivalent | a field without a schema class has no table, so its column is never read |
| 3262 | 122 | CallExpression: `byTypes.set(types, spec);` → `;` | tested | two changesets of the same data and types are of the same record (changeset/gaps.test.ts) |
| 3266 | 128 | ConditionalExpression: `!isRow(value)` → `false` | equivalent | an object that is not a row has no schema class either way |
| 3270 | 131 | ConditionalExpression: `typeof prototype === "object"` → `true` | equivalent | an object that is not a row has no schema class either way |
| 3282 | 150 | ConditionalExpression: `typeof target === "object"` → `true` | equivalent | a primitive fails the next check anyway |
| 3292 | 153 | ConditionalExpression: `isPlainObject(target) && Object.hasOwn(target` → `true` | low value | an object without types (misuse) is refused with another error |
| 3294 | 153 | LogicalOperator: `isPlainObject(target) && Object.hasOwn(target` → `isPlainObject(target) \|\| Object.h` | low value | an object without types (misuse) is refused with another error |
| 3302 | 156 | ConditionalExpression: `typeof data !== "object"` → `false` | equivalent | a primitive fails the next check anyway |
| 3335 | 183 | ConditionalExpression: `typeof params === "object"` → `true` | low value | wording of an error message |
| 3336 | 183 | ConditionalExpression: `typeof params === "object"` → `false` | low value | wording of an error message |
| 3337 | 183 | EqualityOperator: `typeof params === "object"` → `typeof params !== "object"` | low value | wording of an error message |
| 3338 | 183 | StringLiteral: `"object"` → `""` | low value | wording of an error message |
| 3339 | 184 | StringLiteral: `"an object that is not plain"` → `""` | low value | wording of an error message |
| 3340 | 185 | StringLiteral: `'a ${typeof params}'` → `''` | low value | wording of an error message |
| 3345 | 194 | ConditionalExpression (static): `typeof name === "string"` → `true` | equivalent | a name that is not a string finds no field either way |
| 3353 | 196 | ConditionalExpression: `typeof name !== "string"` → `false` | low value | a name that is not a string (misuse) is refused with another error |
| 3356 | 196 | BlockStatement: `(several lines)` → `{}` | low value | a name that is not a string (misuse) is refused with another error |
| 3362 | 199 | OptionalChaining: `spec.meta?.assocs` → `spec.meta.assocs` | tested | an unknown field of a changeset without a schema class is a QueryError (changeset/gaps.test.ts) |

### `measure.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1665 | 15 | BooleanLiteral: `true` → `false` | equivalent | always segmenting gives the same count |
| 1667 | 16 | EqualityOperator: `i < text.length` → `i <= text.length` | equivalent | reading past the end gives NaN, which matches no range |
| 1671 | 19 | ConditionalExpression: `code >= 0x80 \|\| code === 0x0d` → `true` | equivalent | the fast path and the segmenter count these characters alike |
| 1675 | 19 | EqualityOperator: `code >= 0x80` → `code > 0x80` | equivalent | the fast path and the segmenter count these characters alike |
| 1678 | 19 | EqualityOperator: `code === 0x0d` → `code !== 0x0d` | equivalent | the fast path and the segmenter count these characters alike |
| 1682 | 24 | ConditionalExpression: `simple` → `false` | equivalent | always segmenting gives the same count |
| 1684 | 25 | ObjectLiteral: `{ granularity: "grapheme" }` → `{}` | equivalent | grapheme is the segmenter's default granularity |
| 1689 | 34 | EqualityOperator: `i < text.length - 1` → `i <= text.length - 1` | equivalent | reading past the end gives NaN, which matches no range |
| 1691 | 34 | ArithmeticOperator: `text.length - 1` → `text.length + 1` | equivalent | reading past the end gives NaN, which matches no range |
| 1744 | 54 | ConditionalExpression: `i + 1 < text.length` → `true` | equivalent | reading past the end gives NaN, which is no low surrogate |
| 1745 | 54 | EqualityOperator: `i + 1 < text.length` → `i + 1 <= text.length` | equivalent | reading past the end gives NaN, which is no low surrogate |
| 1747 | 54 | ArithmeticOperator: `i + 1` → `i - 1` | equivalent | reading past the end gives NaN, which is no low surrogate |

### `nested/build.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1785 | 50 | ConditionalExpression: `assoc.kind !== "hasOne"` → `true` | tested | buildAssoc builds the child of a has-one association (changeset/gaps.test.ts) |
| 1787 | 50 | StringLiteral: `"hasOne"` → `""` | tested | buildAssoc builds the child of a has-one association (changeset/gaps.test.ts) |
| 1812 | 60 | ObjectLiteral: `{ params: { owner: ownerMeta.name } }` → `{}` | low value | advice parameters of an error |
| 1813 | 60 | ObjectLiteral: `{ owner: ownerMeta.name }` → `{}` | low value | advice parameters of an error |
| 1821 | 68 | ConditionalExpression: `value === undefined` → `false` | equivalent | a row holds every field, so a key value is null, never undefined |
| 1841 | 86 | ConditionalExpression: `values !== undefined` → `true` | equivalent | change() with no values returns the changeset as it is |

### `validators/generated.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 3387 | 80 | StringLiteral (static): `"\\n"` → `""` | equivalent | the generated statements are valid on one line as well |
| 3389 | 86 | ConditionalExpression (static): `makeBuild === undefined` → `false` | equivalent | once generation is refused, the next generateFunction is refused too and returns first |
| 3394 | 92 | ConditionalExpression (static): `outerBefore === undefined` → `false` | tested | generation refused after some functions: validate falls back to loops (validators/codegen-late.test.ts) |
