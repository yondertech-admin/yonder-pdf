#!/usr/bin/env bash
# Build, code-sign (Developer ID from the login keychain) and upload the macOS
# installers for the version in package.json to the matching GitHub Release.
# Windows/Linux installers come from the release workflow when the tag is pushed.
#
#   scripts/release-mac.sh            # build + upload
#   NOTARIZE=1 scripts/release-mac.sh # additionally notarize (needs `xcrun notarytool store-credentials yonder-notary` once)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
export CSC_IDENTITY_AUTO_DISCOVERY=true
if [[ "${NOTARIZE:-0}" == "1" ]]; then
  export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-yonder-notary}"
  NOTARIZE_FLAG='--config.mac.notarize=true'
else
  NOTARIZE_FLAG='--config.mac.notarize=false'
fi
npm run build
npx electron-builder --mac dmg zip --arm64 --x64 --publish never "$NOTARIZE_FLAG"
codesign --verify --deep --strict --verbose=1 "release/mac-arm64/Yonder PDF.app" 2>&1 | tail -1
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "Yonder PDF $VERSION" --notes "See CHANGELOG / commits." --draft=false
gh release upload "$TAG" --clobber release/*.dmg release/*.zip release/*.blockmap release/latest-mac.yml
echo "uploaded macOS assets to $TAG"
