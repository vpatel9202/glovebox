#!/bin/sh
# Builds the glovebox Android server into native/android/build/glovebox-server.dex,
# and the smoke-test app into native/android/build/glovebox-fixture.apk.
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
keytool=${JAVA_HOME:+$JAVA_HOME/bin/}keytool
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

# The fixture: no Gradle, no resources; aapt2 links the manifest, d8 adds the
# code, and a local debug key signs it.
fx=$here/fixture
work=$out/fixture
rm -rf "$work" && mkdir -p "$work/classes"
"$javac" -Xlint:-options --release 11 -cp "$jar" -d "$work/classes" $(find "$fx/src" -name '*.java')
JAVA_HOME=${JAVA_HOME:-} "$buildtools/d8" --min-api 30 --lib "$jar" --output "$work" $(find "$work/classes" -name '*.class')
key=$out/fixture-debug.keystore
if [ ! -f "$key" ]; then
  "$keytool" -genkeypair -keystore "$key" -storepass android -keypass android -alias fixture \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=glovebox fixture" >/dev/null 2>&1
fi
# Two packages from the same code: the second lets two sessions each open one.
for variant in fixture fixture2; do
  "$buildtools/aapt2" link --manifest "$fx/AndroidManifest.xml" -I "$jar" --min-sdk-version 30 --target-sdk-version 35 \
    --rename-manifest-package "com.glovebox.$variant" -o "$work/$variant.apk"
  (cd "$work" && zip -q "$variant.apk" classes.dex)
  "$buildtools/zipalign" -f 4 "$work/$variant.apk" "$work/$variant-aligned.apk"
  JAVA_HOME=${JAVA_HOME:-} PATH=${JAVA_HOME:+$JAVA_HOME/bin:}$PATH "$buildtools/apksigner" sign --ks "$key" --ks-pass pass:android \
    --out "$out/glovebox-$variant.apk" "$work/$variant-aligned.apk"
  rm -f "$out/glovebox-$variant.apk.idsig"
done
rm -rf "$work"
echo "Built $out/glovebox-fixture.apk and glovebox-fixture2.apk"
