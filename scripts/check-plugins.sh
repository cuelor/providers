#!/bin/sh
# Builds every plugin in providers/ and runs tier A of the conformance suite against it, in the
# command form. Expects the suite at dist/bin/cuelor-provider-test and the SDK built. With no plugins
# it passes.
#
#   scripts/check-plugins.sh           every plugin in providers/
#   scripts/check-plugins.sh NAME...   only these plugins (directory names in providers/)
#
# Test keys (CONTRIBUTING.md): the key of plugin NAME is read from CUELOR_TEST_KEY_<NAME>, NAME in
# upper case with "-" written as "_" (in CI, the GitHub secret of the same name). It reaches the plugin
# as CUELOR_PROVIDER_TEST_KEY, copied by name with --env, so it never appears on a command line. A
# plugin that needs a key fails tier A without one (the catalog answers 403 provider_not_ready).
#
# Mock upstreams: without a test key, a plugin that builds dist-test/mock-upstream.mjs runs tier A
# against that mock instead of its real upstream, so no key and no network are needed. The script starts
# it with `--write-env FILE`; the mock writes NAME=VALUE lines to FILE once it listens (for example the
# upstream's base URL and a key only the mock accepts), and each NAME reaches the plugin with --env NAME.
# With a test key the mock is not used: the plugin runs against its real upstream, as in a release.
# PROVIDERS_DIR overrides providers/ (for testing this script).
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
suite="$root/dist/bin/cuelor-provider-test"
dir=${PROVIDERS_DIR:-providers}

if [ "$#" -eq 0 ]; then
  for p in "$dir"/*/; do
    [ -f "$p/package.json" ] && set -- "$@" "$(basename "$p")"
  done
fi
if [ "$#" -eq 0 ]; then
  echo "no plugins in $dir/"
  exit 0
fi

tmp=$(mktemp -d)
mock_pid=
stop_mock() {
  [ -n "$mock_pid" ] && kill "$mock_pid" 2>/dev/null
  [ -n "$mock_pid" ] && wait "$mock_pid" 2>/dev/null
  mock_pid=
  return 0
}
trap 'stop_mock; rm -rf "$tmp"' EXIT

# Starts the plugin's mock upstream and sets mock_args to "--env NAME" for each variable it exports.
start_mock() {
  rm -f "$tmp/env"
  node "$1" --write-env "$tmp/env" > "$tmp/mock.log" 2>&1 &
  mock_pid=$!
  i=0
  until [ -f "$tmp/env" ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ] || ! kill -0 "$mock_pid" 2>/dev/null; then cat "$tmp/mock.log"; echo "the mock upstream did not start"; return 1; fi
    sleep 0.1
  done
  mock_args=
  while IFS= read -r line; do
    var_name=${line%%=*}
    case "$var_name" in
      "" | [!A-Z_]* | *[!A-Z0-9_]*) echo "the mock upstream wrote an invalid variable name"; return 1 ;;
    esac
    export "$var_name=${line#*=}"
    mock_args="$mock_args --env $var_name"
  done < "$tmp/env"
}

bad=0
for name in "$@"; do
  case "$name" in
    *[!a-z0-9-]* | -* | "") echo "invalid plugin name: $name"; bad=1; continue ;;
  esac
  plugin="$dir/$name"
  var="CUELOR_TEST_KEY_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')"
  eval "key=\${$var:-}"
  echo "== $plugin"
  if ! npm run build --prefix "$plugin"; then
    echo "FAILED: $plugin does not build"
    bad=1
    continue
  fi
  if [ -n "$key" ]; then
    echo "test key: from $var"
    CUELOR_PROVIDER_TEST_KEY=$key "$suite" --manifest "$plugin/dist/cuelor-provider.json" --env CUELOR_PROVIDER_TEST_KEY || bad=1
  elif [ -f "$plugin/dist-test/mock-upstream.mjs" ]; then
    echo "test key: none ($var is not set); against the plugin's mock upstream"
    if start_mock "$plugin/dist-test/mock-upstream.mjs"; then
      # shellcheck disable=SC2086 # mock_args is "--env NAME …" with checked names
      "$suite" --manifest "$plugin/dist/cuelor-provider.json" $mock_args || bad=1
    else
      bad=1
    fi
    stop_mock
  else
    echo "test key: none ($var is not set)"
    "$suite" --manifest "$plugin/dist/cuelor-provider.json" || bad=1
  fi
done
exit "$bad"
