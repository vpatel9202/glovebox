#!/bin/sh
# Builds the glovebox Android server into native/android/build/glovebox-server.dex.
# Needs an Android SDK (platforms/android-N and build-tools) and a JDK 17+.
#   ANDROID_HOME   SDK root (default ~/Library/Android/sdk)
#   JAVA_HOME      JDK (default: Android Studio's bundled JBR, else java on PATH)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
if [ -z "${JAVA_HOME:-}" ]; then
  for jbr in "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    [ -x "$jbr/bin/javac" ] && JAVA_HOME=$jbr && break
  done
fi
javac=${JAVA_HOME:+$JAVA_HOME/bin/}javac
platform=$(ls -d "$sdk"/platforms/android-* 2>/dev/null | sort -V | tail -1)
buildtools=$(ls -d "$sdk"/build-tools/* 2>/dev/null | sort -V | tail -1)
[ -n "$platform" ] || { echo "No Android platform in $sdk/platforms. Install one with the SDK Manager." >&2; exit 1; }
[ -n "$buildtools" ] || { echo "No build-tools in $sdk/build-tools. Install them with the SDK Manager." >&2; exit 1; }
jar=$platform/android.jar
out=$here/build
rm -rf "$out/classes" && mkdir -p "$out/classes"
"$javac" -Xlint:-options --release 11 -cp "$jar" -d "$out/classes" $(find "$here/src" -name '*.java')
JAVA_HOME=${JAVA_HOME:-} "$buildtools/d8" --min-api 30 --lib "$jar" --output "$out" $(find "$out/classes" -name '*.class')
mv "$out/classes.dex" "$out/glovebox-server.dex"
rm -rf "$out/classes"
echo "Built $out/glovebox-server.dex"
