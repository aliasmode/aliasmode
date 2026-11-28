#!/bin/bash
# Installs AliasMode for Linux (x64) from a GitHub Release into your home folder.
#   install-linux.sh [--version <version>] [--agent-setup]
# --agent-setup also connects installed AI agent clients and prints the helper's JSON result.
# Missing system libraries and the Chrome sandbox permission need your password once (sudo).
set -euo pipefail

repo="https://github.com/aliasmode/aliasmode"
# A local file:// base lets the build pipeline test an unpublished release.
base="${ALIASMODE_RELEASE_BASE:-$repo/releases/download}"
version=""
agent_setup=0

fail() {
  echo "AliasMode install failed: $1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || fail "--version needs a value"; version="$2"; shift 2 ;;
    --agent-setup) agent_setup=1; shift ;;
    *) fail "unknown option $1" ;;
  esac
done

[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || fail "this installer needs Linux on a 64-bit Intel or AMD processor"
[[ "$(id -u)" != 0 ]] || fail "run this command as your normal user, not as root"
[[ -n "${HOME:-}" ]] || fail "HOME is not set"

# The same folder that the app and its agent helper read (XDG data home).
data_home="${XDG_DATA_HOME:-}"
[[ "$data_home" == /* ]] || data_home="$HOME/.local/share"
root="$data_home/aliasmode"
helper="$root/bin/aliasmode-mcp"

as_root() {
  if command -v sudo >/dev/null; then
    sudo "$@"
  else
    fail "this step needs administrator rights, and sudo is not available: $*"
  fi
}

has_library() {
  /sbin/ldconfig -p 2>/dev/null | grep -q "^[[:space:]]*$1 " \
    || ldconfig -p 2>/dev/null | grep -q "^[[:space:]]*$1 "
}

# The app window needs WebKitGTK 4.1; the Chrome runtimes need the usual desktop libraries,
# and Chromium 159 arrives as a zstd archive.
apt_package() {
  # Ubuntu 24.04 renamed several libraries with a t64 suffix; the old name is then virtual.
  local name
  for name in "$@"; do
    if apt-cache show "$name" 2>/dev/null | grep -q '^Version:'; then
      echo "$name"
      return
    fi
  done
  echo "$1"
}

install_system_packages() {
  local missing=() library
  for library in libwebkit2gtk-4.1.so.0 libnss3.so libgbm.so.1 libasound.so.2 libatk-bridge-2.0.so.0 \
    libcups.so.2 libxkbcommon.so.0 libXcomposite.so.1 libXdamage.so.1 libXrandr.so.2; do
    has_library "$library" || missing+=("$library")
  done
  command -v zstd >/dev/null || missing+=(zstd)
  [[ ${#missing[@]} -gt 0 ]] || return 0
  echo "AliasMode needs these system parts: ${missing[*]}"
  if command -v apt-get >/dev/null; then
    as_root apt-get update -q
    as_root apt-get install -y -q libwebkit2gtk-4.1-0 libnss3 libgbm1 "$(apt_package libasound2t64 libasound2)" \
      "$(apt_package libatk-bridge2.0-0t64 libatk-bridge2.0-0)" "$(apt_package libcups2t64 libcups2)" \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 zstd
  elif command -v dnf >/dev/null; then
    as_root dnf install -y webkit2gtk4.1 nss mesa-libgbm alsa-lib at-spi2-atk cups-libs libxkbcommon \
      libXcomposite libXdamage libXrandr zstd
  elif command -v pacman >/dev/null; then
    as_root pacman -S --needed --noconfirm webkit2gtk-4.1 nss mesa alsa-lib at-spi2-core libcups libxkbcommon \
      libxcomposite libxdamage libxrandr zstd
  elif command -v zypper >/dev/null; then
    as_root zypper --non-interactive install libwebkit2gtk-4_1-0 mozilla-nss libgbm1 libasound2 libatk-bridge-2_0-0 \
      libcups2 libxkbcommon0 libXcomposite1 libXdamage1 libXrandr2 zstd
  else
    fail "install these with your package manager, then run this command again: ${missing[*]}"
  fi
}

# Ubuntu 23.10 and later let a program create the user namespace of Chrome's sandbox only
# when an AppArmor profile allows it. The Chrome runtimes that AliasMode downloads get one.
apparmor_profile="/etc/apparmor.d/aliasmode-chromium"
allow_chrome_sandbox() {
  [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == 1 ]] || return 0
  [[ -f "$apparmor_profile" ]] && return 0
  echo "AliasMode allows its Chrome runtimes to start their sandbox (AppArmor profile $apparmor_profile)."
  as_root tee "$apparmor_profile" >/dev/null <<'PROFILE'
# AliasMode: the Chrome runtimes that AliasMode downloads may create the user namespace of their sandbox.
abi <abi/4.0>,
include <tunables/global>

profile aliasmode-chromium @{HOME}/.local/share/com.aliasmode.desktop/runtimes/*/chrome flags=(unconfined) {
  userns,

  include if exists <local/aliasmode-chromium>
}
PROFILE
  # AppArmor before version 4 (Ubuntu 22.04) has no rule that allows user namespaces.
  if ! as_root apparmor_parser -r "$apparmor_profile" \
    || ! as_root grep -q "^aliasmode-chromium " /sys/kernel/security/apparmor/profiles; then
    as_root rm -f "$apparmor_profile"
    echo "AliasMode warning: AppArmor on this computer cannot allow the Chrome sandbox, so Chrome profiles cannot open. Firefox profiles work." >&2
  fi
}

installed_version() {
  [[ -x "$helper" ]] && "$helper" version 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

# The app, its sidecar, and the Firefox engine and Node processes all run from the app folder.
running() {
  local pid
  for pid in $(pgrep -f -- "$root/" 2>/dev/null || true); do
    [[ "$(readlink "/proc/$pid/exe" 2>/dev/null || true)" == "$root/"* ]] && return 0
  done
  return 1
}

# Everything runs from main, so `curl | bash` has read the whole script before a package
# manager could read from the same input.
main() {
if [[ -z "$version" ]]; then
  # The newest release that has a Linux build; the API lists releases newest first.
  version="$(curl -fsSL "https://api.github.com/repos/aliasmode/aliasmode/releases?per_page=20" \
    | grep -o 'AliasMode_[^"/]*_x86_64-linux\.tar\.gz' | head -n 1 \
    | sed -e 's/^AliasMode_//' -e 's/_x86_64-linux\.tar\.gz$//')" || true
  [[ -n "$version" ]] || fail "no Linux release was found"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "the version is not valid"

install_system_packages
allow_chrome_sandbox

if [[ "$(installed_version || true)" != "$version" ]]; then
  running && fail "AliasMode is open. Quit AliasMode, then run this command again"
  mkdir -p "$data_home"
  # Unpacked beside the app folder, so the swap stays on one file system.
  work="$(mktemp -d "$data_home/.aliasmode-install.XXXXXX")"
  # An interrupted swap puts the previous app back.
  trap '[[ -e "$root" || ! -e "$work/previous" ]] || mv "$work/previous" "$root"; rm -rf "$work"' EXIT
  archive="AliasMode_${version}_x86_64-linux.tar.gz"
  curl -fsSL -o "$work/SHA256SUMS-linux.txt" "$base/v$version/SHA256SUMS-linux.txt" \
    || fail "version $version has no Linux build"
  curl -fL --progress-bar -o "$work/$archive" "$base/v$version/$archive" || fail "the download did not complete"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$work/SHA256SUMS-linux.txt")"
  actual="$(sha256sum "$work/$archive" | awk '{ print $1 }')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]] || fail "the download did not match its published SHA-256"
  mkdir "$work/new"
  tar -xzf "$work/$archive" -C "$work/new" --strip-components=1
  rm -f "$work/$archive"
  [[ -x "$work/new/bin/aliasmode" ]] || fail "the downloaded app is damaged"
  [[ ! -e "$root" ]] || mv "$root" "$work/previous"
  if ! mv "$work/new" "$root"; then
    [[ ! -e "$work/previous" ]] || mv "$work/previous" "$root"
    fail "the app folder could not be replaced"
  fi
  rm -rf "$work"
  trap - EXIT
  [[ "$(installed_version || true)" == "$version" ]] || fail "the installed app did not report version $version"
fi

# Firefox loads its own libraries from its folder, as its launcher does.
missing="$(LD_LIBRARY_PATH="$root/lib/AliasMode/firefox" ldd "$root/bin/aliasmode" "$root/lib/AliasMode/firefox/libxul.so" 2>/dev/null \
  | awk '/not found/ { print $1 }' | sort -u | tr '\n' ' ')"
[[ -z "$missing" ]] || fail "these system libraries are still missing: $missing"

applications="$data_home/applications"
mkdir -p "$applications"
cat > "$applications/aliasmode.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=AliasMode
Comment=Browser profiles with separate identities
Exec="$root/bin/aliasmode"
Icon=$root/share/icons/hicolor/512x512/apps/aliasmode.png
Terminal=false
Categories=Network;
StartupWMClass=aliasmode
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$applications" >/dev/null 2>&1 || true

if [[ "$agent_setup" == 1 ]]; then
  exec "$helper" setup --client auto --yes --json
fi
echo "AliasMode $version is installed in $root. Open it from your app menu."
}

main
