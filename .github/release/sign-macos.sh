#!/usr/bin/env bash
# sign-macos.sh <unsigned Ballast.app.zip> <out dir>: signs Ballast.app inside-out with the
# Developer ID identity (hardened runtime, secure timestamp), wraps it in a signed DMG and notarizes
# that once (the service issues tickets for the DMG and the app inside it), then writes:
#   Ballast-<version>-macos-arm64.zip  (root Ballast.app, stapled, for the updater: Squirrel.Mac)
#   Ballast-<version>-macos-arm64.dmg  (signed, notarized and stapled, with an /Applications link)
#
# Environment: VERSION, APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER_ID (team keys only; empty for an
# individual key), and BALLAST_KEYCHAIN, BALLAST_SIGNING_IDENTITY, BALLAST_NOTARY_KEY from
# macos-credentials.sh.
. "$(dirname "$0")/lib.sh"

input=$1
out=$2
release=$(cd "$(dirname "$0")" && pwd)
: "${APPLE_NOTARY_KEY_ID:?The release environment has no APPLE_NOTARY_KEY_ID.}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
zip="$out/Ballast-$VERSION-macos-arm64.zip"
dmg="$out/Ballast-$VERSION-macos-arm64.dmg"

/usr/bin/ditto -x -k "$input" "$work/unpacked"
app="$work/unpacked/Ballast.app"
if [ ! -d "$app" ] || [ "$(find "$work/unpacked" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" != 1 ]; then
  die "The macOS build archive must hold exactly Ballast.app."
fi
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$VERSION" ] ||
  die "Ballast.app is not version $VERSION."
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")" = Ballast ] ||
  die "Ballast.app has an unexpected executable."

sign() {
  codesign --force --timestamp --options runtime --entitlements "$release/ballast.entitlements" \
    --keychain "$BALLAST_KEYCHAIN" --sign "$BALLAST_SIGNING_IDENTITY" "$1"
}
notary=(--key "$BALLAST_NOTARY_KEY" --key-id "$APPLE_NOTARY_KEY_ID")
[ -z "${APPLE_NOTARY_ISSUER_ID:-}" ] || notary+=(--issuer "$APPLE_NOTARY_ISSUER_ID")
notarize() {
  xcrun notarytool submit "$1" "${notary[@]}" --wait --timeout 60m --output-format json > "$work/notary.json"
  cat "$work/notary.json"
  [ "$(jq -r .status "$work/notary.json")" = Accepted ] || die "Notarization of $(basename "$1") was not accepted."
}

# Every nested Mach-O file (Electron, its helpers and frameworks, and the agent service's native
# addons and tsgo under Contents/Resources/service) and bundle, deepest first, then the app.
list=$(mktemp)
{
  find "$app/Contents" -type f -print0 | while IFS= read -r -d '' file; do
    case "$(file -b --mime-type "$file")" in application/x-mach-binary*) printf '%s\n' "$file" ;; esac
  done
  find "$app/Contents" -type d \( -name '*.app' -o -name '*.framework' \) -print
} | awk -F/ '{ print NF "\t" $0 }' | sort -t "$(printf '\t')" -k1,1nr | cut -f2- > "$list"
echo "Signing $(wc -l < "$list" | tr -d ' ') items in Ballast.app"
while IFS= read -r item; do sign "$item"; done < "$list"
sign "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# One notarization covers both: the DMG's ticket for the DMG, and the app's own ticket (looked up
# by its code directory hash) for the app it holds.
rm -f "$zip" "$dmg"
mkdir "$work/staging"
/usr/bin/ditto "$app" "$work/staging/Ballast.app"
ln -s /Applications "$work/staging/Applications"
hdiutil create -quiet -fs APFS -format ULFO -volname Ballast -srcfolder "$work/staging" "$dmg"
codesign --force --timestamp --keychain "$BALLAST_KEYCHAIN" --sign "$BALLAST_SIGNING_IDENTITY" "$dmg"
notarize "$dmg"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"

xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
codesign -dv "$app" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Authority=Developer)' || true
ls -l "$out"
