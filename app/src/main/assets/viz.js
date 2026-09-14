// viz.js — ambient now-playing visualiser (3 modes, D-pad UP/DOWN to cycle).
//
// Deliberately NOT audio-reactive, because it cannot be: probing the running app showed the
// Web Playback SDK exposes ZERO media elements to the DOM, so Web Audio has nothing to tap,
// and /audio-analysis + /audio-features are 403 for Development-mode apps — no tempo, no beat
// grid. A faked BPM pulse drifts audibly against the real music, so motion is driven only by
// things that are true: interpolated playback position, a per-track seed, and a palette
// quantised from the cover art's actual pixels.
(function () {
  const W = 1280, H = 720;
  const NPART = 210;
  const FPS = 60;             // load reduction didn't correlate with the audio gaps — restored
  const MODES = ['Drift', 'Orbit', 'Aurora', 'Nebula', 'Starfield', 'Ribbons', 'Lattice', 'Bloom', 'Rain'];
  const AUTO = MODES.length;            // hidden slot: sits between the last and first
  const TRAIL = [0.135, 0.135, 0.09, 0.055, 0.13, 0.10, 0.22, 0.10, 0.20];   // per-mode trail persistence
  const HOLD = 22, FADE = 5;            // Auto: seconds held, seconds cross-fading
  const ART_CY = H * 0.355, ART_SZ = 268;

  let cv, ctx, raf = 0, opts = null, running = false;
  let poolA = [], poolB = [], sprites = [], curtains = [], rings = [], sharps = [], glow = null, pal = null, prevPal = null, palMix = 1;
  let autoIdx = 0, autoT = 0, autoNextReady = -1;
  // accents from a near-black cover are almost invisible as thin strokes; lift them a little
  const lift = (c, m = 0.38) => [c[0] + (255 - c[0]) * m, c[1] + (255 - c[1]) * m, c[2] + (255 - c[2]) * m];
  let lastDraw = 0;
  let artImg = null, artUrl = '', lastTrack = '';
  let seed = 1, tPrev = 0, tNow = 0, mode = 0, modeUntil = 0, seekPreview = null, seekShown = null;

  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const lerp = (a, b, m) => a + (b - a) * m;
  const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  const mmss = ms => { const t = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  try { mode = Math.max(0, Math.min(AUTO, parseInt(localStorage.viz_mode || '0', 10) || 0)); } catch (e) {}

  // ---- palette straight out of the cover art -------------------------------
  async function palette(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('art')); img.src = url; });
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
      e.r += r; e.g += gg; e.b += b; e.n++; buckets.set(key, e);
    }
    const cols = [...buckets.values()].map(e => {
      const r = e.r / e.n, g2 = e.g / e.n, b = e.b / e.n;
      const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b);
      const sat = mx ? (mx - mn) / mx : 0;
      const lum = (0.299 * r + 0.587 * g2 + 0.114 * b) / 255;
      return { r, g: g2, b, sat, lum, score: e.n * (0.25 + sat) * (0.30 + lum) };
    }).sort((a, b) => b.score - a.score);
    const vivid = cols.filter(c2 => c2.sat > 0.22 && c2.lum > 0.14).slice(0, 4);
    const acc = (vivid.length ? vivid : cols.slice(0, 3)).map(c2 => [c2.r, c2.g, c2.b]);
    const dark = cols.slice().sort((a, b) => a.lum - b.lum)[0] || { r: 10, g: 10, b: 16 };
    return { bg: [dark.r * 0.30 + 4, dark.g * 0.30 + 4, dark.b * 0.34 + 7], acc, img };
  }

  function buildSprites(p) {
    sprites = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = s.height = 64;
      const g = s.getContext('2d');
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.85)`);
      grd.addColorStop(0.35, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.22)`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      return s;
    });
    // one soft vertical strip per accent colour (pre-tinted: 'lighter' can't colourise a white sprite)
    // the art glow was a fresh createRadialGradient + large alpha fillRect every single frame;
    // bake it once per palette and just blit it
    glow = document.createElement('canvas'); glow.width = glow.height = 256;
    {
      const g = glow.getContext('2d');
      const a = p.acc[0] || [120, 140, 180];
      const rg = g.createRadialGradient(128, 128, 34, 128, 128, 128);
      rg.addColorStop(0, `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},0.42)`);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
    }
    // A crisp point: bright opaque core with a fast falloff, for the sharp quarter of stars
    sharps = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = s.height = 32;
      const g = s.getContext('2d');
      const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
      const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      rg.addColorStop(0.00, `rgba(${col},1)`);
      rg.addColorStop(0.34, `rgba(${col},0.92)`);
      rg.addColorStop(0.52, `rgba(${col},0.22)`);
      rg.addColorStop(1.00, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
      return s;
    });
    // Bloom draws rings, not blobs, so it doesn't read as "Drift in a circle"
    rings = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = s.height = 64;
      const g = s.getContext('2d');
      const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
      rg.addColorStop(0.00, `rgba(${col},0)`);
      rg.addColorStop(0.52, `rgba(${col},0.03)`);
      rg.addColorStop(0.74, `rgba(${col},0.95)`);
      rg.addColorStop(0.86, `rgba(${col},0.22)`);
      rg.addColorStop(1.00, `rgba(${col},0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
      return s;
    });
    curtains = p.acc.map(c => {
      const s = document.createElement('canvas'); s.width = 64; s.height = 256;
      const g = s.getContext('2d');
      const lg = g.createLinearGradient(0, 0, 0, 256);
      lg.addColorStop(0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
      lg.addColorStop(0.45, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.92)`);
      lg.addColorStop(1, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
      g.fillStyle = lg; g.fillRect(0, 0, 64, 256);
      const hg = g.createLinearGradient(0, 0, 64, 0);
      hg.addColorStop(0, 'rgba(0,0,0,1)'); hg.addColorStop(0.5, 'rgba(0,0,0,0)'); hg.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = hg; g.fillRect(0, 0, 64, 256);
      return s;
    });
  }

  const mkPool = n => Array.from({ length: n }, () => ({}));

  // Each mode owns how it seeds and draws a pool. Every alpha is multiplied by `w` so two
  // modes can be drawn at once and cross-faded (Auto) without any offscreen buffers.
  function initFor(id, pool) {
    for (const p of pool) {
      p.x = rnd() * W; p.y = rnd() * H;
      p.sp = 14 + rnd() * 46;
      p.sz = 12 + rnd() * 46;
      p.si = (rnd() * Math.max(1, sprites.length)) | 0;
      p.life = 3 + rnd() * 7;
      p.age = rnd() * p.life;
      p.r = 120 + rnd() * 900;                 // Orbit radius
      p.a = rnd() * Math.PI * 2;
      p.dir = rnd() < 0.5 ? -1 : 1;
      // Nebula: few, huge, slow
      p.nr = 170 + rnd() * 380;
      p.nvx = (rnd() - 0.5) * 17.64; p.nvy = (rnd() - 0.5) * 12.6;  // 14/10 base, +20% then +5%
      p.nph = rnd() * Math.PI * 2;
      // Starfield: normalised direction + depth
      p.dx = (rnd() - 0.5) * 2; p.dy = (rnd() - 0.5) * 2;
      p.z = 0.05 + rnd() * 0.95;
      p.sx = null; p.sy = null; p.comet = false; p.tail = null;
      // Rain: column, fall speed, streak length
      p.rx = -W * 0.25 + rnd() * W * 1.5; p.ry = rnd() * H; p.rs = 240 + rnd() * 520;
      p.rl = 12 + rnd() * 70; p.rw = 1.6 + rnd() * 4.4; p.rd = (rnd() - 0.5) * 18;
      // Bloom: orbiting seed point mirrored around the centre
      p.br = 47 + rnd() * 354; p.ba = rnd() * Math.PI * 2; p.bs = (0.15 + rnd() * 0.5) * (rnd() < 0.5 ? -1 : 1);
      p.escV = 34 + rnd() * 46;   // escape speed: kind of slow, to a bit faster
      p.br0 = p.br; p.esc = 0;
      p.escK = 0.25 + rnd() * rnd() * 15.75;   // escape swell: mostly slight, occasionally huge
      p.stroked = rnd() < 0.25;                // a quarter of stars draw as stroked segments
    }
  }

  function field(x, y, t, k) {
    const s = 0.0024 * k;
    return Math.sin(x * s + t * 0.26) * 1.8
         + Math.cos(y * s * 1.27 - t * 0.20) * 1.8
         + Math.sin((x + y) * s * 0.55 + t * 0.12) * 1.25;
  }

  function mDrift(pool, w, dt, mv, k) {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of pool) {
      const ang = field(p.x, p.y, tNow, k);
      p.x += Math.cos(ang) * p.sp * dt * mv;
      p.y += Math.sin(ang) * p.sp * dt * mv;
      p.age += dt * mv;
      if (p.age > p.life || p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) {
        p.x = rnd() * W; p.y = rnd() * H; p.age = 0;
      }
      const f = Math.sin(Math.min(1, p.age / p.life) * Math.PI);
      const sp = sprites[p.si]; if (!sp) continue;
      ctx.globalAlpha = 0.30 * f * w;
      ctx.drawImage(sp, p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz);
    }
    ctx.globalAlpha = 1;
  }

  function mOrbit(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    for (const p of pool) {
      p.a += p.dir * (0.34 / (0.45 + p.r / 300)) * dt * mv;
      const x = W / 2 + Math.cos(p.a) * p.r;
      const y = H / 2 + Math.sin(p.a) * p.r * 0.62;
      p.age += dt * mv;
      if (p.age > p.life) p.age = 0;
      const f = Math.sin(Math.min(1, p.age / p.life) * Math.PI);
      const sp = sprites[p.si]; if (!sp) continue;
      ctx.globalAlpha = 0.30 * f * w;
      ctx.drawImage(sp, x - p.sz / 2, y - p.sz / 2, p.sz, p.sz);
    }
    ctx.globalAlpha = 1;
  }

  function mAurora(pool, w) {
    if (!curtains.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const x = W / 2 + Math.sin(tNow * 0.17 + i * 1.7) * W * 0.36;
      const cw = 130 + Math.sin(tNow * 0.23 + i * 2.1) * 70;
      const hh = H * (0.75 + Math.sin(tNow * 0.13 + i) * 0.18);
      const y = H * 0.5 - hh / 2 + Math.sin(tNow * 0.11 + i * 0.9) * 40;
      ctx.globalAlpha = 0.20 * w;
      ctx.drawImage(curtains[i % curtains.length], x - cw / 2, y, cw, hh);
    }
    ctx.globalAlpha = 1;
  }

  // Nebula — a few enormous soft clouds, slowly breathing and drifting past each other.
  function mNebula(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    const n = Math.min(pool.length, 30);
    for (let i = 0; i < n; i++) {
      const p = pool[i];
      p.x += p.nvx * dt * mv; p.y += p.nvy * dt * mv;
      p.nph += dt * mv * 0.25;
      if (p.x < -p.nr) p.x = W + p.nr; else if (p.x > W + p.nr) p.x = -p.nr;
      if (p.y < -p.nr) p.y = H + p.nr; else if (p.y > H + p.nr) p.y = -p.nr;
      const r = p.nr * (0.86 + Math.sin(p.nph) * 0.14);
      const sp = sprites[p.si]; if (!sp) continue;
      ctx.globalAlpha = 0.085 * w;
      ctx.drawImage(sp, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // Starfield — benchmarking showed stroke() costs ~2-3ms a call on this panel even when
  // batched (74% janky frames), while drawImage of 210 sprites costs ~8ms total. So the stars
  // are drawn as depth-scaled dots and the streaks come from the trail persistence instead —
  // the smear IS the motion blur. One star is occasionally promoted to a comet: same radial
  // path, just larger and brighter with a tail of fading sprites.
  const SB_A = [0.40, 0.66, 0.92], SB_W = [1.1, 2.0, 3.4];   // stroked stars, per depth band
  function mStars(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const ns = Math.max(1, sprites.length);
    let cometCount = 0, comet = null;
    for (const p of pool) if (p.comet) cometCount++;

    for (const p of pool) {
      p.z -= dt * mv * 0.34;
      const x = W / 2 + (p.dx / p.z) * 210;
      const y = H / 2 + (p.dy / p.z) * 210;
      if (p.z < 0.06 || x < -220 || x > W + 220 || y < -220 || y > H + 220) {
        if (p.comet) { p.comet = false; cometCount--; }
        p.dx = (rnd() - 0.5) * 2; p.dy = (rnd() - 0.5) * 2; p.z = 1; p.tail = null;
        // cx/cy must go too: the final pass copies them into sx/sy, and a stale value would
        // be stroked next frame as a line from the old position to the new spawn point.
        p.sx = null; p.sy = null; p.cx = null; p.cy = null; p.vis = false;
        if (cometCount === 0 && rnd() < 0.04) {
          p.comet = true; p.tail = []; p.cometStroke = rnd() < 0.5; cometCount++;
        }
        continue;
      }
      const near = 1 - p.z;
      p.cx = x; p.cy = y;
      p.band = p.z > 0.66 ? 0 : (p.z > 0.33 ? 1 : 2);
      p.vis = p.sx != null;
      if (p.comet) { comet = p; continue; }
      if (p.stroked) continue;                       // drawn in the batched pass below
      const sp = sprites[p.si % ns]; if (!sp) continue;
      const r = 2.5 + near * 15;
      ctx.globalAlpha = (0.22 + near * 0.58) * w;
      ctx.drawImage(sp, x - r, y - r, r * 2, r * 2);
    }

    // The stroked quarter, batched to three calls (one per depth band). Stroke costs ~2-3ms a
    // CALL on this panel regardless of how many segments it carries, so the count of calls is
    // what matters, not the count of stars.
    const sc = lift(pal.acc[0] || [210, 220, 245], 0.45);
    const scStr = `${sc[0] | 0},${sc[1] | 0},${sc[2] | 0}`;
    for (let band = 0; band < 3; band++) {
      let any = false;
      ctx.beginPath();
      for (const p of pool) {
        if (!p.stroked || !p.vis || p.comet || p.band !== band) continue;
        ctx.moveTo(p.sx, p.sy); ctx.lineTo(p.cx, p.cy); any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = `rgba(${scStr},${(SB_A[band] * w).toFixed(3)})`;
      ctx.lineWidth = SB_W[band];
      ctx.stroke();
    }

    if (comet) {
      const p = comet, near = 1 - p.z;
      p.tail.unshift({ x: p.cx, y: p.cy });
      if (p.tail.length > 16) p.tail.pop();
      const n = p.tail.length;
      const c = lift(pal.acc[p.si % Math.max(1, pal.acc.length)] || [225, 238, 255], 0.6);
      if (p.cometStroke && n > 1) {
        const rgbStr = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
        const L = [[n, 2, 0.24], [Math.max(2, (n * 0.55) | 0), 4.5, 0.38], [Math.max(2, (n * 0.25) | 0), 7.5, 0.58]];
        for (let li = 0; li < 3; li++) {
          ctx.strokeStyle = `rgba(${rgbStr},${(L[li][2] * near * w).toFixed(3)})`;
          ctx.lineWidth = L[li][1];
          ctx.beginPath();
          ctx.moveTo(p.tail[0].x, p.tail[0].y);
          for (let j = 1; j < L[li][0]; j++) ctx.lineTo(p.tail[j].x, p.tail[j].y);
          ctx.stroke();
        }
      } else {
        const sp = sprites[p.si % ns];
        if (sp) for (let j = n - 1; j >= 0; j--) {
          const f = 1 - j / n;
          const r = (5 + near * 26) * f;
          ctx.globalAlpha = 0.65 * f * near * w;
          ctx.drawImage(sp, p.tail[j].x - r, p.tail[j].y - r, r * 2, r * 2);
        }
      }
    }

    for (const p of pool) { p.sx = p.cx; p.sy = p.cy; }
    ctx.globalAlpha = 1;
  }

  // Ribbons — long silk bands woven from summed sines.
  function mRibbons(pool, w) {
    ctx.globalCompositeOperation = 'lighter';
    const bands = 4, step = 30;
    for (let b = 0; b < bands; b++) {
      const c = pal.acc[b % pal.acc.length] || [180, 200, 235];
      const ph = b * 1.24, amp = H * (0.10 + (b % 3) * 0.045);
      ctx.strokeStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${(0.20 * w).toFixed(3)})`;
      ctx.lineWidth = 10 + (b % 3) * 7;
      ctx.beginPath();
      for (let x = -step; x <= W + step; x += step) {
        const y = H / 2
          + Math.sin(x * 0.0043 + tNow * 0.42 + ph) * amp
          + Math.sin(x * 0.0017 - tNow * 0.25 + ph * 1.7) * amp * 0.7
          + Math.sin(tNow * 0.15 + ph) * 40;
        if (x <= -step) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Lattice — a standing wave crossing a geometric grid; only crests are drawn, so most
  // cells cost nothing and the field reads as a pulse travelling outward.
  function mLattice(pool, w, dt, mv) {
    ctx.globalCompositeOperation = 'lighter';
    const cols = 22, rows = 13, dx = W / cols, dy = H / rows;
    const ns = Math.max(1, sprites.length);
    for (let gy = 0; gy < rows; gy++) {
      const y = (gy + 0.5) * dy, ry = y - H / 2;
      for (let gx = 0; gx < cols; gx++) {
        const x = (gx + 0.5) * dx, rx = x - W / 2;
        const d = Math.sqrt(rx * rx + ry * ry);
        const f = Math.sin(d * 0.011 - tNow * 1.5);
        if (f < 0.05) continue;                       // troughs cost nothing
        const sp = sprites[(gx + gy) % ns]; if (!sp) continue;
        const r = 6 + f * 30;
        ctx.globalAlpha = 0.50 * f * w;
        ctx.drawImage(sp, x - r, y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Bloom — rotational symmetry: a handful of orbiting points mirrored into eight arms.
  // Drawn as glowing rings of varying scale so the mandala reads as its own thing rather
  // than the same soft dots Drift and Orbit use.
  function mBloom(pool, w, dt, mv) {
    if (!rings.length) return;
    ctx.globalCompositeOperation = 'lighter';
    const ARMS = 8, N = Math.min(pool.length, 24), TAU = Math.PI * 2;
    let escaping = 0;
    for (let i = 0; i < N; i++) if (pool[i].esc) escaping++;

    for (let i = 0; i < N; i++) {
      const p = pool[i];
      const sp = rings[p.si % rings.length]; if (!sp) continue;

      if (p.esc === 0) {
        p.ba += p.bs * dt * mv * 0.35;
        if (escaping < 2 && rnd() < dt * mv * 0.0127) { p.esc = 1; escaping++; }   // ~15% more
      }

      if (p.esc === 0) {
        const rr = p.br * (0.85 + Math.sin(tNow * 0.5 + i) * 0.15);
        const sz = (14 + p.sz * 1.15) * (0.75 + Math.sin(tNow * 0.7 + i * 1.9) * 0.25);
        ctx.globalAlpha = (0.14 + 0.12 * (1 - i / N)) * w;
        // Instability rises sharply toward the centre. Jitter is per-ARM, not per-point, so
        // the inner rings fray out of symmetry instead of wobbling in lockstep.
        const centre = Math.max(0, 1 - (p.br0 - 47) / 354);
        const jAmp = centre * centre * 16;
        for (let kk = 0; kk < ARMS; kk++) {
          const a2 = p.ba + (kk / ARMS) * TAU;
          let x = W / 2 + Math.cos(a2) * rr;
          let y = H / 2 + Math.sin(a2) * rr * 0.72;
          if (jAmp > 0.15) {
            const ph = i * 2.3 + kk * 1.7;
            x += Math.sin(tNow * 5.5 + ph) * jAmp + Math.sin(tNow * 11.3 + ph * 1.9) * jAmp * 0.5;
            y += Math.cos(tNow * 6.1 + ph) * jAmp + Math.cos(tNow * 12.7 + ph * 2.3) * jAmp * 0.5;
          }
          ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
        }
        continue;
      }

      // Escaping: a SINGLE ring, no longer mirrored into the arms — breaking the symmetry is
      // what makes it read as one ring leaving rather than an eight-fold burst. It simply
      // keeps drifting outward and off the screen; no hugging or sliding along the edge.
      const m = 46;
      const ca = Math.abs(Math.cos(p.ba)), sa = Math.abs(Math.sin(p.ba));
      const edgeR = Math.min(ca > 1e-3 ? (W / 2 + m) / ca : 1e6,
                             sa > 1e-3 ? (H / 2 + m) / (0.72 * sa) : 1e6);
      p.br += p.escV * dt * mv;
      p.ba += p.bs * dt * mv * 0.18;
      // On reaching the screen edge it starts fading out over a random 5-10s. It keeps
      // drifting meanwhile, but by then the ring is large enough that a good part of it is
      // still on screen, so the fade actually reads.
      if (p.esc === 1 && p.br >= edgeR) { p.esc = 2; p.escFadeT = 0; p.escFadeDur = 3 + rnd() * 3; }
      let escAlpha = 1;
      if (p.esc === 2) {
        p.escFadeT += dt * mv;
        escAlpha = Math.max(0, 1 - p.escFadeT / p.escFadeDur);
        if (p.escFadeT >= p.escFadeDur) { p.esc = 0; p.br = p.br0; escaping--; continue; }
      }
      // swell as it nears the edge; escK spreads this from barely-any to very large
      const grow = 1 + Math.max(0, p.br - p.br0) / 250 * p.escK;
      const sz = Math.min(760, (14 + p.sz * 1.15) * grow);   // clamp: huge sprites are pure fill cost
      const x = W / 2 + Math.cos(p.ba) * p.br;
      const y = H / 2 + Math.sin(p.ba) * p.br * 0.72;
      ctx.globalAlpha = 0.26 * escAlpha * w;
      ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // Rain — directional fall. Wind is global, so instead of transforming 210 sprites the
  // canvas is rotated ONCE per frame and every streak is drawn vertically inside it; they
  // tilt together the way real wind-blown rain does, for one matrix op. The field is spawned
  // wider than the screen so the rotated corners stay covered.
  function mRain(pool, w, dt, mv) {
    if (!curtains.length) return;
    // two slow out-of-phase sines: a gentle, non-repeating gust rather than a metronome
    const gust = Math.sin(tNow * 0.085) * 0.62 + Math.sin(tNow * 0.031 + 1.3) * 0.38;
    const tilt = gust * 0.17;                       // radians, ~10 degrees at full gust
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(W / 2, 0); ctx.rotate(tilt); ctx.translate(-W / 2, 0);
    const nc = curtains.length;
    for (const p of pool) {
      p.ry += p.rs * dt * mv;
      p.rx += (gust * 26 + p.rd) * dt * mv;         // drift with the gust, plus its own bias
      if (p.ry - p.rl > H + 40) { p.ry = -p.rl - rnd() * 260; p.rx = -W * 0.25 + rnd() * W * 1.5; }
      if (p.rx < -W * 0.3) p.rx += W * 1.6; else if (p.rx > W * 1.3) p.rx -= W * 1.6;
      const near = p.rs > 600 ? 1 : (p.rs > 420 ? 0.68 : 0.42);
      const cw = p.rw * (0.55 + near * 0.85);       // per-streak width, scaled by depth
      ctx.globalAlpha = (0.14 + near * 0.34) * w;
      ctx.drawImage(curtains[p.si % nc], p.rx - cw / 2, p.ry - p.rl, cw, p.rl);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function renderMode(id, pool, w, dt, mv, k) {
    switch (id) {
      case 0: return mDrift(pool, w, dt, mv, k);
      case 1: return mOrbit(pool, w, dt, mv);
      case 2: return mAurora(pool, w);
      case 3: return mNebula(pool, w, dt, mv);
      case 4: return mStars(pool, w, dt, mv);
      case 5: return mRibbons(pool, w);
      case 6: return mLattice(pool, w, dt, mv);
      case 7: return mBloom(pool, w, dt, mv);
      case 8: return mRain(pool, w, dt, mv);
    }
  }

  function drawArt(cx, cy, size) {
    if (!artImg) return;
    if (glow) { const r = size * 1.15; ctx.drawImage(glow, cx - r, cy - r, r * 2, r * 2); }
    const x = cx - size / 2, y = cy - size / 2;
    ctx.save(); ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, size, size, 14); else ctx.rect(x, y, size, size);
    ctx.clip(); ctx.drawImage(artImg, x, y, size, size); ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, size, size, 14); else ctx.rect(x, y, size, size);
    ctx.stroke();
  }

  function drawInfo(st) {
    ctx.textAlign = 'center';
    let y = ART_CY + ART_SZ / 2 + 58;
    ctx.fillStyle = '#fff';
    ctx.font = '600 40px system-ui, sans-serif';
    ctx.fillText(st.title || '', W / 2, y);
    y += 40;
    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    ctx.font = '27px system-ui, sans-serif';
    ctx.fillText(st.artist || '', W / 2, y);
    // Singles often name the album after the track, and playing an album sets the context to
    // the album name — so both lines can echo something already on screen. Show each only once.
    const norm = x => (x || '').trim().toLowerCase();
    const showAlbum = st.album && norm(st.album) !== norm(st.title);
    const showCtx = st.context && norm(st.context) !== norm(st.album) && norm(st.context) !== norm(st.title);
    if (showAlbum) {
      y += 33;
      ctx.fillStyle = 'rgba(255,255,255,0.46)';
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(st.album, W / 2, y);
    }
    if (showCtx) {
      y += 30;
      const a = pal.acc[0] || [180, 200, 230];
      ctx.fillStyle = `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},0.72)`;
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(st.context, W / 2, y);
    }
  }

  function frame(ts) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (ts - lastDraw < 1000 / FPS - 1) return;      // frame cap
    lastDraw = ts;
    const st = opts.state() || {};
    if (!tPrev) tPrev = ts;
    let dt = (ts - tPrev) / 1000; tPrev = ts;
    if (dt > 0.1) dt = 0.1;
    const moving = st.paused ? 0.22 : 1;          // paused: keep drifting slowly, never freeze
    tNow += dt * moving;

    const id = st.uri || '';
    if (id && id !== lastTrack) {
      lastTrack = id;
      seed = hash(id) || 1;
      if (st.artUrl && st.artUrl !== artUrl) {
        artUrl = st.artUrl;
        palette(st.artUrl).then(p => { prevPal = pal || p; pal = p; palMix = 0; artImg = p.img; buildSprites(p); }).catch(() => {});
      }
    }
    if (!pal) return;
    if (palMix < 1) palMix = Math.min(1, palMix + dt * 0.8);

    const bg = prevPal ? pal.bg.map((v, i) => lerp(prevPal.bg[i], v, palMix)) : pal.bg;
    const prog = st.duration ? Math.min(1, st.position / st.duration) : 0;

    // Auto holds a mode, then cross-fades into the next by drawing both with complementary
    // weights — no offscreen buffers; every mode scales its own alphas by w.
    let curMode = mode, nxtMode = -1, mixW = 0;
    if (mode === AUTO) {
      autoT += dt * moving;
      if (autoT >= HOLD + FADE) {
        autoT -= HOLD + FADE;
        autoIdx = (autoIdx + 1) % MODES.length;
        const sw = poolA; poolA = poolB; poolB = sw;   // the faded-in pool becomes current
        autoNextReady = -1; modeUntil = tNow + 2;
      }
      curMode = autoIdx;
      if (autoT > HOLD) {
        nxtMode = (autoIdx + 1) % MODES.length;
        mixW = (autoT - HOLD) / FADE;
        if (autoNextReady !== nxtMode) { initFor(nxtMode, poolB); autoNextReady = nxtMode; }
      }
    }
    const trail = nxtMode >= 0 ? lerp(TRAIL[curMode], TRAIL[nxtMode], mixW) : TRAIL[curMode];

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0},${trail})`;
    ctx.fillRect(0, 0, W, H);

    const k = 0.75 + prog * 0.8;
    renderMode(curMode, poolA, nxtMode >= 0 ? 1 - mixW : 1, dt, moving, k);
    if (nxtMode >= 0) renderMode(nxtMode, poolB, mixW, dt, moving, k);

    ctx.globalCompositeOperation = 'source-over';
    drawArt(W / 2, ART_CY, ART_SZ * (1 + Math.sin(tNow * 0.55) * 0.013));
    drawInfo(st);

    // progress line + position marker; shows the seek target while scrubbing
    const barX = W * 0.18, barW = W * 0.64, barY = H - 42;
    const seeking = seekPreview != null;
    // ease toward the target so discrete presses glide rather than snapping in chunks
    if (seeking) seekShown = seekShown == null ? st.position : seekShown + (seekPreview - seekShown) * Math.min(1, dt * 7);
    else seekShown = null;
    const shown = seeking ? seekShown : st.position;
    const shownProg = st.duration ? Math.max(0, Math.min(1, shown / st.duration)) : 0;
    const a1 = pal.acc[0] || [255, 255, 255];
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(barX, barY, barW, 3);
    ctx.fillStyle = rgb(a1);
    ctx.fillRect(barX, barY, barW * shownProg, 3);
    ctx.beginPath();
    ctx.arc(barX + barW * shownProg, barY + 1.5, seeking ? 11 : 7, 0, Math.PI * 2);
    ctx.fillStyle = seeking ? '#ffffff' : rgb(a1);
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.stroke();
    ctx.font = '19px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = seeking ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.50)';
    ctx.fillText(mmss(shown), barX, barY - 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.50)';
    ctx.fillText(mmss(st.duration), barX + barW, barY - 16);
    if (st.paused && !seeking) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText('Paused', W / 2, barY - 16);
    }
    // mode name, briefly, after a cycle
    if (tNow < modeUntil) {
      ctx.globalAlpha = Math.min(1, modeUntil - tNow);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText(mode === AUTO ? `Auto · ${MODES[autoIdx]}` : MODES[mode], W - 112, 74);
      ctx.globalAlpha = 1;
    }
  }

  window.VIZ = {
    start(o) {
      opts = o;
      const host = document.getElementById('viz');
      if (!cv) {
        cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        host.appendChild(cv);
        ctx = cv.getContext('2d', { alpha: false });
        poolA = mkPool(NPART); poolB = mkPool(NPART);
      }
      seed = hash(lastTrack || 'x') || 1;
      initFor(mode === AUTO ? autoIdx : mode, poolA);
      ctx.fillStyle = '#07070b'; ctx.fillRect(0, 0, W, H);
      host.hidden = false;
      running = true; tPrev = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const host = document.getElementById('viz');
      if (host) host.hidden = true;
    },
    cycle(d) {
      mode = (mode + d + AUTO + 1) % (AUTO + 1);   // AUTO sits past the last real mode
      try { localStorage.viz_mode = String(mode); } catch (e) {}
      modeUntil = tNow + 2;
      if (mode === AUTO) { autoT = 0; autoIdx = 0; autoNextReady = -1; }
      initFor(mode === AUTO ? autoIdx : mode, poolA);
      console.log('[viz] mode:', this.modeName());
      return this.modeName();
    },
    modeName: () => (mode === AUTO ? 'Auto' : MODES[mode]),
    setSeekPreview(ms) { seekPreview = ms; },
  };
})();
