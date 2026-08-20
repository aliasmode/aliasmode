#!/bin/bash
set -euo pipefail

if [[ $# -ne 2 || ($2 != blocked && $2 != trusted) ]]; then
  echo "usage: $0 <dmg> <blocked|trusted>" >&2
  exit 64
fi

readonly dmg=$1
readonly expected=$2
readonly installed="/Applications/AliasMode.app"
for command in codesign ditto file hdiutil open osascript pgrep spctl syspolicy_check uuidgen xattr xcrun; do
  command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 1; }
done
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo "Apple Silicon macOS is required" >&2; exit 1; }
[[ -f $dmg ]] || { echo "DMG is missing: $dmg" >&2; exit 1; }
[[ $(spctl --status) == "assessments enabled" ]] || { echo "Gatekeeper assessments are disabled" >&2; exit 1; }
[[ ! -e $installed ]] || { echo "$installed already exists" >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aliasmode-accept.XXXXXX")
mount="$work/mount"
mkdir "$mount"
mounted=false
installed_created=false
app_pid=""
sidecar_pid=""
cleanup() {
  set +e
  [[ -z $sidecar_pid ]] || kill "$sidecar_pid" 2>/dev/null
  [[ -z $app_pid ]] || kill "$app_pid" 2>/dev/null
  $mounted && hdiutil detach "$mount" -quiet
  $installed_created && sudo rm -rf "$installed"
  rm -rf "$work"
}
trap cleanup EXIT

quarantine="0083;$(printf '%x' "$(date +%s)");AliasModeCI;$(uuidgen)"
xattr -w com.apple.quarantine "$quarantine" "$dmg"
xattr -p com.apple.quarantine "$dmg" >/dev/null
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
mounted=true
[[ -d $mount/AliasMode.app ]] || { echo "DMG does not contain AliasMode.app" >&2; exit 1; }
installed_created=true
sudo ditto "$mount/AliasMode.app" "$installed"
sudo xattr -w com.apple.quarantine "$quarantine" "$installed"
sudo xattr -p com.apple.quarantine "$installed" >/dev/null
hdiutil detach "$mount" -quiet
mounted=false
codesign --verify --deep --strict --verbose=4 "$installed"

required=(
  "$installed/Contents/MacOS/aliasmode"
  "$installed/Contents/MacOS/aliasmode-sidecar"
  "$installed/Contents/Resources/playwright/node/node"
  "$installed/Contents/Resources/cloakbrowser/Chromium.app/Contents/MacOS/Chromium"
)
for executable in "${required[@]}"; do
  [[ -f $executable ]] || { echo "packaged executable is missing: $executable" >&2; exit 1; }
  file "$executable" | grep -q 'Mach-O.*arm64' || { echo "packaged executable is not arm64: $executable" >&2; exit 1; }
done

mach_o_count=0
unsigned_count=0
while IFS= read -r -d '' candidate; do
  description=$(file "$candidate")
  [[ $description == *Mach-O* ]] || continue
  mach_o_count=$((mach_o_count + 1))
  echo "$description"
  if ! codesign --display --verbose=2 "$candidate" 2>&1; then
    unsigned_count=$((unsigned_count + 1))
  fi
done < <(find "$installed" -type f \( -perm -111 -o -name '*.dylib' -o -name '*.so' -o -name '*.node' \) -print0)
[[ $mach_o_count -gt 0 && $unsigned_count -eq 0 ]] || { echo "nested code inventory found unsigned Mach-O files" >&2; exit 1; }

set +e
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
dmg_policy=$?
syspolicy_check distribution "$installed" 2>&1 | tee "$work/distribution-policy.txt"
distribution_policy=${PIPESTATUS[0]}
spctl --assess --type execute --verbose=4 "$installed"
execute_policy=$?
set -e

if [[ $expected == blocked ]]; then
  [[ $distribution_policy -ne 0 ]] && grep -q 'failed one or more pre-distribution checks' "$work/distribution-policy.txt" || {
    echo "syspolicy_check failed without a policy rejection (status: $distribution_policy)" >&2
    exit 1
  }
  [[ $execute_policy -eq 3 ]] || {
    echo "spctl did not report a policy rejection (status: $execute_policy)" >&2
    exit 1
  }
  echo "Gatekeeper rejected the quarantined ad-hoc app as expected (DMG policy: $dmg_policy)"
  exit 0
fi

[[ $dmg_policy -eq 0 && $distribution_policy -eq 0 && $execute_policy -eq 0 ]] || {
  echo "trusted distribution failed Gatekeeper assessment" >&2
  exit 1
}
xcrun stapler validate "$dmg"
xcrun stapler validate "$installed"
open -n "$installed"
for _ in {1..60}; do
  app_pid=$(pgrep -f "^$installed/Contents/MacOS/aliasmode( |$)" | head -n 1 || true)
  [[ -z $app_pid ]] || sidecar_pid=$(pgrep -P "$app_pid" -f 'aliasmode-sidecar' | head -n 1 || true)
  [[ -z $app_pid || -z $sidecar_pid ]] || break
  sleep 0.5
done
[[ -n $app_pid && -n $sidecar_pid ]] || { echo "installed app did not become ready" >&2; exit 1; }
osascript -e 'tell application id "com.aliasmode.desktop" to quit'
for _ in {1..60}; do
  kill -0 "$app_pid" 2>/dev/null || break
  sleep 0.5
done
! kill -0 "$app_pid" 2>/dev/null || { echo "installed app did not quit" >&2; exit 1; }
! kill -0 "$sidecar_pid" 2>/dev/null || { echo "packaged sidecar survived app shutdown" >&2; exit 1; }
app_pid=""
sidecar_pid=""
echo "quarantined AliasMode distribution passed installed-app acceptance"
