#!/usr/bin/env bash
# Build an UNSIGNED .ipa locally on macOS (Xcode required).
# AltStore re-signs the result with your Apple ID, so no certificates are needed.
#
#   bash scripts/build-ipa.sh              -> ./build/FluencyCoach.ipa
#   OUT=~/Desktop/FC.ipa bash scripts/build-ipa.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="${OUT:-$ROOT/build/FluencyCoach.ipa}"
ARCHIVE="$ROOT/build/App.xcarchive"
STAGE="$ROOT/build/stage"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script needs macOS with Xcode installed (xcodebuild is macOS-only)." >&2
  echo "On Windows/Linux use the GitHub Actions workflow: .github/workflows/ios-ipa.yml" >&2
  exit 1
fi
command -v xcodebuild >/dev/null || { echo "xcodebuild not found — install Xcode." >&2; exit 1; }
command -v pod >/dev/null || { echo "CocoaPods not found — run: sudo gem install cocoapods" >&2; exit 1; }

[[ -d node_modules ]] || npm ci
npx cap sync ios

( cd ios/App && pod install --repo-update )

rm -rf "$ARCHIVE" "$STAGE"
mkdir -p "$ROOT/build" "$STAGE"

xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  DEVELOPMENT_TEAM="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  archive

APP_PATH="$ARCHIVE/Products/Applications/App.app"
[[ -d "$APP_PATH" ]] || { echo "No .app produced in $ARCHIVE" >&2; exit 1; }

mkdir -p "$STAGE/Payload"
cp -R "$APP_PATH" "$STAGE/Payload/"
( cd "$STAGE" && zip -qry "$OUT" Payload )

rm -rf "$STAGE"
echo
echo "Unsigned .ipa: $OUT"
echo "Next: AltStore -> My Apps -> + -> pick the .ipa (AltServer must be running)."
