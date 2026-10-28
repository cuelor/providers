#!/bin/sh
# Tests for scripts/install-ffprobe.sh with stub commands on PATH: root without sudo (container runners),
# a user with sudo (hosted runners), a user without sudo, and ffprobe already installed.
set -u
cd "$(dirname "$0")/.."
script="$(pwd)/scripts/install-ffprobe.sh"
fail=0

# setup UID SUDO FFPROBE: a directory of stubs; apt-get and sudo append their arguments to calls.log.
setup() {
  d=$(mktemp -d)
  for t in sh env cat; do ln -s "$(command -v $t)" "$d/$t"; done
  printf '#!/bin/sh\n[ "$1" = -u ] && echo %s\n' "$1" > "$d/id"
  printf '#!/bin/sh\necho "apt-get $*" >> "%s/calls.log"\n' "$d" > "$d/apt-get"
  [ "$2" = yes ] && printf '#!/bin/sh\necho "sudo $1" >> "%s/calls.log"\nexec "$@"\n' "$d" > "$d/sudo"
  [ "$3" = yes ] && printf '#!/bin/sh\n' > "$d/ffprobe"
  chmod +x "$d"/*
  echo "$d"
}

# check NAME WANT_STATUS WANT_CALLS UID SUDO FFPROBE
check() {
  d=$(setup "$4" "$5" "$6")
  PATH="$d" "$d/sh" "$script" > "$d/out.log" 2>&1
  status=$?
  calls=$(cat "$d/calls.log" 2>/dev/null | tr '\n' ';')
  if [ "$status" -ne "$2" ] || [ "$calls" != "$3" ]; then
    echo "FAIL: $1: status $status, calls '$calls'; want $2, '$3'"
    sed 's/^/    /' "$d/out.log"
    fail=1
  else
    echo "ok: $1"
  fi
  rm -rf "$d"
}

install='apt-get install -y --no-install-recommends ffmpeg'
check "root without sudo" 0 "apt-get update;$install;" 0 no no
check "user with sudo" 0 "sudo apt-get;apt-get update;sudo env;$install;" 1001 yes no
check "user without sudo" 1 "" 1001 no no
check "ffprobe already installed" 0 "" 1001 no yes
exit "$fail"
