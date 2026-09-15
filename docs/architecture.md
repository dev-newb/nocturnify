# Architecture

One Activity hosting one WebView. Everything else is a consequence of that.

## Why a WebView

Spotify's only publicly sanctioned way for a third party to *produce audio* is the
[Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk), which runs in
a browser. It streams DRM-protected audio through EME/Widevine, so it needs a real browser
engine and a **secure origin** — `file://` will not do.

The other public surfaces do not deliver audio:

- **Web API** — metadata and playback *control* only; it can direct a device, never make sound.
- **Android SDK (App Remote)** — remote-controls the installed official Spotify app.
- **Embedded SDK (eSDK)** — native, but only under a commercial hardware partnership.

## Secure origin

`WebViewAssetLoader` serves `app/src/main/assets/` over
`https://appassets.androidplatform.net`, which satisfies EME. That virtual origin is also the
registered OAuth redirect target.

One consequence worth knowing: the WebView resolves a cross-origin redirect to that host through
real DNS *before* `shouldInterceptRequest` runs, so the OAuth callback fails with
`ERR_NAME_NOT_RESOLVED` unless it is claimed earlier, in `shouldOverrideUrlLoading`.

## Auth

OAuth 2.0 with PKCE, in `auth.js`. Tokens live in `localStorage`; refresh tokens rotate. A
`SCOPE_VERSION` constant forces a single re-login when the requested scopes change, since scopes
are baked into an issued token.

The Client ID is public under PKCE but is tied to one dashboard app and its user allowlist, so
`config.js` is gitignored and `config.example.js` is shipped in its place.

## Background audio

A foreground service (`PlaybackService.kt`, type `mediaPlayback`) plus a `MediaSessionCompat`
keeps the WebView's audio alive after the user leaves the app, and puts transport controls on
the system media notification.

Media keys route through the MediaSession rather than `Activity.onKeyDown`, which means
`ACTION_FAST_FORWARD`, `ACTION_REWIND` and `ACTION_SEEK_TO` must be declared or the keys are
swallowed. State pushes to the bridge are de-duplicated — without that, the session was being
updated hundreds of times a minute.

## JS bridge

`WebViewCompat.addWebMessageListener` scoped to the asset origin only. Nothing else can reach it.

## Known platform limits

- **Shuffle is read-only in playlist contexts.** Spotify returns 200 and ignores the request;
  `actions.disallows.toggling_shuffle` is set.
- **~0.7 s gap at every track change**, occasionally ~1.2 s. Each track gets its own Widevine
  session: close, tear down the decoder and AudioTrack, open a new session, fetch a licence,
  rebuild — all serially inside Chromium. Measured across ten transitions, the DRM and licence
  stages are stable at 510–681 ms; the variance is entirely in Chromium's post-licence buffering,
  which ranged 8–613 ms. Nothing in this app can reach any of it.
