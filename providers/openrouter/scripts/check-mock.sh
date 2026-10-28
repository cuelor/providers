#!/bin/sh
# Runs the conformance suite against the OpenRouter plugin and the mock OpenRouter (test/mock-openrouter.ts):
# no key, no network, no cost. Expects the suite at dist/bin/cuelor-provider-test (repository root) and
# the plugin built (npm run build).
#
#   scripts/check-mock.sh live     tiers A, B and C in the command form
#   scripts/check-mock.sh faults   the build without idempotency records must fail B2 and B6
#                                  (VERBOSE=1 prints the report)
set -eu
cd "$(dirname "$0")/.."
plugin=$(pwd)
suite="$plugin/../../dist/bin/cuelor-provider-test"
tmp=$(mktemp -d)
mock_pid=
trap '[ -n "$mock_pid" ] && kill "$mock_pid" 2>/dev/null; rm -rf "$tmp"' EXIT

node dist-test/mock-upstream.mjs --write-env "$tmp/env" > "$tmp/mock.log" 2>&1 &
mock_pid=$!
i=0
until [ -f "$tmp/env" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then cat "$tmp/mock.log"; echo "the mock OpenRouter did not start"; exit 1; fi
  sleep 0.1
done
OPENROUTER_BASE_URL=$(sed -n 's/^OPENROUTER_BASE_URL=//p' "$tmp/env")
CUELOR_PROVIDER_TEST_KEY=$(sed -n 's/^CUELOR_PROVIDER_TEST_KEY=//p' "$tmp/env")
export OPENROUTER_BASE_URL CUELOR_PROVIDER_TEST_KEY
env="--env OPENROUTER_BASE_URL --env CUELOR_PROVIDER_TEST_KEY"

case "${1:-}" in
live)
  # The mock bills by its own pricing_skus; the whole run is about 0.5 USD of pretend money.
  # shellcheck disable=SC2086
  "$suite" --manifest dist/cuelor-provider.json $env --live --max-cost 2 --job-timeout 2m
  ;;
faults)
  # shellcheck disable=SC2086
  out=$("$suite" --dir dist-test --command "node faulty-provider.mjs --fault=no-idempotency-records" --manifest dist-test/cuelor-provider.json \
    $env --only B2,B6 --live --max-cost 2 --job-timeout 2m --output json 2>&1) && code=0 || code=$?
  bad=0
  for check in B2 B6; do
    if printf '%s' "$out" | tr -d '\n' | grep -Eq "\"id\": \"$check\"[^}]*\"status\": \"failed\""; then
      echo "caught (as expected): fault no-idempotency-records makes $check fail"
    else
      echo "NOT CAUGHT: fault no-idempotency-records should make $check fail (exit $code)"
      bad=1
    fi
  done
  if [ "$bad" -ne 0 ] || [ -n "${VERBOSE:-}" ]; then printf '%s\n' "$out" | tail -40; fi
  exit "$bad"
  ;;
*)
  echo "usage: $0 live|faults" >&2
  exit 2
  ;;
esac
