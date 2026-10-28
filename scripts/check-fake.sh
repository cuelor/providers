#!/bin/sh
# Runs the conformance suite against the example fake provider. Expects the suite at
# dist/bin/cuelor-provider-test and the example built (npm run build).
#
#   scripts/check-fake.sh tier-a   tier A in the command form
#   scripts/check-fake.sh live     tiers A, B and C in the command form (the fake costs nothing)
#   scripts/check-fake.sh url      tiers A, B and C in the URL form, against the standalone mode
#   scripts/check-fake.sh faults   checks that the suite catches each deliberately broken build: the
#                                  build's check must fail. A caught fault prints "caught", which is a pass
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
suite="$root/dist/bin/cuelor-provider-test"
example="$root/examples/fake-provider"

# fault:check pairs. Each fault of dist-test/faulty-provider.mjs breaks one rule of one check.
faults='
no-auth:A2
short-binding:A1
ignore-stdin:A3
unchecked-references:A6
wrong-sha256:A7
unknown-job-500:A8
new-job-same-key:B2
no-conflict:B3
garbled-transcript:C1
catalog-shapes:A5
'

case "${1:-}" in
tier-a)
  "$suite" --manifest "$example/dist/cuelor-provider.json"
  ;;
live)
  "$suite" --manifest "$example/dist/cuelor-provider.json" --live --max-cost 0 --job-timeout 2m
  ;;
url)
  tmp=$(mktemp -d)
  trap 'kill "$pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT
  node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))' > "$tmp/token"
  port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  mkdir "$tmp/data"
  CUELOR_PROVIDER_LISTEN="127.0.0.1:$port" CUELOR_PROVIDER_TOKEN_FILE="$tmp/token" \
    CUELOR_PROVIDER_ALLOWED_HOSTS="127.0.0.1:$port" CUELOR_PROVIDER_DATA_DIR="$tmp/data" \
    node "$example/dist/provider.mjs" > "$tmp/log" 2>&1 &
  pid=$!
  i=0
  until node -e 'require("net").connect(process.argv[1],"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))' "$port"; do
    i=$((i + 1))
    if [ "$i" -gt 50 ]; then cat "$tmp/log"; echo "the standalone fake did not start"; exit 1; fi
    sleep 0.2
  done
  "$suite" --url "http://127.0.0.1:$port" --token-file "$tmp/token" --live --max-cost 0 --job-timeout 2m
  ;;
faults)
  bad=0
  for pair in $faults; do
    fault=${pair%%:*}
    check=${pair#*:}
    out=$("$suite" --dir "$example" --command "node dist-test/faulty-provider.mjs --fault=$fault" \
      --only "$check" --live --max-cost 0 --job-timeout 2m --output json 2>&1) && code=0 || code=$?
    if [ "$code" -eq 1 ] && printf '%s' "$out" | grep -q '"status": "failed"'; then
      echo "caught (as expected): fault $fault makes $check fail"
    else
      echo "NOT CAUGHT: fault $fault should make $check fail, but it did not (exit $code)"
      printf '%s\n' "$out" | tail -20
      bad=1
    fi
  done
  exit "$bad"
  ;;
*)
  echo "usage: $0 tier-a|live|url|faults" >&2
  exit 2
  ;;
esac
