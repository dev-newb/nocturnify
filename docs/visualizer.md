# Visualizer

A 1280×720 canvas stretched to the panel, redrawn each frame. All coordinates live in
1280-space regardless of the display's real resolution.

Enter it from the sidebar, or let it arrive on its own after 60 s idle. ◀ ▶ change mode,
OK toggles play/pause, Back exits.

## Modes

| Mode | Character | Trail |
|---|---|---:|
| Drift | slow ambient particle field | 0.135 |
| Orbit | concentric rotating shells | 0.135 |
| Aurora | vertical curtains | 0.09 |
| Nebula | billowing cloud | 0.055 |
| Starfield | forward flight; a quarter of the streaks are stroked, the rest sprite-blurred, with occasional comets | 0.13 |
| Ribbons | flowing bands | 0.10 |
| Lattice | connected node mesh | 0.22 |
| Bloom | rings that grow, destabilise toward the centre, and drift off the perimeter | 0.10 |
| Rain | wind-blown streaks of varying weight | 0.20 |
| **Auto** | cross-fades through all nine — a hidden tenth slot, reached by paging past either end | — |

210 particles. Auto holds each mode 22 s and cross-fades over 5 s.

## Colour

The palette is quantised out of the current album art. Buckets are weighted by **both**
saturation and luminance, so a near-black cover still yields usable accents rather than mud;
accents are lifted toward white when the source is very dark.

## Performance notes

Everything below was measured with `dumpsys gfxinfo` on the target device.

- **`stroke()` costs ~2–4 ms per call regardless of segment count.** Starfield and Rain
  originally stroked every particle and janked 74–90% of frames. Converting them to
  `drawImage` of a pre-rendered sprite took every mode to 0.00% jank at ~8 ms per frame.
- **Cross-fade uses weighted alphas, not offscreen buffers.** Each mode multiplies its alphas
  by the fade weight and two particle pools swap roles at handover; trail persistence is
  interpolated across the fade. An offscreen buffer per mode would have doubled the fill cost.
- **Rain applies one canvas rotation per frame** for global wind, rather than transforming
  each of 210 particles.
- **Bloom clamps sprite size to 760** and expires escaped rings after 3–6 s. Without that,
  large sprites lingering off-screen pushed the frame time to 21 ms.

## Text

`fillText` neither wraps nor clips, so long titles used to run off both edges. Every line is
capped at `W * 0.76` (972.8 px), which leaves ~12% margin each side and clears TV overscan.
The title wraps to two lines and ellipsises; artist, album and context ellipsise on one, sized
by binary search on `measureText`.
