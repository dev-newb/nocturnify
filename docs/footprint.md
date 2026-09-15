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

## Why the WebView is the floor

Audio requires the Spotify Web Playback SDK, which requires EME/Widevine, which requires a
secure origin and a real browser engine. There is no lighter way to get audio out of Spotify
without leaving their sanctioned APIs — see [architecture.md](architecture.md).
