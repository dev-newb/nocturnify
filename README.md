# Spotify TV

A few-hundred-KB Spotify front end for Android TV: one WebView, the official
[Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) for audio,
and a D-pad-first UI. No offline cache, no video, no podcasts UI. The TV also shows up as a
Spotify Connect device, so your phone works as a remote.

**Requires Spotify Premium** (the SDK refuses free accounts).

## One-time setup

1. Go to <https://developer.spotify.com/dashboard> → **Create app**.
   - Redirect URI (exactly): `https://appassets.androidplatform.net/assets/callback.html`
   - API: tick **Web Playback SDK** and **Web API**.
2. Copy the **Client ID** into `app/src/main/assets/config.js`.
3. Build & install (below). On first launch, sign in with email + password
   (“Continue with Google” is blocked inside apps by Google, not by us).

## Build

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew assembleDebug
adb connect 192.168.1.201:5555
adb -s 192.168.1.201:5555 install -r app/build/outputs/apk/debug/app-debug.apk
```

## Diagnostics

```bash
# Widevine / EME gate — must say "WIDEVINE OK" or nothing else will work
adb shell am start -n dev.rich.spotifytv/.MainActivity -e page eme-test.html
# JS console
adb logcat -s SpotifyTV
```

## Remote

| Key | Action |
|---|---|
| ▲ ▼ | move within the list |
| ◀ ▶ | switch between sidebar and list |
| OK | open / play |
| Back | up a level; at the top, exit |
| Play/Pause, Next, Prev | transport |

## Layout

```
app/src/main/java/.../MainActivity.kt   ~100 lines: WebView, DRM permission grant, key forwarding
app/src/main/assets/
  index.html  style.css  app.js         the UI
  auth.js  callback.html                OAuth PKCE, tokens in localStorage
  config.js                             your Client ID
  eme-test.html                         Widevine gate page
```
