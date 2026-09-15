# Footprint

Measured on the target device: Sony Bravia (Android 12, 2.83 GB RAM, MediaTek SoC),
1920×1080 logical display.

## Disk

| | Nocturnify | Official Spotify for Android TV |
|---|---:|---:|
| APK | **6.9 MB** | 56.8 MB |
| App data | negligible | 80.6 MB |
| Cache | negligible | 72.8 MB |
| **Total** | **~7 MB** | **210.3 MB** |

Roughly a **30× difference**. The official figures were taken from this device with
`dumpsys diskstats` before that app was removed; the Nocturnify figure is `du` on its
install directory.

## Memory

| | Nocturnify |
|---|---:|
| Total PSS | **88.6 MB** |
| Total RSS | 214.6 MB |
| Processes | 1 |

Where it goes (PSS):

| Region | KB |
|---|---:|
| `.apk mmap` | 30,412 |
| Native heap | 12,311 |
| Unknown | 9,056 |
| `.so mmap` | 7,298 |
| `.dex mmap` | 5,914 |
| Dalvik heap | 2,786 |
| Dalvik other | 2,463 |
| Stack | 1,364 |

**This is not a small number, and it should be read honestly.** ~89 MB is what a Chromium
WebView costs once it has a page, a canvas, and a DRM-backed media pipeline live. The saving
versus the official app is overwhelmingly on **disk**, not RAM — the official client is a full
native app with its own image caches, offline store and analytics stack, whereas this is one
WebView. A like-for-like RAM comparison has not been made: the official app is no longer
installed on the test device, so no PSS figure for it was captured.

Device headroom while running: 1094 MB of 2898 MB available.

## What the public record says about the official app

No published RAM figure for the official Android TV client could be found — not from Spotify,
reviewers, or users. Everything on record concerns **storage**, and it is worse than the
210 MB snapshot above, which was taken on a fresh-ish install:

- Multiple Spotify Community threads report the Android TV app's data growing to **1–2 GB**
  over time ("1.5 GB", "1.5–2 GB"), with TVs then warning repeatedly about low space.
- A thread titled *Memory leak on android tv* describes the app becoming nearly unusable after
  ~30 minutes until the set is restarted; clearing data fixes it temporarily but signs you out.
- The explanation offered is that the app rebuilds its internal database on each login and
  keeps downloading metadata and cover art for large libraries in the background.

These are user reports rather than controlled measurements, and none of them gives a resident
memory number. For scale, a 2025 Sony Bravia 2 II ships with 16 GB of storage in total.

Sources: [Huge Data Demand](https://community.spotify.com/t5/Android/Android-TV-App-Huge-Data-Demand-Bringing-Storage-to-It-s-Limit/td-p/7540243),
[Memory leak on android tv](https://community.spotify.com/t5/Android/Memory-leak-on-android-tv/td-p/4868664),
[Sony Bravia 2 II storage](https://www.bestbuy.com/site/questions/sony-55-class-bravia-2-ii-led-4k-uhd-smart-google-tv-2025/6623762/question/4bc556e4-bb75-3a7e-bff5-27d47135b510).

## Why the WebView is the floor

Audio requires the Spotify Web Playback SDK, which requires EME/Widevine, which requires a
secure origin and a real browser engine. There is no lighter way to get audio out of Spotify
without leaving their sanctioned APIs — see [architecture.md](architecture.md).
