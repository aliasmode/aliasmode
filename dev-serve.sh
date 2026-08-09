#!/usr/bin/env bash
# Dev launcher for AliasMode with a local CloakBrowser binary on WSL2.
#
# CloakBrowser ships a Linux Chromium that dynamically links NSS + ALSA libs
# which aren't installed system-wide in this WSL2 image (and we have no sudo).
# We fetched those .debs and extracted them (non-root) into $EXTRA_LIBS, then
# point LD_LIBRARY_PATH at them. Bun.spawn inherits this process's env, so the
# launched browser resolves the libs too. Windows render on the Windows desktop
# via WSLg ($DISPLAY).
#
# Usage:  ./dev-serve.sh [--port 50400] [--headless]
set -euo pipefail

EXTRA_LIBS="${EXTRA_LIBS:-$HOME/.cloakbrowser/extralibs}"
# `|| true`: under `set -euo pipefail` a missing cloakbrowser makes the pipe exit
# 127, which would abort the script here — before the check below can print the
# install hint. Swallow it so an empty BIN reaches that check instead.
BIN="${CLOAKBROWSER_BINARY_PATH:-$(cloakbrowser info 2>/dev/null | awk -F'  +' '/^Binary:/{print $2}' || true)}"

if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "CloakBrowser binary not found/executable: '${BIN:-unset}'"
  echo "Run:  cloakbrowser install"
  exit 1
fi

export CLOAKBROWSER_BINARY_PATH="$BIN"
export LD_LIBRARY_PATH="$EXTRA_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
echo "[dev-serve] binary:          $BIN"
echo "[dev-serve] LD_LIBRARY_PATH: $LD_LIBRARY_PATH"
exec bun cli.ts serve "$@"
