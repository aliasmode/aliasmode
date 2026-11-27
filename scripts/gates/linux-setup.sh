#!/bin/bash
# Sets up the Linux gate host without root: a rootless Xvfb with Mesa llvmpipe, openbox, xdotool, xclip and
# the browsers' system libraries (extracted from Ubuntu packages), plus the stock controls: Google Chrome stable
# (the official google-chrome-stable deb, not Chrome for Testing) and Firefox from Mozilla's release archive.
# Idempotent; run again to refresh. Writes $GATES_TOOLS/env.sh, which gates.mjs sources on Linux.
# Usage: bash scripts/gates/linux-setup.sh [--firefox 159.0.1] [--chrome-channel stable|beta] [--refresh-libs]
#   --chrome-channel beta: Google's own beta deb, for a Chrome major that is stable on Windows/Mac but not yet on Linux.
#   $GATES_TOOLS/stock/chrome points at the last channel installed; older versions stay next to it.
# Env: GATES_TOOLS (default ~/tools/gates).
set -euo pipefail
T=${GATES_TOOLS:-$HOME/tools/gates}
FIREFOX=159.0.1 CHANNEL=stable REFRESH=
while [ $# -gt 0 ]; do case $1 in --firefox) FIREFOX=$2; shift 2;; --chrome-channel) CHANNEL=$2; shift 2;; --refresh-libs) REFRESH=1; shift;; *) echo "unknown option $1" >&2; exit 2;; esac; done
mkdir -p "$T/root" "$T/stock" "$T/debs"
work=$(mktemp -d /tmp/gates-setup.XXXXXX); trap 'rm -rf "$work"' EXIT

# Stock Google Chrome: newest deb of the channel from Google's apt repository.
repo=https://dl.google.com/linux/chrome/deb
line=$(curl -fsS "$repo/dists/stable/main/binary-amd64/Packages" | awk -v p="google-chrome-$CHANNEL" '/^Package:/{n=$2} /^Version:/{v=$2} /^Filename:/{if (n==p) print v, $2}')
cver=${line%% *}; cver=${cver%-*}; cfile=${line#* }
if [ ! -x "$T/stock/chrome-$cver/opt/google/chrome/chrome" ]; then
  echo "Chrome $CHANNEL $cver"
  curl -fsS -o "$work/chrome.deb" "$repo/$cfile"
  rm -rf "$T/stock/chrome-$cver.tmp"; dpkg-deb -x "$work/chrome.deb" "$T/stock/chrome-$cver.tmp"
  dpkg-deb -f "$work/chrome.deb" Depends >"$T/stock/chrome-$cver.tmp/DEPENDS"
  # The beta deb installs to opt/google/chrome-beta; one path for every channel.
  [ -e "$T/stock/chrome-$cver.tmp/opt/google/chrome" ] || ln -s "$(basename "$(dirname "$(ls "$T/stock/chrome-$cver.tmp"/opt/google/*/chrome)")")" "$T/stock/chrome-$cver.tmp/opt/google/chrome"
  mv "$T/stock/chrome-$cver.tmp" "$T/stock/chrome-$cver"
fi
ln -sfn "chrome-$cver" "$T/stock/chrome"

# Stock Firefox, read-only so it cannot stage an update (a policies.json would switch on enterprise mode).
if [ ! -x "$T/stock/firefox-$FIREFOX/firefox/firefox" ]; then
  echo "Firefox $FIREFOX"
  curl -fsS -o "$work/ff.tar.xz" "https://ftp.mozilla.org/pub/firefox/releases/$FIREFOX/linux-x86_64/en-US/firefox-$FIREFOX.tar.xz"
  mkdir -p "$work/ff"; tar -xJf "$work/ff.tar.xz" -C "$work/ff"
  rm -rf "$T/stock/firefox-$FIREFOX"; mv "$work/ff" "$T/stock/firefox-$FIREFOX"
  chmod -R a-w "$T/stock/firefox-$FIREFOX/firefox"
fi
ln -sfn "firefox-$FIREFOX" "$T/stock/firefox"

# Packages the host lacks: X server, input and clipboard tools, Mesa, and both browsers' libraries.
if [ -z "$REFRESH" ] && [ -f "$T/root/.libs-done" ]; then echo "libraries already set up (--refresh-libs to redo)"; else
deps=$(sed 's/([^)]*)//g; s/|[^,]*//g; s/,/ /g' "$T/stock/chrome/DEPENDS")
want="xvfb xauth x11-xkb-utils xkb-data xdotool xclip openbox x11-utils x11-xserver-utils libgl1-mesa-dri libegl-mesa0
  libglx-mesa0 libgl1 libegl1 libgbm1 libxtst6 libgtk-3-0t64 libdbus-glib-1-2 libasound2t64 libx11-xcb1 $deps"
need=()
for p in $(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances $want 2>/dev/null | grep -v '^[ <]' | sort -u); do
  case $p in fonts-*|cdebconf|libdebian-installer4|libtextwrap1|lsb-base|libgs*|poppler-data|debconf*|wget|ca-certificates|xdg-utils) continue;; esac
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || need+=("$p")
done
(cd "$T/debs" && apt-get download "${need[@]}" >/dev/null)
for d in "$T"/debs/*.deb; do dpkg-deb -x "$d" "$T/root"; done
rm -f "$T"/debs/*.deb
touch "$T/root/.libs-done"
fi

# Xvfb runs "/usr/bin/xkbcomp" through the shell; this shim points it at the extracted copy.
cat >"$work/shim.c" <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static char *rewrite(const char *cmd) {
  const char *from = "/usr/bin/xkbcomp", *to = getenv("XKBCOMP_PATH"), *at = cmd ? strstr(cmd, from) : NULL;
  if (!at || !to) return NULL;
  size_t n = strlen(cmd) - strlen(from) + strlen(to) + 1;
  char *out = malloc(n);
  snprintf(out, n, "%.*s%s%s", (int)(at - cmd), cmd, to, at + strlen(from));
  return out;
}
int execl(const char *path, const char *arg, ...) {
  const char *argv[64]; int i = 0; va_list ap; va_start(ap, arg); argv[i++] = arg;
  const char *a; while ((a = va_arg(ap, const char *)) != NULL && i < 63) argv[i++] = a;
  argv[i] = NULL; va_end(ap);
  for (int k = 0; k < i; k++) { char *r = rewrite(argv[k]); if (r) argv[k] = r; }
  return execv(path, (char *const *)argv);
}
FILE *popen(const char *command, const char *type) {
  static FILE *(*real)(const char *, const char *);
  if (!real) real = dlsym(RTLD_NEXT, "popen");
  char *r = rewrite(command);
  return real(r ? r : command, type);
}
EOF
cc -shared -fPIC -O2 -o "$T/xvfb-shim.so" "$work/shim.c" -ldl

R=$T/root
xkb=$R/usr/share/X11/xkb; [ -d "$xkb" ] || xkb=/usr/share/X11/xkb
cat >"$T/env.sh" <<EOF
# Generated by scripts/gates/linux-setup.sh. Source me.
export GATES_TOOLS=$T
export PATH=$R/usr/bin:\$PATH
export LD_LIBRARY_PATH=$R/usr/lib/x86_64-linux-gnu:$R/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}
export LIBGL_DRIVERS_PATH=$R/usr/lib/x86_64-linux-gnu/dri
export __EGL_VENDOR_LIBRARY_DIRS=$R/usr/share/glvnd/egl_vendor.d
export XKBCOMP_PATH=$R/usr/bin/xkbcomp XKB_DIR=$xkb XVFB_SHIM=$T/xvfb-shim.so
export XDG_DATA_DIRS=$R/usr/share:\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}
export CHROME_BIN=$T/stock/chrome/opt/google/chrome/chrome
export FIREFOX_BIN=$T/stock/firefox/firefox/firefox
EOF
. "$T/env.sh"
command -v ffmpeg >/dev/null || echo "note: ffmpeg is not on PATH; screenshots are skipped"
echo "OK: $T (Chrome $("$CHROME_BIN" --version 2>/dev/null | grep -o "[0-9.]*[0-9]"), $CHANNEL, Firefox $FIREFOX, $(du -sh "$T" | cut -f1))"
