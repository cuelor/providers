#!/bin/sh
# Installs ffprobe (from ffmpeg) on a Debian or Ubuntu CI runner. Hosted runners run as a user with sudo;
# container runners (act, Gitea) run as root and have no sudo, so sudo is used only when not root.
set -eu
if command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe is already installed"
  exit 0
fi
if [ "$(id -u)" -eq 0 ]; then
  as_root=''
elif command -v sudo >/dev/null 2>&1; then
  as_root=sudo
else
  echo "installing ffmpeg needs root or sudo" >&2
  exit 1
fi
$as_root apt-get update
$as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg
