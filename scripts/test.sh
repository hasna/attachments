#!/usr/bin/env bash
# Run each test file in its own process to prevent mock.module() leakage between files.
# This is necessary because Bun 1.x shares the module cache across test files when
# running them together, causing mock.module() calls in one file to contaminate another.

set -e

PASS=0
FAIL=0
EXIT_CODE=0

COVERAGE_FLAG=""
if [[ "$1" == "--coverage" ]]; then
  COVERAGE_FLAG="--coverage"
fi

TEST_FILES=(
  "src/core/db.test.ts"
  "src/core/config.test.ts"
  "src/core/s3.test.ts"
  "src/core/links.test.ts"
  "src/core/upload.test.ts"
  "src/core/download.test.ts"
  "src/api/server.test.ts"
  "src/mcp/server.test.ts"
  "src/cli/commands/config.test.ts"
  "src/cli/commands/upload.test.ts"
  "src/cli/commands/download.test.ts"
  "src/cli/commands/list.test.ts"
  "src/cli/commands/delete.test.ts"
  "src/cli/commands/link.test.ts"
  "src/cli/commands/serve.test.ts"
  "src/cli/commands/mcp.test.ts"
  "sdk/src/index.test.ts"
)

for file in "${TEST_FILES[@]}"; do
  if bun test $COVERAGE_FLAG "$file" 2>&1; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    EXIT_CODE=1
  fi
done

echo ""
echo "Test files: $((PASS + FAIL)) total, $PASS passed, $FAIL failed"
exit $EXIT_CODE
