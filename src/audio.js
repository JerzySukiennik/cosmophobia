// ---------------------------------------------------------------------------
// Sound. Space is silent, so everything you hear is either inside your helmet
// (breath, heartbeat, fans, the hiss of your jets through the backpack),
// on the radio (Quindar tones, static, voices), or conducted through whatever
// your gloves are touching. The score is the only thing that isn't real.
// All of it is synthesised here with the Web Audio API.
// ---------------------------------------------------------------------------

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function makeNoise(ctx, seconds = 2, type = 'white') {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else if (type === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

function makeIR(ctx, seconds, decay, { bright = 1, stereo = true, predelay = 0 } = {}) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ch = stereo ? 2 : 1;
  const buf = ctx.createBuffer(ch, len, ctx.sampleRate);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    const pd = Math.floor(predelay * ctx.sampleRate);
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / ctx.sampleRate;
      const w = Math.random() * 2 - 1;
      lp += (w - lp) * clamp(bright * (1 - t / seconds), 0.02, 1);
      d[i] = lp * Math.pow(1 - (i - pd) / (len - pd), decay);
    }
  }
  return buf;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.musicLevel = 1;
    this.volume = 1;
    this._alarm = { level: 0, next: 0 };
    this._heartNext = 0;
    this._lastPhase = 0;
    this._rotPuff = 0;
    this._thrustOn = false;
    this._beacon = { rate: 0, next: 0 };
    this.tension = 0;
    this.speaking = false;
  }

  async start() {
    if (this.started) return this.ctx.resume();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.started = true;
    this.white = makeNoise(ctx, 3, 'white');
    this.pink = makeNoise(ctx, 4, 'pink');
    this.brown = makeNoise(ctx, 4, 'brown');

    // ----- master chain -----
    this.master = ctx.createGain();
    this.master.gain.value = 0.9 * this.volume;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.master.connect(this.muffle).connect(comp).connect(ctx.destination);

    // ----- helmet: short bright IR + comb resonance -----
    this.helmet = ctx.createGain();
    const helmetDry = ctx.createGain();
    helmetDry.gain.value = 0.8;
    const helmetVerb = ctx.createConvolver();
    helmetVerb.buffer = makeIR(ctx, 0.14, 2.5, { bright: 0.9 });
    const helmetWet = ctx.createGain();
    helmetWet.gain.value = 0.35;
    const comb = ctx.createDelay(0.05);
    comb.delayTime.value = 0.0021;
    const combFb = ctx.createGain();
    combFb.gain.value = 0.32;
    comb.connect(combFb).connect(comb);
    const combOut = ctx.createGain();
    combOut.gain.value = 0.25;
    this.helmet.connect(helmetDry).connect(this.master);
    this.helmet.connect(helmetVerb).connect(helmetWet).connect(this.master);
    this.helmet.connect(comb).connect(combOut).connect(this.master);

    // ----- big reverb for score & stingers -----
    this.hall = ctx.createConvolver();
    this.hall.buffer = makeIR(ctx, 6, 3.2, { bright: 0.35, predelay: 0.03 });
    this.hallOut = ctx.createGain();
    this.hallOut.gain.value = 0.9;
    this.hall.connect(this.hallOut).connect(this.master);

    // ----- music bus -----
    this.music = ctx.createGain();
    this.music.gain.value = 0;
    this.music.connect(this.master);
    this.music.connect(this.hall);

    // ----- radio: band-limited, a little crunchy -----
    this.radio = ctx.createGain();
    const rHp = ctx.createBiquadFilter();
    rHp.type = 'highpass';
    rHp.frequency.value = 320;
    const rLp = ctx.createBiquadFilter();
    rLp.type = 'lowpass';
    rLp.frequency.value = 3200;
    const rShape = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    rShape.curve = curve;
    const rOut = ctx.createGain();
    rOut.gain.value = 0.9;
    this.radio.connect(rHp).connect(rLp).connect(rShape).connect(rOut).connect(this.helmet);

    // ----- persistent loops -----
    this._loops = [];
    const loop = (buf, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, Math.random() * buf.duration);
      this._loops.push(s);
      return s;
    };

    // suit fan
    this.fan = ctx.createGain();
    this.fan.gain.value = 0;
    const fanLp = ctx.createBiquadFilter();
    fanLp.type = 'lowpass';
    fanLp.frequency.value = 420;
    loop(this.pink).connect(fanLp).connect(this.fan);
    const whine = ctx.createBiquadFilter();
    whine.type = 'bandpass';
    whine.frequency.value = 1850;
    whine.Q.value = 14;
    const whineG = ctx.createGain();
    whineG.gain.value = 0.18;
    loop(this.white).connect(whine).connect(whineG).connect(this.fan);
    const hum = ctx.createOscillator();
    hum.frequency.value = 119;
    const humG = ctx.createGain();
    humG.gain.value = 0.012;
    hum.connect(humG).connect(this.fan);
    hum.start();
    this.fan.connect(this.helmet);

    // breathing: inhale / exhale noise channels
    this.inhale = this._breathChannel(loop(this.white), 'inhale');
    this.exhale = this._breathChannel(loop(this.pink, 0.8), 'exhale');

    // thrusters (felt through the backpack)
    this.jet = ctx.createGain();
    this.jet.gain.value = 0;
    const jetBp = ctx.createBiquadFilter();
    jetBp.type = 'bandpass';
    jetBp.frequency.value = 2400;
    jetBp.Q.value = 0.5;
    const jetLp = ctx.createBiquadFilter();
    jetLp.type = 'lowpass';
    jetLp.frequency.value = 3800;
    loop(this.white).connect(jetBp).connect(jetLp).connect(this.jet).connect(this.helmet);

    // leak hiss
    this.hiss = ctx.createGain();
    this.hiss.gain.value = 0;
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 5200;
    loop(this.white, 1.1).connect(hissHp).connect(this.hiss).connect(this.helmet);

    // radio static bed
    this.static = ctx.createGain();
    this.static.gain.value = 0;
    const stBp = ctx.createBiquadFilter();
    stBp.type = 'bandpass';
    stBp.frequency.value = 1800;
    stBp.Q.value = 0.4;
    loop(this.white).connect(stBp).connect(this.static).connect(this.radio);

    // ----- score: drone + tension shimmer -----
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    this.droneLp = ctx.createBiquadFilter();
    this.droneLp.type = 'lowpass';
    this.droneLp.frequency.value = 160;
    this.droneLp.Q.value = 3;
    for (const f of [36.71, 55.0, 55.23, 73.42]) {
      const o = ctx.createOscillator();
      o.type = f < 40 ? 'sine' : 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f < 40 ? 0.5 : 0.18;
      o.connect(g).connect(this.droneLp);
      o.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 70;
    lfo.connect(lfoG).connect(this.droneLp.frequency);
    lfo.start();
    this.droneLp.connect(this.drone).connect(this.music);

    this.shimmer = ctx.createGain();
    this.shimmer.gain.value = 0;
    for (const f of [1318.5, 1336.2, 1975.5, 1990.1]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.025;
      o.connect(g).connect(this.shimmer);
      o.start();
    }
    this.shimmer.connect(this.music);

    this.rumble = ctx.createGain();
    this.rumble.gain.value = 0;
    const rumLp = ctx.createBiquadFilter();
    rumLp.type = 'lowpass';
    rumLp.frequency.value = 90;
    loop(this.brown).connect(rumLp).connect(this.rumble).connect(this.music);

    this.pad = null;
    this._now = () => ctx.currentTime;
  }

  _breathChannel(src, kind) {
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = kind === 'inhale' ? 1100 : 600;
    bp.Q.value = kind === 'inhale' ? 0.9 : 0.7;
    const shelf = ctx.createBiquadFilter();
    shelf.type = kind === 'inhale' ? 'highpass' : 'lowpass';
    shelf.frequency.value = kind === 'inhale' ? 380 : 2200;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bp).connect(shelf).connect(g).connect(this.helmet);
    return { bp, g };
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(0.9 * v, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- breath
  _breath(period, stress, gasp, hypoxia) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const inDur = period * (gasp ? 0.22 : 0.38);
    const exDur = period * (gasp ? 0.35 : 0.5);
    const vol = (0.07 + stress * 0.1) * (gasp ? 1.4 : 1) * (1 - hypoxia * 0.5);
    const i = this.inhale;
    const e = this.exhale;
    i.bp.frequency.cancelScheduledValues(t);
    i.bp.frequency.setValueAtTime(800 + stress * 300, t);
    i.bp.frequency.linearRampToValueAtTime(1500 + stress * 700, t + inDur);
    i.g.gain.cancelScheduledValues(t);
    i.g.gain.setValueAtTime(0.0001, t);
    i.g.gain.linearRampToValueAtTime(vol * 0.8, t + inDur * (gasp ? 0.25 : 0.55));
    i.g.gain.linearRampToValueAtTime(0.0001, t + inDur);
    const te = t + inDur + period * 0.04;
    e.bp.frequency.cancelScheduledValues(te);
    e.bp.frequency.setValueAtTime(760 + stress * 250, te);
    e.bp.frequency.exponentialRampToValueAtTime(380, te + exDur);
    e.g.gain.cancelScheduledValues(te);
    e.g.gain.setValueAtTime(0.0001, te);
    e.g.gain.linearRampToValueAtTime(vol, te + exDur * 0.18);
    e.g.gain.exponentialRampToValueAtTime(0.0001, te + exDur);
  }

  _heartbeat(vol) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    for (const [dt, f0, f1, v] of [[0, 62, 38, 1], [0.27, 70, 44, 0.65]]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f0, t + dt);
      o.frequency.exponentialRampToValueAtTime(f1, t + dt + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.linearRampToValueAtTime(vol * v, t + dt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.22);
      o.connect(g).connect(this.master);
      o.start(t + dt);
      o.stop(t + dt + 0.3);
    }
  }

  _puff(vol = 0.05, dur = 0.07) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 1400;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(g).connect(this.helmet);
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.02);
  }

  _click(vol = 0.08, dest = this.helmet, freq = 3500) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    s.connect(hp).connect(g).connect(dest);
    s.start(t, Math.random());
    s.stop(t + 0.03);
  }

  // ---------------------------------------------------------------- radio
  quindar(start = true) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.value = start ? 2525 : 2475;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.01);
    g.gain.setValueAtTime(0.085, t + 0.24);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(this.radio);
    o.start(t);
    o.stop(t + 0.3);
  }

  squelch() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(g).connect(this.radio);
    s.start(t, Math.random());
    s.stop(t + 0.1);
  }

  micClicks(n = 3) {
    if (!this.ctx) return;
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        this._click(0.25, this.radio, 900);
        this.squelch();
      }, i * 380 + Math.random() * 60);
    }
  }

  // Band-limited, half-heard speech under static. Words are in the subtitles.
  voice(duration, { pitch = 115, urgency = 0, broken = 0 } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.3;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vibG = ctx.createGain();
    vibG.gain.value = pitch * 0.015;
    vib.connect(vibG).connect(src.frequency);
    const formants = [
      [730, 1090, 2440],
      [530, 1840, 2480],
      [270, 2290, 3010],
      [570, 840, 2410],
      [440, 1020, 2240],
      [660, 1720, 2410],
    ];
    const bands = [0, 1, 2].map((k) => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = [9, 12, 14][k];
      return f;
    });
    const env = ctx.createGain();
    env.gain.value = 0;
    const out = ctx.createGain();
    out.gain.value = 0.55;
    for (const b of bands) {
      src.connect(b);
      b.connect(env);
    }
    const fric = ctx.createBufferSource();
    fric.buffer = this.white;
    const fricBp = ctx.createBiquadFilter();
    fricBp.type = 'bandpass';
    fricBp.frequency.value = 4200;
    const fricG = ctx.createGain();
    fricG.gain.value = 0;
    fric.connect(fricBp).connect(fricG).connect(out);
    env.connect(out).connect(this.radio);

    let t = t0;
    const end = t0 + duration;
    let p = pitch * (1 + urgency * 0.25);
    src.frequency.setValueAtTime(p, t);
    while (t < end) {
      const syl = 0.11 + Math.random() * 0.12 - urgency * 0.03;
      const v = formants[Math.floor(Math.random() * formants.length)];
      bands.forEach((b, k) => b.frequency.setTargetAtTime(v[k] * (0.95 + Math.random() * 0.1), t, 0.02));
      const amp = 0.25 + Math.random() * 0.35;
      env.gain.setTargetAtTime(amp, t, 0.015);
      env.gain.setTargetAtTime(0.02, t + syl * 0.75, 0.025);
      if (Math.random() < 0.35) {
        fricG.gain.setTargetAtTime(0.05, t, 0.01);
        fricG.gain.setTargetAtTime(0, t + 0.05, 0.01);
      }
      p = pitch * (1 + urgency * 0.25) * (1 + (Math.random() - 0.5) * 0.18) * (1 - ((t - t0) / duration) * 0.08);
      src.frequency.setTargetAtTime(p, t, 0.05);
      // word gaps
      t += syl + (Math.random() < 0.22 ? 0.12 + Math.random() * 0.15 : 0);
      if (broken > 0 && Math.random() < broken * 0.25) {
        env.gain.setValueAtTime(0, t);
        t += 0.1 + Math.random() * 0.3;
      }
    }
    env.gain.setTargetAtTime(0, end, 0.03);
    src.start(t0);
    src.stop(end + 0.3);
    vib.start(t0);
    vib.stop(end + 0.3);
    fric.start(t0);
    fric.stop(end + 0.3);
  }

  transmit(duration, opts = {}) {
    if (!this.ctx) return;
    const { quindar = true } = opts;
    if (quindar) this.quindar(true);
    else this.squelch();
    this.voice(duration, opts);
    const ctx = this.ctx;
    this.static.gain.setTargetAtTime(0.035 + (opts.broken || 0) * 0.08, ctx.currentTime, 0.05);
    this.speaking = true;
    clearTimeout(this._txEnd);
    this._txEnd = setTimeout(() => {
      if (quindar) this.quindar(false);
      else this.squelch();
      this.static.gain.setTargetAtTime(this._staticBase || 0.004, this.ctx.currentTime, 0.1);
      this.speaking = false;
    }, (duration + 0.45) * 1000);
  }

  setStaticBase(v) {
    this._staticBase = v;
    if (this.ctx && !this.speaking) this.static.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  // Hypervelocity impacts make plasma, and plasma makes radio noise.
  crackle(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const g = ctx.createGain();
    const dur = 0.03 + Math.random() * 0.12 * strength;
    g.gain.setValueAtTime(0.1 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(g).connect(this.radio);
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.02);
  }

  scream(duration = 1.6) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(420, t);
    o.frequency.linearRampToValueAtTime(610, t + 0.25);
    o.frequency.linearRampToValueAtTime(520, t + duration);
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vg = ctx.createGain();
    vg.gain.value = 18;
    vib.connect(vg).connect(o.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 900;
    f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 2600;
    f2.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.06);
    g.gain.setValueAtTime(0.4, t + duration - 0.05);
    g.gain.linearRampToValueAtTime(0.0, t + duration);
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(this.radio);
    o.start(t);
    o.stop(t + duration + 0.05);
    vib.start(t);
    vib.stop(t + duration + 0.05);
    this.static.gain.setTargetAtTime(0.15, t, 0.02);
  }

  // ---------------------------------------------------------------- impacts
  thud(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.25);
    const g = ctx.createGain();
    const v = clamp(0.15 + strength * 0.4, 0, 1);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(this.helmet);
    o.start(t);
    o.stop(t + 0.5);
    const s = ctx.createBufferSource();
    s.buffer = this.brown;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(v * 0.8, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    s.connect(lp).connect(g2).connect(this.helmet);
    s.start(t, Math.random());
    s.stop(t + 0.35);
    // metallic ring through the structure
    const m = ctx.createOscillator();
    m.frequency.value = 280 + Math.random() * 400;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(v * 0.1, t);
    mg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    m.connect(mg).connect(this.helmet);
    m.start(t);
    m.stop(t + 1);
  }

  // Conducted "tonk" of debris striking the hull you're holding.
  tonk(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const f of [180 + Math.random() * 200, 700 + Math.random() * 900]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12 * strength, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35 + Math.random() * 0.4);
      o.connect(g).connect(this.helmet);
      o.start(t);
      o.stop(t + 0.9);
    }
    this._click(0.2 * strength, this.helmet, 1500);
  }

  suitHit() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // crack
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    s.connect(g).connect(this.helmet);
    s.start(t);
    s.stop(t + 0.1);
    // glass ticks as the visor crazes
    for (let i = 0; i < 9; i++) {
      setTimeout(() => this._click(0.15 + Math.random() * 0.2, this.helmet, 2500 + Math.random() * 4000), 30 + i * (40 + Math.random() * 90));
    }
    // ping
    const o = ctx.createOscillator();
    o.frequency.value = 3100;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.18, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(og).connect(this.helmet);
    o.start(t);
    o.stop(t + 1.5);
    this.thud(1.5);
  }

  setLeak(level) {
    if (!this.ctx) return;
    this.hiss.gain.setTargetAtTime(clamp(level * 60, 0, 0.12), this.ctx.currentTime, 0.2);
  }

  // ---------------------------------------------------------------- alarms
  setAlarm(level) {
    this._alarm.level = level; // 0 none, 1 caution, 2 warning
  }

  _alarmTone(level) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const seq = level >= 2 ? [[1500, 0], [1500, 0.16], [1500, 0.32]] : [[1250, 0], [980, 0.22]];
    for (const [f, dt] of seq) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.linearRampToValueAtTime(0.03, t + dt + 0.01);
      g.gain.setValueAtTime(0.03, t + dt + 0.12);
      g.gain.linearRampToValueAtTime(0.0001, t + dt + 0.14);
      o.connect(lp).connect(g).connect(this.helmet);
      o.start(t + dt);
      o.stop(t + dt + 0.16);
    }
  }

  // EV2's suit beacon on the emergency channel.
  setBeacon(rate) {
    this._beacon.rate = rate;
  }

  _ping() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.value = 1760;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.radio);
    o.start(t);
    o.stop(t + 0.4);
  }

  // ---------------------------------------------------------------- score
  stinger(kind = 'hit') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    out.connect(this.hall);
    const freqs = kind === 'hit' ? [73.4, 77.8, 110, 155.6, 164.8, 233] : [49, 51.9, 98, 207.7, 220, 311];
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 30;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3000, t);
      lp.frequency.exponentialRampToValueAtTime(200, t + 3);
      const g = ctx.createGain();
      g.gain.value = 0.06;
      o.connect(lp).connect(g).connect(out);
      o.start(t);
      o.stop(t + 5);
    }
    const s = ctx.createBufferSource();
    s.buffer = this.brown;
    const sg = ctx.createGain();
    sg.gain.value = 0.6;
    s.connect(sg).connect(out);
    s.start(t);
    s.stop(t + 5);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.9 * this.musicLevel, t + 0.03);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
  }

  riser(seconds = 8) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(200, t);
    bp.frequency.exponentialRampToValueAtTime(4000, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08 * this.musicLevel, t + seconds);
    g.gain.linearRampToValueAtTime(0.0, t + seconds + 0.05);
    s.connect(bp).connect(g).connect(this.music);
    s.start(t);
    s.stop(t + seconds + 0.1);
  }

  // Slow, cold pad for the title and the ending.
  startPad() {
    if (!this.ctx || this.pad) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    out.connect(this.hall);
    const chords = [
      [146.8, 220.0, 329.6, 370.0],
      [116.5, 174.6, 293.7, 440.0],
      [98.0, 146.8, 220.0, 233.1],
      [110.0, 164.8, 261.6, 329.6],
    ];
    const voices = chords[0].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2.003;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      const g2 = ctx.createGain();
      g2.gain.value = 0.015;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      o.connect(g).connect(lp).connect(out);
      o2.connect(g2).connect(lp);
      o.start();
      o2.start();
      return { o, o2 };
    });
    let i = 0;
    const step = () => {
      i = (i + 1) % chords.length;
      const t = ctx.currentTime;
      voices.forEach((v, k) => {
        v.o.frequency.setTargetAtTime(chords[i][k], t, 1.2);
        v.o2.frequency.setTargetAtTime(chords[i][k] * 2.003, t, 1.2);
      });
    };
    const timer = setInterval(step, 9000);
    out.gain.setTargetAtTime(0.55, ctx.currentTime, 3);
    this.pad = { out, voices, timer };
  }

  stopPad(fade = 3) {
    if (!this.pad) return;
    const p = this.pad;
    this.pad = null;
    const t = this.ctx.currentTime;
    p.out.gain.setTargetAtTime(0, t, fade / 3);
    clearInterval(p.timer);
    setTimeout(() => p.voices.forEach((v) => { v.o.stop(); v.o2.stop(); }), fade * 1000 + 500);
  }

  // ---------------------------------------------------------------- ending
  repress(seconds = 7) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.pink;
    s.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(120, t);
    lp.frequency.exponentialRampToValueAtTime(7000, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + seconds * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 1.5);
    s.connect(lp).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + seconds + 2);
  }

  knock() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    const res = ctx.createBiquadFilter();
    res.type = 'bandpass';
    res.frequency.value = 190;
    res.Q.value = 5;
    const s = ctx.createBufferSource();
    s.buffer = this.brown;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(1.2, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    s.connect(sg).connect(res);
    o.connect(g);
    res.connect(g);
    g.connect(this.master);
    g.connect(this.hall);
    o.start(t);
    o.stop(t + 0.6);
    s.start(t, Math.random());
    s.stop(t + 0.2);
  }

  // ---------------------------------------------------------------- frame
  update(dt, s) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const alive = s.alive;

    this.fan.gain.setTargetAtTime(s.suitOn ? 0.09 : 0, t, 0.3);

    // breathing follows the physiology model's phase
    if (s.suitOn && alive) {
      if (s.breathPhase < this._lastPhase) {
        const period = 60 / s.breathRate;
        this._breath(period, s.stress, s.hypoxia > 0.3, s.hypoxia);
      }
    }
    this._lastPhase = s.breathPhase;

    // heartbeat becomes audible under stress (and when starving for air)
    const heartVol = alive ? clamp((s.stress - 0.3) * 1.3 + s.hypoxia * 0.8, 0, 0.9) : 0;
    if (s.suitOn && heartVol > 0.02 && t >= this._heartNext) {
      this._heartbeat(heartVol * 0.8);
      this._heartNext = t + 60 / Math.max(35, s.hr);
    }

    // jets
    const jetTarget = s.thrusting * 0.11;
    this.jet.gain.setTargetAtTime(jetTarget, t, 0.03);
    if (s.thrusting > 0.2 && !this._thrustOn) this._click(0.06, this.helmet, 2000);
    this._thrustOn = s.thrusting > 0.2;
    if (s.rotThrust > 0.05) {
      this._rotPuff -= dt;
      if (this._rotPuff <= 0) {
        this._puff(0.03 + s.rotThrust * 0.05, 0.05 + Math.random() * 0.05);
        this._rotPuff = 0.07 + Math.random() * 0.12 / (0.3 + s.rotThrust);
      }
    }

    // alarms
    if (this._alarm.level > 0 && alive) {
      this._alarm.next -= dt;
      if (this._alarm.next <= 0) {
        this._alarmTone(this._alarm.level);
        this._alarm.next = this._alarm.level >= 2 ? 1.1 : 2.4;
      }
    }

    // beacon
    if (this._beacon.rate > 0) {
      this._beacon.next -= dt;
      if (this._beacon.next <= 0) {
        this._ping();
        this._beacon.next = 1 / this._beacon.rate;
      }
    }

    // score follows tension
    const tension = (this.tension += (clamp(s.tension, 0, 1) - this.tension) * Math.min(1, dt * 0.6));
    const ml = this.musicLevel;
    this.music.gain.setTargetAtTime(ml, t, 0.5);
    this.drone.gain.setTargetAtTime((0.05 + tension * 0.14) * (s.inGame ? 1 : 0), t, 0.8);
    this.droneLp.Q.value = 3 + tension * 6;
    this.shimmer.gain.setTargetAtTime(Math.max(0, tension - 0.35) * 0.5 * (s.inGame ? 1 : 0), t, 1.5);
    this.rumble.gain.setTargetAtTime((s.debrisActive ? 0.35 : 0) + tension * 0.08, t, 0.4);

    // hypoxia and death pull everything under water
    const muff = alive ? 20000 * Math.pow(1 - clamp(s.hypoxia, 0, 0.95), 2.5) + 300 : 400;
    this.muffle.frequency.setTargetAtTime(Math.max(350, muff), t, 0.3);
  }

  silenceSuit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.fan.gain.setTargetAtTime(0, t, 0.5);
    this.jet.gain.setTargetAtTime(0, t, 0.05);
    this.hiss.gain.setTargetAtTime(0, t, 0.5);
    this.static.gain.setTargetAtTime(0, t, 0.5);
    this.setAlarm(0);
    this.setBeacon(0);
  }

  resetMix() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(20000, t, 0.1);
    this.hiss.gain.setTargetAtTime(0, t, 0.1);
    this.static.gain.setTargetAtTime(0.004, t, 0.1);
    this.setAlarm(0);
    this.setBeacon(0);
    this.tension = 0;
  }
}
