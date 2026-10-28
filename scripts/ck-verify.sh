#!/bin/sh
# Repository checks. Each check is a name and a command, run in order from the repository root; the
# report goes to CK_TEST_REPORT when set ({status, summary, checks:[{name, status, duration_ms}]}).
# The output of each check is kept in dist/ck-verify/<name>.log and its tail printed when it fails.
# Needs: go, node 24 (with npm), perl, git and tar. ffprobe is optional (outputs are then not decoded).
# plugins-tier-a runs tier A against every plugin in providers/, with its test key from
# CUELOR_TEST_KEY_<NAME> when set, else against the plugin's mock upstream (scripts/check-plugins.sh).
# The openrouter checks run the OpenRouter plugin's tests and tiers A, B and C against its mock
# OpenRouter, without a key or network (providers/openrouter/scripts/check-mock.sh).
set -u
cd "$(dirname "$0")/.."

checks='
skeleton|test -f README.md && test -f LICENSE && test -f AGENTS.md && test -f CONTRIBUTING.md && grep -q "Apache License" LICENSE
leak-scan|node scripts/scan-repo.mjs
leak-scan-tests|node --test scripts/scan-repo.test.mjs
export-public-tests|node --test scripts/export-public.test.mjs
install-ffprobe-tests|sh scripts/install-ffprobe.test.sh
spec|cd tools && go run ./speccheck -spec ../spec registry-index=../registry/index.json
schemas-in-sync|diff -r spec/schemas conformance/schemas
conformance-vet|cd conformance && go vet ./... && ! gofmt -l . | grep .
conformance-tests|cd conformance && go test -count=1 ./...
tools-vet|cd tools && go vet ./... && ! gofmt -l . | grep .
build-suite|cd conformance && go build -o ../dist/bin/cuelor-provider-test ./cmd/cuelor-provider-test
npm-ci|npm ci --no-audit --no-fund
sdk|npm run typecheck -w sdk/typescript && npm run build -w sdk/typescript && npm test -w sdk/typescript
fake-provider|npm run typecheck -w examples/fake-provider && npm run build -w examples/fake-provider && npm test -w examples/fake-provider
fake-tier-a|sh scripts/check-fake.sh tier-a
fake-tier-bc|sh scripts/check-fake.sh live
fake-url-form|sh scripts/check-fake.sh url
faults-detected|sh scripts/check-fake.sh faults
openrouter|npm run typecheck -w providers/openrouter && npm run build -w providers/openrouter && npm test -w providers/openrouter
openrouter-mock-bc|sh providers/openrouter/scripts/check-mock.sh live
openrouter-faults|sh providers/openrouter/scripts/check-mock.sh faults
plugins-tier-a|sh scripts/check-plugins.sh
'

now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time() * 1000'; }

logs=dist/ck-verify
mkdir -p "$logs"
passed=0
failed=0
entries=''
IFS='
'
for line in $checks; do
  [ -z "$line" ] && continue
  name=${line%%|*}
  cmd=${line#*|}
  start=$(now_ms)
  if (unset IFS; sh -c "$cmd") > "$logs/$name.log" 2>&1; then
    status=passed
    passed=$((passed + 1))
  else
    status=failed
    failed=$((failed + 1))
  fi
  ms=$(( $(now_ms) - start ))
  echo "$status: $name (${ms} ms)"
  if [ "$status" = failed ]; then
    tail -n 30 "$logs/$name.log" | sed 's/^/    /'
  fi
  entries="$entries${entries:+,}{\"name\":\"$name\",\"status\":\"$status\",\"duration_ms\":$ms}"
done

total=$((passed + failed))
overall=passed
[ "$failed" -gt 0 ] && overall=failed
if [ -n "${CK_TEST_REPORT:-}" ]; then
  printf '{"status":"%s","summary":"%s / %s checks passed","checks":[%s]}\n' "$overall" "$passed" "$total" "$entries" > "$CK_TEST_REPORT"
fi
echo "$passed / $total checks passed"
[ "$failed" -eq 0 ]
