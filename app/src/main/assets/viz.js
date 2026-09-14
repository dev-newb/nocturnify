// viz.js — ambient now-playing visualiser.
//
// Deliberately NOT audio-reactive, because it cannot be: the Web Playback SDK exposes
// no media element to the DOM (probe: 0 elements), so Web Audio has nothing to tap, and
// /audio-analysis + /audio-features are 403 for Development-mode apps — no beats, no tempo.
// Faking a BPM pulse drifts against the real music and looks worse than honest motion.
//
// What IS real and drives everything here:
//   * the album art's actual pixels (i.scdn.co sends access-control-allow-origin: *)
//   * true playback position / duration / paused state
//   * a per-track seed, so each song gets its own character deterministically
(function () {
  const W = 1280, H = 720;          // internal resolution; CSS scales it to the panel
  const NPART = 240;

  let cv, ctx, raf = 0, opts = null, running = false;
  let parts = [], sprites = [], pal = null, prevPal = null, palMix = 1;
  let artImg = null, artUrl = '', lastTrack = '';
  let seed = 1, tPrev = 0, tNow = 0, textUntil = 0;

  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const lerp = (a, b, m) => a + (b - a) * m;
  const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

  // ---- palette straight out of the cover art -------------------------------
  async function palette(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('art load')); img.src = url; });
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

  // Pre-rendered soft dots: additive blending of these is what makes the ribbons glow.
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
  }

  function spawn(p, fresh) {
    p.x = rnd() * W; p.y = rnd() * H;
    p.sp = 14 + rnd() * 46;
    p.sz = 12 + rnd() * 46;
    p.si = (rnd() * sprites.length) | 0;
    p.life = 3 + rnd() * 7;
    p.age = fresh ? rnd() * p.life : 0;
  }

  // Smooth divergence-free-ish flow field: cheap sinusoids, no noise texture needed.
  function field(x, y, t, k) {
    const s = 0.0024 * k;
    return Math.sin(x * s + t * 0.26) * 1.8
         + Math.cos(y * s * 1.27 - t * 0.20) * 1.8
         + Math.sin((x + y) * s * 0.55 + t * 0.12) * 1.25;
  }

  function drawArt(st, cx, cy, size) {
    if (!artImg) return;
    // glow pad behind the cover
    const g = ctx.createRadialGradient(cx, cy, size * 0.30, cx, cy, size * 1.15);
    const a = pal.acc[0] || [120, 140, 180];
    g.addColorStop(0, `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},0.42)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - size * 1.2, cy - size * 1.2, size * 2.4, size * 2.4);

    const h = size, x = cx - h / 2, y = cy - h / 2;
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, h, h, 14); else ctx.rect(x, y, h, h);
    ctx.clip();
    ctx.drawImage(artImg, x, y, h, h);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, h, h, 14); else ctx.rect(x, y, h, h);
    ctx.stroke();
  }

  function frame(ts) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const st = opts.state() || {};
    if (!tPrev) tPrev = ts;
    let dt = (ts - tPrev) / 1000; tPrev = ts;
    if (dt > 0.1) dt = 0.1;                      // clamp after a stall
    const moving = st.paused ? 0.22 : 1;         // paused: drift, don't freeze
    tNow += dt * moving;

    // new track -> reseed + re-extract palette
    const id = st.uri || '';
    if (id && id !== lastTrack) {
      lastTrack = id;
      seed = hash(id) || 1;
      textUntil = tNow + 6;
      if (st.artUrl && st.artUrl !== artUrl) {
        artUrl = st.artUrl;
        palette(st.artUrl).then(p => {
          prevPal = pal || p; pal = p; palMix = 0; artImg = p.img; buildSprites(p);
        }).catch(() => {});
      }
    }
    if (!pal) return;
    if (palMix < 1) palMix = Math.min(1, palMix + dt * 0.8);

    const bg = prevPal ? pal.bg.map((v, i) => lerp(prevPal.bg[i], v, palMix)) : pal.bg;
    const prog = st.duration ? Math.min(1, st.position / st.duration) : 0;
    const k = 0.75 + prog * 0.8;                 // field tightens as the track progresses

    // trails instead of a hard clear
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0},0.135)`;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      const ang = field(p.x, p.y, tNow, k);
      p.x += Math.cos(ang) * p.sp * dt * moving;
      p.y += Math.sin(ang) * p.sp * dt * moving;
      p.age += dt * moving;
      if (p.age > p.life || p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) spawn(p, false);
      const f = Math.sin(Math.min(1, p.age / p.life) * Math.PI);   // fade in/out over life
      const s = sprites[p.si]; if (!s) continue;
      ctx.globalAlpha = 0.30 * f;
      ctx.drawImage(s, p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const breathe = 1 + Math.sin(tNow * 0.55) * 0.013;
    drawArt(st, W / 2, H * 0.44, 300 * breathe);

    // title / artist, fading to a clean screensaver after a few seconds
    const tf = Math.max(0, Math.min(1, textUntil - tNow));
    if (tf > 0.01) {
      ctx.globalAlpha = tf;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.font = '600 38px system-ui, sans-serif';
      ctx.fillText(st.title || '', W / 2, H * 0.44 + 215);
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.font = '26px system-ui, sans-serif';
      ctx.fillText(st.artist || '', W / 2, H * 0.44 + 255);
      ctx.globalAlpha = 1;
    }

    // progress line
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(W * 0.18, H - 46, W * 0.64, 3);
    const a0 = pal.acc[0] || [255, 255, 255];
    ctx.fillStyle = rgb(a0);
    ctx.fillRect(W * 0.18, H - 46, W * 0.64 * prog, 3);
    if (st.paused) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText('Paused', W / 2, H - 62);
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
        parts = Array.from({ length: NPART }, () => { const p = {}; return p; });
      }
      seed = hash(lastTrack || 'x') || 1;
      parts.forEach(p => spawn(p, true));
      ctx.fillStyle = '#07070b'; ctx.fillRect(0, 0, W, H);
      host.hidden = false;
      running = true; tPrev = 0; textUntil = tNow + 6;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf), raf = 0;
      const host = document.getElementById('viz');
      if (host) host.hidden = true;
    },
    poke() { textUntil = tNow + 6; },      // any keypress re-shows the track text
  };
})();
