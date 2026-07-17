#!/usr/bin/env bash
# scripts/run-serial-tests.sh — run *.serial.test.ts files with --max-concurrency=1.
#
# Serial files are tests that share file-wide state (top-level mock.module,
# module-level singletons that intentionally cross test cases) and would race
# under intra-file concurrency. Discovered via filename suffix; no annotation
# inside the file is needed.
#
# Excluded by run-unit-shard.sh and run-unit-parallel.sh's parallel pass.
# Invoked separately by run-unit-parallel.sh after the parallel pass succeeds.

set -euo pipefail

cd "$(dirname "$0")/.."

# Use while-read for portability to macOS bash 3.2 (no mapfile).
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find test -name '*.serial.test.ts' -not -path 'test/e2e/*' | sort)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[serial-tests] no *.serial.test.ts files found"
  exit 0
fi

# --dry-run-list mirrors run-unit-shard.sh for inline checks/tests.
if [ "${1:-}" = "--dry-run-list" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

echo "[serial-tests] running ${#files[@]} file(s), one bun process per file"

# Each serial file gets its OWN bun process. `--max-concurrency=1` was not
# enough: files in the same process share the module registry, so a top-level
# `mock.module(...)` in one file leaks into the next file's imports
# (eval-takes-quality-runner mocks gateway.ts and the next file fails on
# `import { resetGateway }` because the mock factory didn't export it).
# Per-file processes give true isolation; cost is ~100ms startup × N files.
fail_count=0
failed_files=()
for f in "${files[@]}"; do
  serial_home=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-serial.XXXXXX")
  serial_tmp="$serial_home/tmp"
  mkdir -p "$serial_tmp"
  # The CI runner exports the production-default PGLite snapshot for the
  # parallel lane. Serial tests intentionally exercise cold/fresh PGLite
  # behavior and the legacy 1536-d test preload, so do not let that 1280-d
  # snapshot bypass initSchema in this lane.
  # HOME/GBRAIN_HOME are also per-file: serial tests intentionally exercise
  # git/config/worker/audit state, and a fresh Bun process alone does not
  # isolate those filesystem side effects from the preceding file.
  if ! HOME="$serial_home" GBRAIN_HOME="$serial_home" TMPDIR="$serial_tmp" \
    env -u GBRAIN_PGLITE_SNAPSHOT bun test --max-concurrency=1 --timeout=60000 "$f"; then
    fail_count=$((fail_count + 1))
    failed_files+=("$f")
  fi
  rm -rf "$serial_home"
done

if [ "$fail_count" -gt 0 ]; then
  echo "" >&2
  echo "[serial-tests] $fail_count file(s) failed:" >&2
  for f in "${failed_files[@]}"; do
    echo "  - $f" >&2
  done
  exit 1
fi
echo "[serial-tests] all ${#files[@]} file(s) passed"
