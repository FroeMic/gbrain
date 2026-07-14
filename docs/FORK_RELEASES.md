# Maintained Fork Releases

This fork has two independent version axes:

- `VERSION`, `package.json`, the root workspace in `bun.lock`, and the top
  `CHANGELOG.md` entry identify the included upstream GBrain release.
- `FORK_VERSION` identifies a release of this maintained fork.

A fork-only change advances only `FORK_VERSION`. An upstream sync adopts the
upstream release metadata as a unit, while retaining the current fork version
until the combined tree is reviewed and released.

## Release a fork change

1. Keep upstream-facing contribution branches free of `FORK_VERSION` changes.
2. Create a fork release branch from the reviewed contribution tip.
3. Set the next three-segment version in `FORK_VERSION`.
4. Run `bun test test/release-contract.test.ts`, the affected suites, and the
   full repository gates.
5. Open a pull request to the fork's `master` branch and merge it with a merge
   commit. Do not squash or rebase the release history.
6. Add an annotated `monodrive-gbrain-v<fork-version>` tag to that merge commit
   and push the tag once. Published release tags are immutable.
7. Resolve the tag through the fork remote to a full 40-character commit SHA.
   Use that SHA—not a branch or moving tag—as the E2B image source.

## Sync a later upstream release

1. Fetch the upstream remote without changing the current release branch.
2. Create an upstream-sync branch from the fork's `master` branch.
3. Merge the selected upstream release with a merge commit; never rebase the
   maintained fork onto upstream.
4. Resolve conflicts deliberately. Adopt the selected upstream values for
   `VERSION`, `package.json`, the root `bun.lock` workspace version, and the top
   changelog release together. Preserve `FORK_VERSION` during the sync.
5. Run the release-contract test, focused fork suites, and full repository
   gates. Review the complete merge diff before opening the pull request.
6. After the combined tree is accepted, create a separate fork release branch,
   advance `FORK_VERSION`, and follow the fork release steps above.

This produces an identity such as
`gbrain-0.42.59.0-fork-0.1.0`: the first component carries upstream meaning,
and the second carries the maintained fork's release lineage.
