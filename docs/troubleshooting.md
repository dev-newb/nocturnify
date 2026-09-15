# Troubleshooting

## Nothing plays, or the SDK never initialises

Check the Widevine gate first — without DRM nothing else can work:

```bash
adb shell am start -n dev.rich.spotifytv/.MainActivity -e page eme-test.html
```

It must report `WIDEVINE OK`.

Also confirm the account is **Premium**. The Web Playback SDK refuses free accounts outright.

## Sign-in fails

Use **email and password**. *Continue with Google* is blocked inside Android WebViews by
Google, not by this app.

If sign-in loops or the callback errors with `ERR_NAME_NOT_RESOLVED`, the redirect URI in the
Spotify dashboard must match exactly:

```
https://appassets.androidplatform.net/assets/callback.html
```

## "Invalid client" or no permission

New dashboard apps start in **Development Mode**, limited to a handful of users. Add your
account under **User Management** in the app's dashboard settings.

## Shuffle switches itself back on

Expected. Spotify accepts the request, returns 200, and ignores it —
`actions.disallows.toggling_shuffle` is set for playlist contexts. The sidebar reports it as
locked.

## A short gap between tracks

Expected, and not fixable from here. Every track change costs ~0.7 s (occasionally ~1.2 s)
because each track gets its own Widevine session and Chromium rebuilds the entire audio
pipeline serially. See [architecture.md](architecture.md#known-platform-limits).

## UI clipped at the screen edge

TVs overscan. The app box sits at `8vh 6vw 0 6vw`, which clears a 5% title-safe margin at
1080p. If your set overscans harder, raise those in `style.css`.

## Logs

```bash
adb logcat -s SpotifyTV                       # the app's JS console
adb logcat -s cr_MediaDrmBridge:V MediaFocusControl:V   # DRM and audio focus
```
