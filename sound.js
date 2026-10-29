/* Lira: Rune Forest: sound, music and haptics.
   Every effect is synthesized with Web Audio, so no files are needed.
   Music plays audio/music/<name>.m4a (the Suno tracks); with no file there is no music. */
const Sound = (() => {
  let ctx = null, master, sfxBus, musicBus, verb, opts = { sfx: true, music: true, haptics: true };
  const last = {};            // per-sound time of last play, for rate limits
  const live = {};            // per-sound count of voices still playing
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];   // major pentatonic, so cascades never sound sour
  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = opts.sfx ? 1 : 0; sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = opts.music ? 0.42 : 0; musicBus.connect(master);
    // small generated hall reverb for the sparkly sounds
    verb = ctx.createConvolver();
    const len = ctx.sampleRate * 1.6, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.22; verb.connect(wet).connect(master);
    loadSamples();
    if (pendingMusic) { const n = pendingMusic; pendingMusic = null; music(n); }
  }
  // recorded CC0 sounds from Kenney (audio/sfx/<name>_<n>.m4a) for things synthesis can't fake
  const SAMPLES = { step: 5, moss: 4, vinehit: 3, vinebreak: 5, bomb: 3, thorn: 3, chest: 1, coins: 2 };
  const buf = {};
  function loadSamples() {
    for (const [name, n] of Object.entries(SAMPLES)) for (let i = 0; i < n; i++)
      fetch(`audio/sfx/${name}_${i}.m4a`).then(r => r.ok ? r.arrayBuffer() : Promise.reject())
        .then(a => ctx.decodeAudioData(a)).then(b => { (buf[name] = buf[name] || []).push(b); }).catch(() => {});
  }
  // play a random take with a little pitch wobble; returns false if it isn't loaded, so callers can synthesize instead
  function sample(name, { gain = 0.6, t = 0, cents = 50, rate = 1 } = {}) {
    const list = buf[name]; if (!list || !list.length) return false;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rate * Math.pow(2, rnd(cents) / 1200);
    g.gain.value = gain; src.connect(g).connect(sfxBus);
    src.start(ctx.currentTime + t);
    return true;
  }
  // the first tap anywhere unlocks audio (required on iOS)
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(ev => addEventListener(ev, init, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else { ctx.resume(); fadeBus(musicBus, opts.music ? 0.42 : 0, 0.5, 0); }
  });

  const ok = (name, gap = 0, maxVoices = 3) => {
    if (!ctx || !opts.sfx || ctx.state !== 'running') return false;
    const t = performance.now();
    if (gap && last[name] && t - last[name] < gap) return false;
    if ((live[name] || 0) >= maxVoices) return false;
    last[name] = t; live[name] = (live[name] || 0) + 1;
    setTimeout(() => { live[name]--; }, 400);
    return true;
  };
  const rnd = (c = 50) => (Math.random() * 2 - 1) * c;     // random detune in cents

  /* ---------- building blocks ---------- */
  function env(g, t, a, peak, d, sustain = 0.0001) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + a + d);
  }
  function tone({ f, type = 'sine', t = 0, a = 0.005, d = 0.25, gain = 0.3, to = null, glide = 0.1, detune = 0, wet = 0, out = sfxBus, pan = 0 }) {
    const now = ctx.currentTime + t, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, now); o.detune.value = detune;
    if (to) o.frequency.exponentialRampToValueAtTime(to, now + glide);
    env(g, now, a, gain, d);
    let node = o.connect(g);
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(out);
    if (wet) { const w = ctx.createGain(); w.gain.value = wet; node.connect(w).connect(verb); }
    o.start(now); o.stop(now + a + d + 0.05);
  }
  let noiseBuf = null;
  function noise({ t = 0, a = 0.005, d = 0.2, gain = 0.2, type = 'bandpass', f = 1200, to = null, glide = 0.2, q = 1, wet = 0, out = sfxBus }) {
    if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d0 = noiseBuf.getChannelData(0); for (let i = 0; i < d0.length; i++) d0[i] = Math.random() * 2 - 1; }
    const now = ctx.currentTime + t, s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true; fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, now); if (to) fl.frequency.exponentialRampToValueAtTime(to, now + glide);
    env(g, now, a, gain, d);
    s.connect(fl).connect(g).connect(out);
    if (wet) { const w = ctx.createGain(); w.gain.value = wet; g.connect(w).connect(verb); }
    s.start(now); s.stop(now + a + d + 0.05);
  }
  // bell: a few inharmonic sine partials, the core of most magic sounds here
  function bell(f, { t = 0, d = 0.6, gain = 0.18, wet = 0.5, pan = 0 } = {}) {
    [[1, 1], [2.01, 0.45], [3.02, 0.22], [4.17, 0.1]].forEach(([m, k]) =>
      tone({ f: f * m, t, a: 0.003, d: d / Math.sqrt(m), gain: gain * k, wet, pan }));
  }
  function pluck(f, { t = 0, d = 0.5, gain = 0.2, wet = 0.3, out = sfxBus } = {}) {
    tone({ f, type: 'triangle', t, a: 0.004, d, gain, wet, out });
    tone({ f: f * 2, type: 'sine', t, a: 0.002, d: d * 0.4, gain: gain * 0.35, wet, out });
  }

  /* ---------- effects ---------- */
  const fx = {
    swap() { if (!ok('swap', 40)) return; noise({ f: 900, to: 2600, glide: 0.12, d: 0.12, gain: 0.12, q: 0.8 }); tone({ f: 520, to: 700, glide: 0.06, d: 0.08, gain: 0.12, type: 'triangle' }); },
    swapBad() { if (!ok('swapBad', 80)) return; tone({ f: 330, to: 220, glide: 0.12, d: 0.18, gain: 0.2, type: 'triangle' }); tone({ f: 220, to: 300, glide: 0.1, t: 0.12, d: 0.14, gain: 0.14, type: 'triangle' }); },
    // step = cascade depth (1 for the first clear); each step climbs the pentatonic scale
    match(step = 1, color = 0) {
      if (!ok('match', 45, 4)) return;
      const n = 72 + PENTA[Math.min(step - 1, PENTA.length - 1)];
      const f = hz(n) * Math.pow(2, rnd(15) / 1200);
      bell(f, { d: 0.45, gain: 0.16, wet: 0.35, pan: rnd(1) / 3 });
      noise({ f: 5000, d: 0.06, gain: 0.05, type: 'highpass' });
      if (step >= 3) bell(f * 2, { t: 0.04, d: 0.5, gain: 0.07 });
    },
    land() { if (!ok('land', 40, 2)) return; tone({ f: 1500 + rnd(300), d: 0.03, gain: 0.025, type: 'triangle' }); },
    shuffle() { if (!ok('shuffle', 300)) return; for (let i = 0; i < 8; i++) noise({ t: i * 0.04, f: 1800 + i * 300, d: 0.05, gain: 0.06, q: 3 }); },
    hint() { if (!ok('hint', 1500)) return; bell(hz(96), { d: 0.4, gain: 0.04, wet: 0.7 }); },
    special(tier = 1) {   // 1 line, 2 bomb, 3 prism
      if (!ok('special', 60)) return;
      const base = hz(72 + (tier - 1) * 4);
      tone({ f: base, to: base * 2, glide: 0.22, d: 0.3, gain: 0.12, type: 'triangle', wet: 0.3 });
      bell(base * 2, { t: 0.2, d: 0.7, gain: 0.16 });
      if (tier === 3) [0, 4, 7].forEach((s, i) => bell(base * 2 * Math.pow(2, s / 12), { t: 0.26 + i * 0.05, d: 0.6, gain: 0.08 }));
    },
    line() { if (!ok('line', 50)) return; noise({ f: 600, to: 7000, glide: 0.22, d: 0.28, gain: 0.18, q: 2, wet: 0.2 }); tone({ f: 900, to: 2400, glide: 0.2, d: 0.25, gain: 0.08, type: 'sawtooth' }); },
    bomb() {
      if (!ok('bomb', 60)) return;
      sample('bomb', { gain: 0.5 });
      tone({ f: 140, to: 45, glide: 0.25, d: 0.4, gain: 0.4 });
      noise({ type: 'lowpass', f: 1800, to: 200, glide: 0.35, d: 0.4, gain: 0.3 });
      for (let i = 0; i < 4; i++) bell(hz(84 + PENTA[i * 2]), { t: 0.08 + i * 0.05, d: 0.35, gain: 0.05 });
    },
    prism() {
      if (!ok('prism', 100)) return;
      noise({ f: 400, to: 9000, glide: 0.5, d: 0.6, gain: 0.12, q: 4, wet: 0.5 });
      for (let i = 0; i < 9; i++) bell(hz(76 + PENTA[i]), { t: i * 0.045, d: 0.7, gain: 0.08, pan: (i / 8) * 2 - 1 });
    },
    combo() {
      if (!ok('combo', 150)) return;
      noise({ f: 300, to: 4000, glide: 0.3, a: 0.28, d: 0.06, gain: 0.15, q: 1 });
      tone({ f: 120, to: 50, t: 0.32, glide: 0.3, d: 0.45, gain: 0.5 });
      [0, 4, 7, 12].forEach((s, i) => bell(hz(79 + s), { t: 0.32 + i * 0.03, d: 0.8, gain: 0.1 }));
    },
    moss() { if (!ok('moss', 40, 3)) return; if (sample('moss', { gain: 0.5, rate: 1.15 })) { tone({ f: 900 + rnd(100), t: 0.05, d: 0.08, gain: 0.04 }); return; } noise({ f: 2500, to: 900, glide: 0.12, d: 0.14, gain: 0.12, q: 1.5 }); tone({ f: 600 + rnd(80), to: 900, glide: 0.05, t: 0.08, d: 0.07, gain: 0.08, type: 'sine' }); },
    vineHit() { if (!ok('vineHit', 60)) return; if (sample('vinehit', { gain: 0.45 })) return; tone({ f: 180, to: 150, glide: 0.2, d: 0.22, gain: 0.12, type: 'sawtooth' }); noise({ f: 700, d: 0.15, gain: 0.06, q: 6 }); },
    vineBreak() { if (!ok('vineBreak', 50)) return; if (sample('vinebreak', { gain: 0.55, rate: 1.2 })) { sample('moss', { gain: 0.3, t: 0.03, rate: 1.3 }); return; } noise({ type: 'highpass', f: 2500, d: 0.05, gain: 0.3 }); noise({ t: 0.03, f: 3000, to: 1200, glide: 0.2, d: 0.22, gain: 0.08, q: 1 }); },
    step() { if (!ok('step', 90)) return; if (sample('step', { gain: 0.7, rate: 1.25 })) return; tone({ f: 380 + rnd(40), to: 300, glide: 0.04, d: 0.06, gain: 0.12, type: 'triangle' }); noise({ type: 'lowpass', f: 900, d: 0.05, gain: 0.05 }); },
    gate() {
      if (!ok('gate', 500)) return;
      tone({ f: hz(55), d: 1.6, a: 0.4, gain: 0.12, type: 'sine', wet: 0.5 });
      tone({ f: hz(62), d: 1.6, a: 0.4, gain: 0.08, type: 'sine', wet: 0.5 });
      [0, 4, 7, 11, 14].forEach((s, i) => bell(hz(79 + s), { t: 0.3 + i * 0.09, d: 1, gain: 0.08 }));
    },
    charge(fill = 0) { if (!ok('charge', 70)) return; tone({ f: hz(84 + Math.round(fill * 12)), d: 0.06, gain: 0.035, type: 'sine', wet: 0.2 }); },
    spellReady() { if (!ok('spellReady', 300)) return; [0, 7, 12].forEach((s, i) => bell(hz(84 + s), { t: i * 0.07, d: 0.7, gain: 0.12 })); },
    sunbeam() {
      if (!ok('sunbeam', 200)) return;
      tone({ f: 220, to: 880, glide: 0.4, a: 0.1, d: 0.6, gain: 0.14, type: 'sawtooth', wet: 0.4 });
      noise({ f: 1000, to: 6000, glide: 0.4, a: 0.1, d: 0.5, gain: 0.1, q: 2, wet: 0.4 });
      [0, 4, 7, 12].forEach((s, i) => bell(hz(81 + s), { t: 0.35 + i * 0.05, d: 0.8, gain: 0.09 }));
    },
    crystal() {
      if (!ok('crystal', 200)) return;
      noise({ type: 'highpass', f: 4000, d: 0.25, gain: 0.25 });
      for (let i = 0; i < 10; i++) bell(hz(96 - PENTA[i % 6] + (i > 5 ? -12 : 0)) * Math.pow(2, rnd(30) / 1200), { t: i * 0.03, d: 0.5, gain: 0.07, pan: rnd(1) });
    },
    gift() {
      if (!ok('gift', 200)) return;
      noise({ f: 1500, to: 4000, glide: 0.5, d: 0.5, gain: 0.06, q: 0.7 });
      [0, 2, 4, 7, 9, 12].forEach((s, i) => pluck(hz(74 + s), { t: i * 0.06, d: 0.6, gain: 0.12 }));
      for (let i = 0; i < 3; i++) tone({ f: 3200, to: 4200, glide: 0.06, t: 0.4 + i * 0.12, d: 0.07, gain: 0.04 });   // birdsong chirps
    },
    thorn() { if (!ok('thorn', 120)) return; if (sample('thorn', { gain: 0.5, rate: 1.1 })) { tone({ f: 200, to: 80, t: 0.12, glide: 0.1, d: 0.15, gain: 0.3 }); return; } noise({ f: 1200, to: 6000, glide: 0.06, d: 0.08, gain: 0.25, q: 2 }); tone({ f: 200, to: 80, t: 0.06, glide: 0.1, d: 0.15, gain: 0.35 }); },
    tap() { if (!ok('tap', 40)) return; tone({ f: 900, to: 650, glide: 0.04, d: 0.05, gain: 0.1, type: 'triangle' }); },
    back() { if (!ok('back', 40)) return; tone({ f: 600, to: 420, glide: 0.05, d: 0.06, gain: 0.1, type: 'triangle' }); },
    open() { if (!ok('open', 120)) return; noise({ f: 500, to: 2500, glide: 0.18, d: 0.2, gain: 0.07, q: 0.7 }); },
    close() { if (!ok('close', 120)) return; noise({ f: 2500, to: 500, glide: 0.16, d: 0.17, gain: 0.06, q: 0.7 }); },
    card() { if (!ok('card', 300)) return; noise({ f: 1200, to: 3000, glide: 0.1, d: 0.12, gain: 0.06 }); [0, 7].forEach((s, i) => bell(hz(88 + s), { t: 0.08 + i * 0.07, d: 0.5, gain: 0.07 })); },
    lowTick() { if (!ok('lowTick', 200)) return; tone({ f: 70, d: 0.09, gain: 0.25 }); tone({ f: 60, t: 0.14, d: 0.12, gain: 0.18 }); },
    goal() { if (!ok('goal', 120)) return; [0, 4, 7].forEach((s, i) => bell(hz(84 + s), { t: i * 0.06, d: 0.5, gain: 0.11 })); },
    coins(n = 6) { for (let i = 0; i < n; i++) setTimeout(() => { if (!ok('coin', 0, 6)) return; tone({ f: hz(88 + PENTA[i % 6]), d: 0.12, gain: 0.08, type: 'square' }); tone({ f: hz(100 + PENTA[i % 6]), d: 0.08, gain: 0.04 }); }, i * 55); },
    star(k = 0) { if (!ok('star' + k, 0)) return; bell(hz(79 + [0, 4, 7][k]), { d: 0.9, gain: 0.18 }); bell(hz(91 + [0, 4, 7][k]), { t: 0.03, d: 0.6, gain: 0.07 }); },
    purchase() { if (!ok('purchase', 300)) return; tone({ f: 1800, d: 0.05, gain: 0.08, type: 'square' }); [0, 4, 7, 12].forEach((s, i) => bell(hz(84 + s), { t: 0.06 + i * 0.06, d: 0.6, gain: 0.1 })); fx.coins(5); sample('coins', { gain: 0.45, t: 0.05 }); },
    lifeLost() { if (!ok('lifeLost', 300)) return; tone({ f: 520, to: 260, glide: 0.4, d: 0.45, gain: 0.14, type: 'triangle' }); },
    lifeRefill() { if (!ok('lifeRefill', 300)) return; [0, 5, 9].forEach((s, i) => bell(hz(81 + s), { t: i * 0.08, d: 0.6, gain: 0.1 })); },
    daily() { if (!ok('daily', 400)) return; if (sample('chest', { gain: 0.5, cents: 0 })) { sample('coins', { gain: 0.6, t: 0.5, cents: 0 }); [0, 4, 7, 12, 16].forEach((s, i) => bell(hz(79 + s), { t: 0.6 + i * 0.06, d: 0.6, gain: 0.08 })); return; } tone({ f: 160, to: 110, glide: 0.25, d: 0.3, gain: 0.08, type: 'sawtooth' }); [0, 4, 7, 12, 16].forEach((s, i) => bell(hz(79 + s), { t: 0.3 + i * 0.06, d: 0.6, gain: 0.1 })); },
    moves(n = 3) { for (let i = 0; i < n; i++) setTimeout(() => { if (!ok('mv', 0, 6)) return; pluck(hz(76 + PENTA[i]), { d: 0.25, gain: 0.14 }); }, i * 90); },
    hop() { if (!ok('hop', 300)) return; tone({ f: 300, to: 700, glide: 0.18, d: 0.2, gain: 0.12, type: 'triangle' }); noise({ t: 0.85, type: 'lowpass', f: 800, d: 0.12, gain: 0.08 }); },
    unlockNode() { if (!ok('unlockNode', 300)) return; tone({ f: 1400, d: 0.04, gain: 0.08, type: 'square' }); bell(hz(91), { t: 0.05, d: 0.7, gain: 0.12 }); },
    confetti() { if (!ok('confetti', 500)) return; noise({ type: 'highpass', f: 1500, d: 0.08, gain: 0.3 }); for (let i = 0; i < 10; i++) noise({ t: 0.05 + Math.random() * 0.5, f: 4000 + Math.random() * 3000, d: 0.04, gain: 0.03, q: 4 }); },
    reveal() { if (!ok('reveal', 500)) return; noise({ f: 300, to: 3000, glide: 1, a: 0.6, d: 0.6, gain: 0.08, q: 0.6, wet: 0.5 }); },
    // short stings until the Suno ones arrive
    win() {
      if (!ok('win', 1000)) return; duck(2.6);
      const seq = [[0, 0], [4, 0.12], [7, 0.24], [12, 0.36], [16, 0.6], [19, 0.6]];
      seq.forEach(([s, t]) => { bell(hz(72 + s), { t, d: 1.2, gain: 0.14 }); pluck(hz(60 + s), { t, d: 0.8, gain: 0.08 }); });
      for (let i = 0; i < 8; i++) tone({ f: hz(84 + PENTA[i]), t: 0.6 + i * 0.03, d: 0.4, gain: 0.04, wet: 0.6 });
    },
    fail() {
      if (!ok('fail', 1000)) return; duck(2.4);
      [[7, 0], [4, 0.22], [2, 0.44], [0, 0.7]].forEach(([s, t]) => bell(hz(72 + s), { t, d: 0.9, gain: 0.12 }));
      tone({ f: hz(48), a: 0.3, d: 1.6, gain: 0.08, wet: 0.5 }); tone({ f: hz(55), a: 0.3, d: 1.6, gain: 0.05, wet: 0.5 });
    },
    fanfare() {
      if (!ok('fanfare', 2000)) return; duck(5);
      noise({ f: 200, to: 5000, glide: 1.2, a: 1.1, d: 0.3, gain: 0.08, type: 'highpass', wet: 0.5 });
      [[0, 0.2], [7, 0.2], [12, 0.2], [4, 0.6], [11, 0.6], [16, 0.6], [7, 1.0], [14, 1.0], [19, 1.0], [24, 1.3]].forEach(([s, t]) => {
        tone({ f: hz(60 + s), t, a: 0.08, d: 1.4, gain: 0.06, type: 'sawtooth', wet: 0.5 });
        bell(hz(72 + s), { t, d: 1.4, gain: 0.08 });
      });
      tone({ f: hz(36), t: 1.3, a: 0.05, d: 2, gain: 0.25, wet: 0.4 });
    },
  };

  /* ---------- haptics ---------- */
  function haptic(kind) {
    if (!opts.haptics) return;
    const t = performance.now(); if (last.hap && t - last.hap < 100) return; last.hap = t;
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    try {
      if (H) {
        if (kind === 'success' || kind === 'warning') H.notification({ type: kind.toUpperCase() });
        else if (kind === 'select') H.selectionChanged ? H.selectionChanged() : H.impact({ style: 'LIGHT' });
        else H.impact({ style: kind.toUpperCase() });
      } else if (navigator.vibrate) {
        navigator.vibrate({ light: 8, medium: 18, heavy: 35, select: 5, success: [20, 60, 30], warning: [40, 80, 40] }[kind] || 10);
      }
    } catch (e) {}
  }

  /* ---------- music ---------- */
  let current = null, pendingMusic = null, gen = null, fileEl = null, urgent = false;
  const WORLD = {      // root note and timbre per track, for the generated fallback
    map: { root: 65, bpm: 92, wave: 'triangle', bell: true },
    woods: { root: 67, bpm: 104, wave: 'triangle' },
    caves: { root: 64, bpm: 100, wave: 'sine', bell: true },
    marsh: { root: 62, bpm: 96, wave: 'sine' },
    moon: { root: 69, bpm: 104, wave: 'triangle', bell: true },
    shop: { root: 72, bpm: 84, wave: 'sine', bell: true },
  };
  function fadeBus(bus, to, sec, delay = 0) { if (!ctx) return; const t = ctx.currentTime + delay; bus.gain.cancelScheduledValues(t); bus.gain.setValueAtTime(bus.gain.value, t); bus.gain.linearRampToValueAtTime(to, t + sec); }
  function duck(sec) { if (!ctx || !opts.music) return; fadeBus(musicBus, 0.08, 0.05); fadeBus(musicBus, 0.42, 0.6, sec); }
  function stopMusic() {
    if (gen) { clearInterval(gen.timer); gen = null; }
    if (fileEl) { const el = fileEl; fileEl = null; el.pause(); }
  }
  function music(name) {
    if (name === current && (gen || fileEl)) return;
    current = name;
    if (!ctx) { pendingMusic = name; return; }
    stopMusic();
    if (!name) return;
    // try a real track first; fall back to the generated loop if it's missing
    const el = new Audio(`audio/music/${name}.m4a`); el.loop = true; el.preload = 'auto';
    el.oncanplaythrough = () => {
      if (current !== name || fileEl) return;
      if (gen) { clearInterval(gen.timer); gen = null; }
      fileEl = el;
      try { const src = ctx.createMediaElementSource(el); src.connect(musicBus); } catch (e) {}
      el.play().catch(() => {});
    };
    // no generated fallback: until a real track exists the game stays quiet (the synth loop sounded beepy)
    el.load();
  }

  return {
    play(name, ...args) { try { if (fx[name]) fx[name](...args); } catch (e) {} },
    haptic,
    music,
    urgent(on) { urgent = !!on; },
    duck,
    set(o) {
      Object.assign(opts, o);
      if (!ctx) return;
      fadeBus(sfxBus, opts.sfx ? 1 : 0, 0.1);
      fadeBus(musicBus, opts.music ? 0.42 : 0, 0.3);
    },
    get opts() { return { ...opts }; },
  };
})();
