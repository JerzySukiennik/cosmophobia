import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The visor display. Deliberately sparse: consumables, SAFER state, heart
// rate, orbit, and whatever you're trying to reach. Radio traffic is
// captioned at the bottom, the way it would read on a flight loop.
// ---------------------------------------------------------------------------

const fmtTime = (s) => {
  if (!isFinite(s)) return '--:--';
  s = Math.max(0, Math.round(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const DEG = 180 / Math.PI;

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-corner hud-tl">
        <div class="gauge" data-o2>
          <div class="g-label">O<sub>2</sub> primary</div>
          <div class="g-value"><span data-o2v>--</span><small>%</small></div>
          <div class="g-bar"><i data-o2bar></i></div>
          <div class="g-sub" data-o2t>--:-- remaining</div>
        </div>
        <div class="row"><span class="k">Suit</span><span data-psi>4.30</span><span class="u">psi</span></div>
        <div class="row"><span class="k">Hits</span><span data-hits>0</span><span class="u">MMOD</span></div>
      </div>
      <div class="hud-corner hud-tr">
        <div class="gauge right" data-n2>
          <div class="g-label">N<sub>2</sub> SAFER</div>
          <div class="g-value"><span data-n2v>--</span><small>%</small></div>
          <div class="g-bar"><i data-n2bar></i></div>
          <div class="g-sub"><span data-dv>--</span> m/s Δv left</div>
        </div>
        <div class="row right"><span class="k">AAH</span><span data-aah>OFF</span></div>
        <div class="row right"><span class="k">Lamps</span><span data-lamps>OFF</span></div>
      </div>
      <div class="hud-corner hud-bl">
        <div class="row"><span class="k">Heart</span><span data-hr>--</span><span class="u">bpm</span></div>
        <canvas class="ecg" width="180" height="36" data-ecg></canvas>
      </div>
      <div class="hud-corner hud-br">
        <div class="row right"><span data-daynight>DAY</span><span class="u" data-sun>--:--</span></div>
        <div class="row right"><span data-latlon>--</span></div>
        <div class="row right"><span class="k">Alt</span><span>408</span><span class="u">km</span></div>
        <div class="row right"><span class="k">Comm</span><span data-comm>AOS</span></div>
      </div>
      <div class="hud-objective" data-objective hidden>
        <div class="obj-text" data-objtext></div>
        <div class="obj-hint" data-objhint></div>
      </div>
      <div class="hud-alerts" data-alerts></div>
      <div class="hud-debris" data-debris hidden>
        <div class="d-label">Debris crossing</div>
        <div class="d-time" data-dtime>--:--</div>
        <div class="d-state" data-dstate>Exposed</div>
      </div>
      <div class="hud-nav" data-nav>
        <div><span class="k">Rel v</span> <span data-relv>0.00</span> <span class="u">m/s</span> <span class="u" data-relref>station</span></div>
        <div data-target hidden><span data-tname></span> <span data-trange></span> <span class="u">m</span> · <span class="k">closing</span> <span data-tclose></span> <span class="u">m/s</span></div>
      </div>
      <div class="reticle"><i></i></div>
      <div class="hud-prompt" data-prompt hidden>
        <svg viewBox="0 0 40 40" class="ring"><circle cx="20" cy="20" r="17" class="bg"/><circle cx="20" cy="20" r="17" class="fg" data-ring/></svg>
        <div data-ptext></div>
      </div>
      <div class="markers" data-markers></div>
      <div class="subs" data-subs aria-live="polite"></div>
    `;
    const q = (s) => root.querySelector(s);
    this.el = {
      o2v: q('[data-o2v]'), o2bar: q('[data-o2bar]'), o2t: q('[data-o2t]'), o2: q('[data-o2]'),
      n2v: q('[data-n2v]'), n2bar: q('[data-n2bar]'), dv: q('[data-dv]'), n2: q('[data-n2]'),
      psi: q('[data-psi]'), hits: q('[data-hits]'), aah: q('[data-aah]'), lamps: q('[data-lamps]'),
      hr: q('[data-hr]'), ecg: q('[data-ecg]'),
      daynight: q('[data-daynight]'), sun: q('[data-sun]'), latlon: q('[data-latlon]'), comm: q('[data-comm]'),
      objective: q('[data-objective]'), objtext: q('[data-objtext]'), objhint: q('[data-objhint]'),
      alerts: q('[data-alerts]'), debris: q('[data-debris]'), dtime: q('[data-dtime]'), dstate: q('[data-dstate]'),
      relv: q('[data-relv]'), relref: q('[data-relref]'), target: q('[data-target]'), tname: q('[data-tname]'), trange: q('[data-trange]'), tclose: q('[data-tclose]'),
      prompt: q('[data-prompt]'), ptext: q('[data-ptext]'), ring: q('[data-ring]'),
      markers: q('[data-markers]'), subs: q('[data-subs]'),
    };
    this.ecgCtx = this.el.ecg.getContext('2d');
    this.ecgData = new Float32Array(180);
    this.ecgT = 0;
    this.ecgBeat = 0;
    this.markerEls = new Map();
    this.alerts = new Map();
    this.subQueue = [];
    this.textTimer = 0;
    this._v = new THREE.Vector3();
    this.visible = true;
  }

  setVisible(v) {
    this.visible = v;
    this.root.classList.toggle('hud-hidden', !v);
  }

  setMode(mode) {
    this.root.dataset.mode = mode; // 'full', 'minimal', 'off'
  }

  objective(text, hint = '') {
    if (!text) {
      this.el.objective.hidden = true;
      return;
    }
    this.el.objective.hidden = false;
    this.el.objtext.textContent = text;
    this.el.objhint.innerHTML = hint;
    this.el.objective.classList.remove('flash');
    void this.el.objective.offsetWidth;
    this.el.objective.classList.add('flash');
  }

  // level: 'caution' | 'warning' | 'info'
  alert(id, text, level = 'caution', ttl = 0) {
    let a = this.alerts.get(id);
    if (!a) {
      const el = document.createElement('div');
      el.className = `alert ${level}`;
      this.el.alerts.appendChild(el);
      a = { el, ttl };
      this.alerts.set(id, a);
    }
    a.el.className = `alert ${level}`;
    a.el.textContent = text;
    a.ttl = ttl;
  }

  clearAlert(id) {
    const a = this.alerts.get(id);
    if (a) {
      a.el.remove();
      this.alerts.delete(id);
    }
  }

  clearAll() {
    for (const id of [...this.alerts.keys()]) this.clearAlert(id);
    this.el.subs.innerHTML = '';
    this.objective(null);
    this.prompt(null);
    for (const [, m] of this.markerEls) m.el.remove();
    this.markerEls.clear();
  }

  subtitle(speaker, text, duration = 4, cls = '') {
    const line = document.createElement('div');
    line.className = `sub ${cls}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = speaker;
    const body = document.createElement('span');
    body.className = 'said';
    body.textContent = text;
    line.append(who, body);
    this.el.subs.appendChild(line);
    while (this.el.subs.children.length > 3) this.el.subs.firstChild.remove();
    setTimeout(() => {
      line.classList.add('gone');
      setTimeout(() => line.remove(), 900);
    }, duration * 1000);
  }

  prompt(text, progress = 0) {
    if (!text) {
      this.el.prompt.hidden = true;
      return;
    }
    this.el.prompt.hidden = false;
    this.el.ptext.innerHTML = text;
    const c = 2 * Math.PI * 17;
    this.el.ring.style.strokeDasharray = `${c}`;
    this.el.ring.style.strokeDashoffset = `${c * (1 - progress)}`;
  }

  // markers: [{id, pos: Vector3 (near-scene), label, kind}]
  markers(list, camera, w, h) {
    const seen = new Set();
    for (const m of list) {
      seen.add(m.id);
      let e = this.markerEls.get(m.id);
      if (!e) {
        const el = document.createElement('div');
        el.className = `marker ${m.kind || ''}`;
        el.innerHTML = `<i></i><span class="m-label"></span><span class="m-dist"></span>`;
        this.el.markers.appendChild(el);
        e = { el, label: el.querySelector('.m-label'), dist: el.querySelector('.m-dist') };
        this.markerEls.set(m.id, e);
      }
      const v = this._v.copy(m.pos);
      const camPos = camera.position;
      const dist = m.infinite ? Infinity : v.distanceTo(camPos);
      if (m.infinite) v.copy(camPos).add(m.pos);
      v.project(camera);
      const behind = v.z > 1;
      let x = v.x;
      let y = v.y;
      let off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88;
      if (off) {
        if (behind) {
          x = -x;
          y = -y;
        }
        const s = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.84, 1e-3);
        x *= s;
        y *= s;
      }
      e.el.classList.toggle('off', off);
      e.el.style.transform = `translate(${((x + 1) / 2) * w}px, ${((1 - y) / 2) * h}px)`;
      if (off) e.el.style.setProperty('--ang', `${Math.atan2(-y, x)}rad`);
      e.label.textContent = m.label;
      e.dist.textContent = isFinite(dist) ? (dist < 100 ? dist.toFixed(1) : dist.toFixed(0)) + ' m' : '';
    }
    for (const [id, e] of this.markerEls) {
      if (!seen.has(id)) {
        e.el.remove();
        this.markerEls.delete(id);
      }
    }
  }

  update(dt, s) {
    // ECG trace runs every frame
    this.ecgT += dt;
    const beatPeriod = 60 / Math.max(30, s.hr);
    this.ecgBeat += dt;
    const shift = Math.max(1, Math.round(dt * 90));
    for (let k = 0; k < shift; k++) {
      this.ecgData.copyWithin(0, 1);
      const ph = this.ecgBeat / beatPeriod;
      let val = 0;
      if (s.alive && s.hr > 5) {
        const p = ph % 1;
        val = p < 0.04 ? Math.sin(p / 0.04 * Math.PI) * 0.12 : p > 0.1 && p < 0.13 ? -0.15 : p >= 0.13 && p < 0.17 ? 1 : p >= 0.17 && p < 0.2 ? -0.3 : p > 0.35 && p < 0.47 ? Math.sin((p - 0.35) / 0.12 * Math.PI) * 0.22 : 0;
      }
      this.ecgData[this.ecgData.length - 1] = val + (Math.random() - 0.5) * 0.03;
    }
    if (this.ecgBeat > beatPeriod * 1000) this.ecgBeat = 0;
    const c = this.ecgCtx;
    c.clearRect(0, 0, 180, 36);
    c.strokeStyle = s.hr > 150 ? 'rgba(255,90,70,0.9)' : 'rgba(170,205,255,0.85)';
    c.lineWidth = 1.4;
    c.beginPath();
    for (let i = 0; i < 180; i++) {
      const y = 22 - this.ecgData[i] * 17;
      if (i === 0) c.moveTo(i, y);
      else c.lineTo(i, y);
    }
    c.stroke();

    // text at ~12 Hz
    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.08;
    const e = this.el;
    const o2 = Math.max(0, s.o2 * 100);
    e.o2v.textContent = o2.toFixed(o2 < 10 ? 1 : 0);
    e.o2bar.style.transform = `scaleX(${Math.max(0, s.o2)})`;
    e.o2t.textContent = `${fmtTime(s.o2Seconds)} at this rate`;
    e.o2.dataset.state = s.o2 < 0.1 ? 'warning' : s.o2 < 0.25 ? 'caution' : '';
    const n2 = s.n2 * 100;
    e.n2v.textContent = n2.toFixed(0);
    e.n2bar.style.transform = `scaleX(${Math.max(0, s.n2)})`;
    e.dv.textContent = s.dv.toFixed(1);
    e.n2.dataset.state = s.n2 < 0.08 ? 'warning' : s.n2 < 0.2 ? 'caution' : '';
    e.psi.textContent = s.psi.toFixed(2);
    e.psi.parentElement.dataset.state = s.psi < 3.6 ? 'warning' : s.psi < 4.1 ? 'caution' : '';
    e.hits.textContent = s.hits;
    e.aah.textContent = s.aahEngaging ? 'FIRING' : s.aah ? 'HOLD' : 'OFF';
    e.aah.parentElement.dataset.state = s.aah ? '' : 'warning';
    e.lamps.textContent = s.lights ? 'ON' : 'OFF';
    e.hr.textContent = Math.round(s.hr);
    e.hr.parentElement.dataset.state = s.hr > 150 ? 'warning' : s.hr > 125 ? 'caution' : '';
    e.daynight.textContent = s.night ? 'NIGHT' : 'DAY';
    e.sun.textContent = s.night ? `sunrise ${fmtTime(s.toSunEvent)}` : `sunset ${fmtTime(s.toSunEvent)}`;
    const lat = s.lat * DEG;
    const lon = s.lon * DEG;
    e.latlon.textContent = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
    e.comm.textContent = s.comm;
    e.comm.parentElement.dataset.state = s.comm === 'LOS' ? 'caution' : '';
    e.relv.textContent = s.relSpeed.toFixed(2);
    e.relref.textContent = s.relRef;
    if (s.target) {
      e.target.hidden = false;
      e.tname.textContent = s.target.name;
      e.trange.textContent = s.target.range.toFixed(1);
      e.tclose.textContent = s.target.closing.toFixed(2);
      e.tclose.parentElement.dataset.state = s.target.closing > 1.2 && s.target.range < 8 ? 'caution' : '';
    } else {
      e.target.hidden = true;
    }
    if (s.debris) {
      e.debris.hidden = false;
      e.dtime.textContent = s.debris.active ? 'NOW' : fmtTime(s.debris.t);
      e.dstate.textContent = s.debris.exposed ? 'Exposed' : 'Shielded';
      e.debris.dataset.state = s.debris.exposed ? (s.debris.active || s.debris.t < 10 ? 'warning' : 'caution') : 'safe';
    } else {
      e.debris.hidden = true;
    }
    for (const [id, a] of this.alerts) {
      if (a.ttl > 0) {
        a.ttl -= 0.08;
        if (a.ttl <= 0) this.clearAlert(id);
      }
    }
  }
}
