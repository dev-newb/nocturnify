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
  const NPART = 240;
  const MODES = ['Drift', 'Orbit', 'Aurora'];
  const ART_CY = H * 0.355, ART_SZ = 268;

  let cv, ctx, raf = 0, opts = null, running = false;
  let parts = [], sprites = [], curtains = [], pal = null, prevPal = null, palMix = 1;
  let artImg = null, artUrl = '', lastTrack = '';
  let seed = 1, tPrev = 0, tNow = 0, mode = 0, modeUntil = 0;

  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const lerp = (a, b, m) => a + (b - a) * m;
  const rgb = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

  try { mode = Math.max(0, Math.min(MODES.length - 1, parseInt(localStorage.viz_mode || '0', 10) || 0)); } catch (e) {}

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

  function spawn(p, fresh) {
    p.x = rnd() * W; p.y = rnd() * H;
    p.sp = 14 + rnd() * 46;
    p.sz = 12 + rnd() * 46;
    p.si = (rnd() * Math.max(1, sprites.length)) | 0;
    p.life = 3 + rnd() * 7;
    p.age = fresh ? rnd() * p.life : 0;
    p.r = 150 + rnd() * 430;                 // orbit radius
    p.a = rnd() * Math.PI * 2;               // orbit angle
    p.dir = rnd() < 0.5 ? -1 : 1;
  }

  function field(x, y, t, k) {
    const s = 0.0024 * k;
    return Math.sin(x * s + t * 0.26) * 1.8
         + Math.cos(y * s * 1.27 - t * 0.20) * 1.8
         + Math.sin((x + y) * s * 0.55 + t * 0.12) * 1.25;
  }

  function drawParticles(dt, moving, k) {
    ctx.globalCompositeOperation = 'lighter';
    if (mode === 2) {                                   // Aurora: layered curtains
      if (!curtains.length) return;
      for (let i = 0; i < 7; i++) {
        const x = W / 2 + Math.sin(tNow * 0.17 + i * 1.7) * W * 0.36;
        const w = 130 + Math.sin(tNow * 0.23 + i * 2.1) * 70;
        const hh = H * (0.75 + Math.sin(tNow * 0.13 + i) * 0.18);
        const y = H * 0.5 - hh / 2 + Math.sin(tNow * 0.11 + i * 0.9) * 40;
        ctx.globalAlpha = 0.20;
        ctx.drawImage(curtains[i % curtains.length], x - w / 2, y, w, hh);
      }
      ctx.globalAlpha = 1;
      return;
    }
    for (const p of parts) {
      if (mode === 1) {                                 // Orbit: elliptical rings round the art
        p.a += p.dir * (0.34 / (0.45 + p.r / 300)) * dt * moving;
        p.x = W / 2 + Math.cos(p.a) * p.r;
        p.y = ART_CY + Math.sin(p.a) * p.r * 0.52;
        p.age += dt * moving;
        if (p.age > p.life) spawn(p, false);
      } else {                                          // Drift: flow field
        const ang = field(p.x, p.y, tNow, k);
        p.x += Math.cos(ang) * p.sp * dt * moving;
        p.y += Math.sin(ang) * p.sp * dt * moving;
        p.age += dt * moving;
        if (p.age > p.life || p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) spawn(p, false);
      }
      const f = Math.sin(Math.min(1, p.age / p.life) * Math.PI);
      const s = sprites[p.si]; if (!s) continue;
      ctx.globalAlpha = 0.30 * f;
      ctx.drawImage(s, p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz);
    }
    ctx.globalAlpha = 1;
  }

  function drawArt(cx, cy, size) {
    if (!artImg) return;
    const a = pal.acc[0] || [120, 140, 180];
    const g = ctx.createRadialGradient(cx, cy, size * 0.30, cx, cy, size * 1.15);
    g.addColorStop(0, `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},0.42)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - size * 1.2, cy - size * 1.2, size * 2.4, size * 2.4);
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
    if (st.album) {
      y += 33;
      ctx.fillStyle = 'rgba(255,255,255,0.46)';
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillText(st.album, W / 2, y);
    }
    if (st.context) {
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

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${bg[0] | 0},${bg[1] | 0},${bg[2] | 0},${mode === 2 ? 0.09 : 0.135})`;
    ctx.fillRect(0, 0, W, H);

    drawParticles(dt, moving, 0.75 + prog * 0.8);

    ctx.globalCompositeOperation = 'source-over';
    drawArt(W / 2, ART_CY, ART_SZ * (1 + Math.sin(tNow * 0.55) * 0.013));
    drawInfo(st);

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(W * 0.18, H - 42, W * 0.64, 3);
    ctx.fillStyle = rgb(pal.acc[0] || [255, 255, 255]);
    ctx.fillRect(W * 0.18, H - 42, W * 0.64 * prog, 3);
    if (st.paused) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText('Paused', W / 2, H - 58);
    }
    // mode name, briefly, after a cycle
    if (tNow < modeUntil) {
      ctx.globalAlpha = Math.min(1, modeUntil - tNow);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText(MODES[mode], W - 112, 74);
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
        parts = Array.from({ length: NPART }, () => ({}));
      }
      seed = hash(lastTrack || 'x') || 1;
      parts.forEach(p => spawn(p, true));
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
      mode = (mode + d + MODES.length) % MODES.length;
      try { localStorage.viz_mode = String(mode); } catch (e) {}
      modeUntil = tNow + 2;
      parts.forEach(p => spawn(p, true));
      return MODES[mode];
    },
    modeName: () => MODES[mode],
  };
})();
