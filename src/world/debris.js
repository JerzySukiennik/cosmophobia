import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The debris cascade. Fragments of a shattered satellite cross the station's
// orbit at ~10 km/s: far too fast to see. What you do see is the station
// being hit, as silent flashes, sprays of molten metal, shredded arrays.
// The only defence is to put something solid between you and the stream.
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();

export class DebrisStorm {
  constructor({ scene, station, effects }) {
    this.station = station;
    this.effects = effects;
    this.passes = [];
    this.time = 0;
    this.active = null;
    this.exposed = true;
    this.shieldTimer = 0;
    this.onPlayerHit = null;
    this.onImpactNear = null;
    this.onWingBreak = null;
    this.onPassStart = null;
    this.onPassEnd = null;

    // Streaks: the rare sunlit glint of a fragment as it tears past.
    const max = 24;
    this.streakPos = new Float32Array(max * 6);
    this.streakCol = new Float32Array(max * 6);
    this.streakAge = new Float32Array(max).fill(1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.streakPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.streakCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.streaks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.streaks.frustumCulled = false;
    this.streakIdx = 0;
    scene.add(this.streaks);
  }

  reset() {
    this.passes.length = 0;
    this.time = 0;
    this.active = null;
    this.streakAge.fill(1);
  }

  // dir: direction the fragments come FROM (unit). start/duration in seconds.
  schedule(start, duration, dir, { density = 1, lethality = 1, breakWing = -1 } = {}) {
    this.passes.push({ start, duration, dir: dir.clone().normalize(), density, lethality, breakWing, done: false, started: false, acc: 0, broke: false });
    this.passes.sort((a, b) => a.start - b.start);
  }

  next() {
    return this.passes.find((p) => !p.done) || null;
  }

  timeToNext() {
    const n = this.next();
    if (!n) return Infinity;
    return n.start - this.time;
  }

  streak(from, to, brightness) {
    const i = this.streakIdx++ % this.streakAge.length;
    this.streakPos.set([from.x, from.y, from.z, to.x, to.y, to.z], i * 6);
    this.streakAge[i] = 0;
    this.streakCol.set([0, 0, 0, brightness, brightness * 0.95, brightness * 0.85], i * 6);
  }

  fire(pass, playerPos, aimAtPlayer) {
    const u = _v.copy(pass.dir).negate(); // travel direction
    // basis perpendicular to travel
    _a.set(0, 1, 0);
    if (Math.abs(u.y) > 0.9) _a.set(1, 0, 0);
    _a.crossVectors(u, _a).normalize();
    _b.crossVectors(u, _a).normalize();
    const center = aimAtPlayer ? playerPos : _p.set(0, 3, 4);
    const radius = aimAtPlayer ? 2.5 + Math.random() * 9 : 62;
    const r = Math.sqrt(Math.random()) * radius;
    const th = Math.random() * Math.PI * 2;
    const aim = new THREE.Vector3().copy(center).addScaledVector(_a, Math.cos(th) * r).addScaledVector(_b, Math.sin(th) * r);
    const origin = aim.clone().addScaledVector(u, -160);
    const dir = u.clone();

    // walk the ray through the station; panels are punched through, hulls stop it
    let t = 0;
    let travelled = 0;
    const o = origin.clone();
    let end = null;
    for (let hops = 0; hops < 4; hops++) {
      const hit = this.station.raycast(o, dir, 320 - travelled);
      if (!isFinite(hit)) break;
      const hp = o.clone().addScaledVector(dir, hit);
      const { c } = this.station.sdf(hp);
      const n = c ? this.station.normalAt(hp, c).clone() : dir.clone().negate();
      const strength = 0.5 + Math.random() * 0.9;
      this.effects.impact(hp, n, strength, { sparks: 30, shards: c && !c.shield ? 3 : 2, puff: c && c.shield && Math.random() < 0.12 });
      if (this.onImpactNear) this.onImpactNear(hp, strength, c);
      if (c && c.shield) {
        end = hp;
        if (Math.random() < 0.05) this.effects.addVent(hp, n, 40, 2.5, 25);
        break;
      }
      // pass through thin panels
      travelled += hit + 0.5;
      o.copy(hp).addScaledVector(dir, 0.5);
      t = travelled;
    }
    // visible streak only near the camera
    const dCam = distancePointToRay(playerPos, origin, dir);
    if (dCam < 30 && Math.random() < 0.8) {
      const along = _p.copy(playerPos).sub(origin).dot(dir);
      const a = origin.clone().addScaledVector(dir, along - 40 - Math.random() * 20);
      const bEnd = end ? end : origin.clone().addScaledVector(dir, along + 40);
      this.streak(a, bEnd, 1.5 + Math.random() * 3);
    }
    return t;
  }

  update(dt, playerPos) {
    this.time += dt;
    for (let i = 0; i < this.streakAge.length; i++) {
      if (this.streakAge[i] >= 1) continue;
      this.streakAge[i] += dt / 0.07;
      const k = Math.max(0, 1 - this.streakAge[i]);
      const o = i * 6 + 3;
      this.streakCol[o] *= k;
      this.streakCol[o + 1] *= k;
      this.streakCol[o + 2] *= k;
      if (this.streakAge[i] >= 1) this.streakPos.fill(0, i * 6, i * 6 + 6);
    }
    this.streaks.geometry.attributes.position.needsUpdate = true;
    this.streaks.geometry.attributes.color.needsUpdate = true;

    this.active = null;
    const pass = this.next();
    if (!pass) return;

    // shelter check against the stream direction (updated ~10x/s)
    this.shieldTimer -= dt;
    if (this.shieldTimer <= 0) {
      this.shieldTimer = 0.1;
      const hit = this.station.raycast(playerPos, pass.dir, 140, this.station.shieldFilter);
      this.exposed = !isFinite(hit);
    }

    const t = this.time - pass.start;
    if (t < 0) return;
    if (!pass.started) {
      pass.started = true;
      if (this.onPassStart) this.onPassStart(pass);
    }
    if (t > pass.duration) {
      pass.done = true;
      if (this.onPassEnd) this.onPassEnd(pass);
      return;
    }
    this.active = pass;
    // intensity rises and falls across the crossing
    const k = t / pass.duration;
    const bell = Math.pow(Math.sin(Math.PI * k), 1.6);
    pass.acc += dt * (5 + 55 * bell) * pass.density;
    while (pass.acc >= 1) {
      pass.acc -= 1;
      this.fire(pass, playerPos, Math.random() < 0.18);
    }
    if (pass.breakWing >= 0 && !pass.broke && k > 0.45) {
      pass.broke = true;
      const piece = this.station.breakWing(pass.breakWing, pass.dir.clone().multiplyScalar(-0.5).add(new THREE.Vector3(0, 0.15, 0)));
      if (piece && this.onWingBreak) this.onWingBreak(piece);
    }
    // the part that decides whether you live
    if (this.exposed && this.onPlayerHit) {
      const hazard = 0.16 * bell * pass.lethality;
      if (Math.random() < hazard * dt) this.onPlayerHit(pass);
    }
  }
}

function distancePointToRay(p, o, d) {
  _p.copy(p).sub(o);
  const t = _p.dot(d);
  return _p.addScaledVector(d, -t).length();
}
