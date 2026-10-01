'use strict';

(function () {
  // Web Audio synthesized sounds — no external files required.
  let ctx = null;
  let soundEnabled = localStorage.getItem('tp_sound') !== 'off';
  let musicEnabled = localStorage.getItem('tp_music') !== 'off';
  let musicNode = null;
  let musicGain = null;

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { ctx = null; }
    return ctx;
  }

  function resume() {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  function tone({ freq = 440, dur = 0.12, type = 'sine', vol = 0.18, attack = 0.005, release = 0.08, detune = 0 }) {
    const c = ensureCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    if (detune) osc.detune.value = detune;
    const t0 = c.currentTime;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.02);
  }

  function noiseBurst({ dur = 0.15, vol = 0.12, filterFreq = 1200, q = 1 }) {
    const c = ensureCtx();
    if (!c) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = filterFreq; filter.Q.value = q;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(filter); filter.connect(g); g.connect(c.destination);
    src.start();
  }

  const SOUNDS = {
    click:    () => tone({ freq: 700, dur: 0.05, type: 'triangle', vol: 0.12 }),
    shuffle:  () => { for (let i = 0; i < 6; i++) setTimeout(() => noiseBurst({ dur: 0.09, vol: 0.10, filterFreq: 2400, q: 1.2 }), i * 45); },
    deal:     () => { noiseBurst({ dur: 0.10, vol: 0.14, filterFreq: 3000, q: 1.4 }); tone({ freq: 900, dur: 0.05, type: 'triangle', vol: 0.08 }); },
    flip:     () => { tone({ freq: 1200, dur: 0.05, type: 'triangle', vol: 0.10 }); noiseBurst({ dur: 0.06, vol: 0.07, filterFreq: 3200 }); },
    chip:     () => { tone({ freq: 900, dur: 0.08, type: 'square', vol: 0.10 }); tone({ freq: 1400, dur: 0.06, type: 'square', vol: 0.08 }); },
    chaal:    () => { tone({ freq: 520, dur: 0.10, type: 'sine', vol: 0.16 }); tone({ freq: 780, dur: 0.10, type: 'sine', vol: 0.12 }); },
    chaal2x:  () => { tone({ freq: 520, dur: 0.10, type: 'sine', vol: 0.18 }); setTimeout(() => tone({ freq: 1040, dur: 0.14, type: 'sine', vol: 0.16 }), 80); },
    pack:     () => { tone({ freq: 320, dur: 0.18, type: 'sawtooth', vol: 0.14 }); },
    sideshow: () => { tone({ freq: 660, dur: 0.10, type: 'triangle', vol: 0.14 }); setTimeout(() => tone({ freq: 880, dur: 0.12, type: 'triangle', vol: 0.14 }), 90); },
    show:     () => { tone({ freq: 900, dur: 0.10, type: 'sine', vol: 0.16 }); setTimeout(() => tone({ freq: 1200, dur: 0.14, type: 'sine', vol: 0.16 }), 100); },
    yourturn: () => { tone({ freq: 880, dur: 0.12, type: 'sine', vol: 0.18 }); setTimeout(() => tone({ freq: 1320, dur: 0.14, type: 'sine', vol: 0.18 }), 120); },
    join:     () => { tone({ freq: 660, dur: 0.10, type: 'sine', vol: 0.15 }); setTimeout(() => tone({ freq: 990, dur: 0.12, type: 'sine', vol: 0.15 }), 90); },
    leave:    () => { tone({ freq: 660, dur: 0.12, type: 'sine', vol: 0.13 }); setTimeout(() => tone({ freq: 440, dur: 0.14, type: 'sine', vol: 0.13 }), 100); },
    warning:  () => { tone({ freq: 1200, dur: 0.06, type: 'square', vol: 0.14 }); },
    roundstart: () => { tone({ freq: 523, dur: 0.10, type: 'triangle', vol: 0.15 }); setTimeout(() => tone({ freq: 659, dur: 0.10, type: 'triangle', vol: 0.15 }), 110); setTimeout(() => tone({ freq: 784, dur: 0.14, type: 'triangle', vol: 0.15 }), 220); },
    winner:   () => { const seq = [523, 659, 784, 1046]; seq.forEach((f, i) => setTimeout(() => tone({ freq: f, dur: 0.18, type: 'triangle', vol: 0.20 }), i * 130)); },
    result:   () => { tone({ freq: 620, dur: 0.14, type: 'sine', vol: 0.16 }); },
    error:    () => { tone({ freq: 220, dur: 0.16, type: 'sawtooth', vol: 0.14 }); }
  };

  function play(name) {
    if (!soundEnabled) return;
    resume();
    const fn = SOUNDS[name];
    if (fn) try { fn(); } catch (e) { /* ignore */ }
  }

  // Ambient music: soft evolving pad using oscillators
  function startMusic() {
    if (!musicEnabled) return;
    const c = ensureCtx();
    if (!c) return;
    if (musicNode) return;
    musicGain = c.createGain();
    musicGain.gain.value = 0.04;
    musicGain.connect(c.destination);

    const freqs = [130.81, 164.81, 196.00, 246.94];
    const oscs = freqs.map((f, i) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.value = 0.15;
      o.connect(g); g.connect(musicGain);
      o.start();
      // slow LFO
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.02;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 0.6;
      lfo.connect(lfoGain); lfoGain.connect(g.gain);
      lfo.start();
      return { o, lfo };
    });
    musicNode = { oscs };
  }

  function stopMusic() {
    if (!musicNode) return;
    try {
      for (const { o, lfo } of musicNode.oscs) { o.stop(); lfo.stop(); }
    } catch (e) {}
    musicNode = null;
  }

  function setSound(on) {
    soundEnabled = !!on;
    localStorage.setItem('tp_sound', on ? 'on' : 'off');
  }
  function setMusic(on) {
    musicEnabled = !!on;
    localStorage.setItem('tp_music', on ? 'on' : 'off');
    if (on) startMusic(); else stopMusic();
  }

  window.Audio2 = {
    play, setSound, setMusic, resume,
    isSoundOn: () => soundEnabled,
    isMusicOn: () => musicEnabled,
    startMusic
  };
})();
