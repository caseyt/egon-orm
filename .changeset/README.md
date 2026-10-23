# Changesets

Release notes and version bumps are managed with [changesets](https://github.com/changesets/changesets).
(Not to be confused with Egon's own changesets, which validate data.)

- Every PR that changes a published package adds a changeset: `pnpm changeset`. Before
  1.0, choose `minor` for a breaking change and `patch` for anything else (features
  included); the versioning policy is in `docs/site/reference/upgrading.md`.
- All packages are versioned together (`fixed` in `config.json`): `egon-orm` and every
  `@egon-orm/*` package always share one version number. Private packages are never
  versioned. `scripts/check-release-config.mjs` (part of `pnpm lint`) keeps the group
  equal to the set of published packages.
- `pnpm version-packages` applies pending changesets and then runs
  `scripts/sync-version.mjs`, which updates the `VERSION` constant in each package.
- `pnpm release` publishes; `.github/workflows/release.yml` runs both, and
  `pnpm release:dry-run` rehearses them against a local registry. See "Releases" in
  `CONTRIBUTING.md`.
