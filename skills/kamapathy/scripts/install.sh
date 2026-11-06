#!/bin/sh
# Installs Kamapathy from its GitHub releases on macOS or Linux, without sudo
# and without touching quarantine attributes. Keep this file POSIX sh and
# ASCII: site/install.sh is a byte-identical copy, served from kamapathy.app
# and run as "curl -fsSL https://kamapathy.app/install.sh | sh".
#
# Options: --dir <folder>, --no-open, --deb (Linux).
# Progress goes to stderr. The last line of output is "installed <path>",
# "already installed <path>" or "downloaded <path>". Exit status: 0 done,
# 1 download, checksum, verification or copy failure, 2 unknown option,
# 3 unsupported system.
set -eu

REPO=shayanmohd/kamapathy
BUNDLE_ID=app.kamapathy.browser
# The Developer ID team to pin, once builds are signed. Empty means no signer.
TEAM_ID=
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

DIR=
OPEN=1
DEB=0
TMP=
MOUNT=
STAGE=

say() {
  printf 'Kamapathy install: %s\n' "$1" >&2
}

die() {
  say "$1"
  exit "$2"
}

# Escapes a fixed string for a sed basic regular expression with | as its
# delimiter.
quote() {
  printf '%s' "$1" | sed 's/[.[\*^$|]/\\&/g'
}

# True when the first version is at least the second, by number per part.
version_ge() {
  awk -v left="$1" -v right="$2" 'BEGIN {
    parts = split(left, mine, ".")
    wanted = split(right, theirs, ".")
    if (wanted > parts) parts = wanted
    for (part = 1; part <= parts; part++) {
      if (mine[part] + 0 > theirs[part] + 0) exit 0
      if (mine[part] + 0 < theirs[part] + 0) exit 1
    }
    exit 0
  }'
}

start_app() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$1" >/dev/null 2>&1 &
  else
    nohup "$1" >/dev/null 2>&1 &
  fi
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null ||
    true
}

while [ $# -gt 0 ]; do
  case $1 in
    --dir)
      if [ $# -lt 2 ]; then die "--dir needs a folder." 2; fi
      DIR=$2
      shift 2
      ;;
    --no-open)
      OPEN=0
      shift
      ;;
    --deb)
      DEB=1
      shift
      ;;
    *)
      die "$1 is not an option. Use --dir <folder>, --no-open or --deb." 2
      ;;
  esac
done

SYSTEM=$(uname -s)
MACHINE=$(uname -m)
case $SYSTEM in
  Darwin)
    if [ "$DEB" = 1 ]; then die "--deb installs the Linux package." 2; fi
    # A Rosetta shell reports x86_64 and still wants the arm64 build.
    if [ "$MACHINE" = arm64 ] ||
      [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
      ASSET=mac-arm64.dmg
    else
      ASSET=mac-x64.dmg
    fi
    ;;
  Linux)
    if [ "$MACHINE" != x86_64 ]; then
      die "Kamapathy's Linux builds are x86_64 only, and this is $MACHINE." 3
    fi
    if [ "$DEB" = 1 ]; then
      ASSET=linux-amd64.deb
    else
      ASSET=linux-x86_64.AppImage
    fi
    ;;
  *)
    die "This script installs Kamapathy on macOS and Linux. Windows installs with install.ps1." 3
    ;;
esac

# Tests point the script at a local release server. Its assets must share its
# origin, and only 127.0.0.1 may serve them without TLS.
PROTOCOLS='--proto =https --proto-redir =https'
if [ -n "${KAMAPATHY_RELEASES_API:-}" ]; then
  LIST_URL=$KAMAPATHY_RELEASES_API
  ORIGIN=$(printf '%s' "$LIST_URL" |
    sed -n 's|^\(https://[A-Za-z0-9.-]\{1,\}\(:[0-9]\{1,5\}\)\{0,1\}\)\(/.*\)\{0,1\}$|\1|p')
  if [ -z "$ORIGIN" ]; then
    ORIGIN=$(printf '%s' "$LIST_URL" |
      sed -n 's|^\(http://127\.0\.0\.1\(:[0-9]\{1,5\}\)\{0,1\}\)\(/.*\)\{0,1\}$|\1|p')
    PROTOCOLS='--proto =http,https --proto-redir =http,https'
  fi
  if [ -z "$ORIGIN" ]; then
    die "KAMAPATHY_RELEASES_API must be an https URL, or http on 127.0.0.1." 2
  fi
  BASE=$ORIGIN/releases/download
else
  LIST_URL="https://api.github.com/repos/$REPO/releases?per_page=10"
  BASE="https://github.com/$REPO/releases/download"
fi

if [ "$SYSTEM" = Darwin ]; then
  if [ -n "$DIR" ]; then
    set -- "$DIR"
  else
    set -- /Applications "$HOME/Applications"
  fi
  EXISTING=
  for folder in "$@"; do
    if [ -d "$folder/Kamapathy.app" ] &&
      [ "$(plist_value "$folder/Kamapathy.app" CFBundleIdentifier)" = "$BUNDLE_ID" ]; then
      EXISTING=$folder/Kamapathy.app
      break
    fi
  done
  if [ -n "$EXISTING" ]; then
    say "Kamapathy is already installed."
    if [ "$OPEN" = 1 ]; then open "$EXISTING" || true; fi
    printf 'already installed %s\n' "$EXISTING"
    exit 0
  fi
else
  if [ -n "$DIR" ]; then
    APPIMAGE=$DIR/Kamapathy.AppImage
  else
    APPIMAGE=$HOME/Applications/Kamapathy.AppImage
  fi
  EXISTING=
  for candidate in /opt/Kamapathy/kamapathy-browser /opt/Kamapathy/kamapathy "$APPIMAGE"; do
    if [ -f "$candidate" ]; then
      EXISTING=$candidate
      break
    fi
  done
  if [ -n "$EXISTING" ]; then
    say "Kamapathy is already installed."
    if [ "$OPEN" = 1 ]; then start_app "$EXISTING"; fi
    printf 'already installed %s\n' "$EXISTING"
    exit 0
  fi
  # The AppImage needs FUSE 2 to run at all, so say so before downloading it.
  if [ "$DEB" = 0 ] &&
    ! /sbin/ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    die "The AppImage needs FUSE 2. Install it, for example with sudo apt-get install -y libfuse2, or run this script with --deb for the Debian package." 1
  fi
fi

BASE_TMP=${TMPDIR:-/tmp}
TMP=$(mktemp -d "${BASE_TMP%/}/kamapathy-install.XXXXXXXX")

cleanup() {
  if [ -n "$MOUNT" ]; then
    hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true
    MOUNT=
  fi
  if [ -n "$STAGE" ]; then
    rm -rf "$STAGE"
    STAGE=
  fi
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

fetch() {
  if curl -fsSL $PROTOCOLS --retry 3 --retry-delay 2 -o "$2" "$1" \
    2>"$TMP/curl.log"; then
    return 0
  fi
  rm -f "$2"
  sed 's/^/Kamapathy install: curl: /' "$TMP/curl.log" >&2
  die "could not download $1" 1
}

say "looking for the newest release"
fetch "$LIST_URL" "$TMP/releases.json"
# Without jq, read the asset URLs one per line in the order the releases are
# listed, and take the first that is this computer's installer. Both versions
# in the URL must agree, and the same release must also list SHA256SUMS.txt.
URLS=$(tr ',' '\n' <"$TMP/releases.json" |
  sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
PATTERN="^$(quote "$BASE")/v\\([0-9]\\{1,\\}\\.[0-9]\\{1,\\}\\.[0-9]\\{1,\\}\\)/Kamapathy-\\1-$(quote "$ASSET")\$"
VERSION=
ASSET_URL=
for url in $URLS; do
  found=$(printf '%s' "$url" | sed -n "s|$PATTERN|\\1|p")
  if [ -n "$found" ]; then
    VERSION=$found
    ASSET_URL=$url
    break
  fi
done
if [ -z "$ASSET_URL" ]; then
  die "no listed release carries Kamapathy-<version>-$ASSET. See https://github.com/$REPO/releases." 1
fi
SUMS_URL=${ASSET_URL%/*}/SHA256SUMS.txt
if ! printf '%s\n' "$URLS" | grep -Fqx "$SUMS_URL"; then
  die "the release with $ASSET lists no SHA256SUMS.txt." 1
fi

NAME=${ASSET_URL##*/}
say "downloading $NAME"
fetch "$ASSET_URL" "$TMP/$NAME"
fetch "$SUMS_URL" "$TMP/SHA256SUMS.txt"
if [ "$SYSTEM" = Darwin ]; then
  SUM=$(shasum -a 256 "$TMP/$NAME" | cut -d' ' -f1)
else
  SUM=$(sha256sum "$TMP/$NAME" | cut -d' ' -f1)
fi
EXPECTED=$(sed -n "s|^\\([0-9a-f]\\{64\\}\\)  $(quote "$NAME")\$|\\1|p" \
  "$TMP/SHA256SUMS.txt" | head -n 1)
if [ -z "$EXPECTED" ] || [ "$SUM" != "$EXPECTED" ]; then
  rm -f "$TMP/$NAME"
  die "$NAME does not match SHA256SUMS.txt, so nothing was installed. Report this instead of running the script again." 1
fi
say "checksum verified"

if [ "$SYSTEM" = Darwin ]; then
  MOUNT=$TMP/mount
  mkdir -p "$MOUNT"
  if ! hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MOUNT" \
    "$TMP/$NAME" >/dev/null 2>&1; then
    MOUNT=
    die "could not open $NAME." 1
  fi
  SOURCE=$MOUNT/Kamapathy.app
  if [ ! -d "$SOURCE" ]; then die "$NAME holds no Kamapathy.app." 1; fi
  if [ "$(plist_value "$SOURCE" CFBundleIdentifier)" != "$BUNDLE_ID" ]; then
    die "$NAME holds another app." 1
  fi
  if [ "$(plist_value "$SOURCE" CFBundleShortVersionString)" != "$VERSION" ]; then
    die "$NAME is not Kamapathy $VERSION." 1
  fi
  MINIMUM=$(plist_value "$SOURCE" LSMinimumSystemVersion)
  CURRENT=$(sw_vers -productVersion)
  if [ -n "$MINIMUM" ] && ! version_ge "$CURRENT" "$MINIMUM"; then
    die "Kamapathy $VERSION needs macOS $MINIMUM, and this is macOS $CURRENT." 3
  fi
  say "checking the signature"
  if ! codesign --verify --deep --strict "$SOURCE" >/dev/null 2>&1; then
    die "the signature of $NAME did not verify, so nothing was installed." 1
  fi
  if [ -n "$TEAM_ID" ]; then
    if ! spctl --assess --type execute "$SOURCE" >/dev/null 2>&1; then
      die "macOS did not accept $NAME, so nothing was installed." 1
    fi
    if ! codesign -dv "$SOURCE" 2>&1 |
      grep -q "^TeamIdentifier=$TEAM_ID\$"; then
      die "$NAME is signed by another team, so nothing was installed." 1
    fi
  fi
  if [ -n "$DIR" ]; then
    mkdir -p "$DIR"
    TARGET=$DIR
  elif [ -w /Applications ]; then
    TARGET=/Applications
  else
    TARGET=$HOME/Applications
    mkdir -p "$TARGET"
  fi
  if [ -e "$TARGET/Kamapathy.app" ]; then
    die "$TARGET/Kamapathy.app is not Kamapathy. Move it away and run this again." 1
  fi
  say "copying Kamapathy to $TARGET"
  STAGE=$TARGET/.Kamapathy.app.installing-$$
  rm -rf "$STAGE"
  if ! ditto "$SOURCE" "$STAGE"; then
    die "could not copy Kamapathy to $TARGET." 1
  fi
  mv "$STAGE" "$TARGET/Kamapathy.app"
  STAGE=
  hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true
  MOUNT=
  APP=$TARGET/Kamapathy.app
  if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true; fi
  if [ "$OPEN" = 1 ]; then open "$APP" || true; fi
  printf 'installed %s\n' "$APP"
  exit 0
fi

if [ "$DEB" = 1 ]; then
  SAVED=$HOME/Downloads
  mkdir -p "$SAVED"
  mv "$TMP/$NAME" "$SAVED/$NAME"
  # Only a person at a terminal can answer apt's questions and the sudo prompt.
  if [ -t 0 ] && [ -t 1 ]; then
    say "installing the package with sudo apt-get"
    if sudo apt-get install -y "$SAVED/$NAME"; then
      printf 'installed /opt/Kamapathy/kamapathy-browser\n'
      exit 0
    fi
    die "apt-get could not install $SAVED/$NAME." 1
  fi
  say "run: sudo apt-get install -y $SAVED/$NAME"
  printf 'downloaded %s\n' "$SAVED/$NAME"
  exit 0
fi

if [ -n "$DIR" ]; then
  TARGET=$DIR
else
  TARGET=$HOME/Applications
fi
mkdir -p "$TARGET"
APP=$TARGET/Kamapathy.AppImage
STAGE=$TARGET/.Kamapathy.AppImage.installing-$$
rm -f "$STAGE"
cp "$TMP/$NAME" "$STAGE"
chmod 755 "$STAGE"
mv "$STAGE" "$APP"
STAGE=
say "installed the AppImage in $TARGET"
# The icon comes out of the AppImage when it can be extracted, and is skipped
# when it cannot.
EXTRACT=$TMP/extract
mkdir -p "$EXTRACT"
if (cd "$EXTRACT" && "$APP" --appimage-extract >/dev/null 2>&1); then
  for icon in \
    "$EXTRACT/squashfs-root/usr/share/icons/hicolor/512x512/apps/kamapathy-browser.png" \
    "$EXTRACT/squashfs-root/kamapathy-browser.png"; do
    if [ -f "$icon" ]; then
      ICONS=$HOME/.local/share/icons/hicolor/512x512/apps
      mkdir -p "$ICONS"
      cp "$icon" "$ICONS/$BUNDLE_ID.png" || true
      break
    fi
  done
fi
APPLICATIONS=$HOME/.local/share/applications
mkdir -p "$APPLICATIONS"
cat >"$APPLICATIONS/$BUNDLE_ID.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Kamapathy
Comment=A little more room to think
Exec="$APP" %U
Icon=$BUNDLE_ID
Categories=Network;WebBrowser;
Keywords=browser;web;spaces;automation;
StartupWMClass=app.kamapathy.browser
Terminal=false
ENTRY
chmod 644 "$APPLICATIONS/$BUNDLE_ID.desktop"
if [ "$OPEN" = 1 ]; then start_app "$APP"; fi
printf 'installed %s\n' "$APP"
exit 0
