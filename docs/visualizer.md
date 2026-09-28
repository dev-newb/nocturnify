# Visualizer

A 1280×720 canvas stretched to the panel, redrawn each frame. All coordinates live in
1280-space regardless of the display's real resolution.

Enter it from the sidebar, or let it arrive on its own after 60 s idle. ▲ ▼ change mode,
◀ ▶ change track, OK toggles play/pause, Back exits.

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
| Kaleido | the cover art itself, cut into a wedge and mirrored 8, 10 or 12 ways into a mandala that turns behind the cover | 0.30 |
| Murmur | a starling murmuration wheeling around the cover; waves of density pass through it, and it sometimes splits in two | 0.26 |
| Golden | sunflower phyllotaxis with the cover as its heart; the seed angle breathes around the golden angle, so spiral arms form and dissolve | 0.16 |
| Harmonograph | a pendulum drawing machine inking figures at musical intervals — fifth 3:2, fourth 4:3, major third 5:4 — named as each begins | 1.0 |
| **Auto** | cross-fades through all thirteen — a hidden slot, reached by paging past either end | — |

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

### The four later modes

Measured with `gfxinfo` over 12 s each, Drift alongside as the reference:

| Mode | draws / frame | janky | p50 | p99 |
|---|---:|---:|---:|---:|
| Drift *(reference)* | 212 | 0.14% | 8 ms | 14 ms |
| Kaleido | 16 | 0.00% | 8 ms | 12 ms |
| Murmur | 212 | 0.14% | 8 ms | 14 ms |
| Golden | 146 | 0.00% | 8 ms | 11 ms |
| Harmonograph | 15–34 | 0.14% | 8 ms | 12 ms |

None of them strokes anything.

- **Murmur has no flocking maths.** Boids are O(n²), too much for this CPU. Each bird is a fixed
  point on a sheet that tumbles in 3-D and is projected; edge-on, the sheet collapses into a dense
  bright blade, and that density swing is the murmuration look. Each bird chases its target with
  its own lag, so ripples pass through the flock. It circles the cover rather than crossing it:
  simulated over 5 × 10 minutes, the first flight path had 16.6% of birds hidden behind the art;
  the orbit has 1.1%.
- **Kaleido builds one wedge per frame** (one clip, one `drawImage` of the art) and blits it n
  times with rotation, mirroring alternate wedges so the seams meet. The art is drawn at 1150 px
  because a square of side S covers a circle of radius S/2 at any rotation, and the wedge fits
  inside a 525 px circle — undersize it and the mandala's rim goes empty. Its brightness is
  scaled by the cover's mean luminance, so pale covers don't flood the screen. Its first ~20 s
  after launch run at p50 21 ms (no dropped frames) before settling to 8 ms, likely the GPU
  clocking up; Kaleido is the heaviest fill of any mode.
- **Harmonograph keeps its ink in its own paper canvas**, faded in coarse steps. An 8-bit channel
  can't lose less than one unit per step, so a tiny fade every frame never quite reaches zero and
  leaves permanent ghost lines. The paper is wiped between swings. Its main-canvas trail is 1,
  because a trail on top would multiply the ink's brightness by 1/trail.
- **Thin marks use lifted colours.** Birds and ink use a crisp point pre-lightened toward white,
  since a raw deep-red or navy accent is nearly invisible as a 5 px speck on a dark ground.

## Text

`fillText` neither wraps nor clips, so long titles used to run off both edges. Every line is
capped at `W * 0.76` (972.8 px), which leaves ~12% margin each side and clears TV overscan.
The title wraps to two lines and ellipsises; artist, album and context ellipsise on one, sized
by binary search on `measureText`.
