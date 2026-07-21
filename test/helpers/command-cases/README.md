# Command contract cases

Add each command as a `BrainCommandCase`. Run the case unchanged with the
trusted-local and trusted-HTTP callers. Use `selectCommandCases` with
`COMMAND_TEST_GROUP`. The root package provides `pr`, `merge`, `nightly`, and
`release` scripts.

Use ephemeral Postgres for the production database path. Use temporary paths
for files, transcripts, schemas, images, and Git repositories. Use recorded or
deterministic gateway responses for model-dependent cases.
