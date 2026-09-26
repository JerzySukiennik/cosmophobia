import * as THREE from 'three';

// ---------------------------------------------------------------------------
// EV1 — you. A body in a pressure suit with a SAFER jetpack.
//   * Newtonian translation, limited nitrogen (delta-v budget)
//   * SAFER's real "Automatic Attitude Hold" button to kill a tumble
//   * grab handrails and push off for free
//   * physiology: stress -> heart rate -> breathing -> oxygen use
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

export const SUIT = {
  radius: 0.5,
  thrustAccel: 0.42, // m/s²
  deltaV: 13, // m/s in a full tank
  pushOff: 0.95, // m/s
  grabRange: 1.35,
  nominalPsi: 4.3,
};

export class Player {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3(); // body frame, rad/s
    this.reset();
  }

  reset() {
    this.pos.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.quat.identity();
    this.angVel.set(0, 0, 0);
    this.aah = true;
    this.aahEngaging = 0;
    this.n2 = 1;
    this.o2 = 0.92;
    this.leak = 0;
    this.psi = SUIT.nominalPsi;
    this.hr = 84;
    this.stress = 0.1;
    this.breathPhase = 0;
    this.breathRate = 14;
    this.hits = 0;
    this.anchored = false;
    this.anchor = null;
    this.lights = false;
    this.goldVisor = false;
    this.thrusting = 0; // 0..1 for audio
    this.thrustVec = new THREE.Vector3();
    this.rotThrust = 0;
    this.alive = true;
    this.dying = 0;
    this.hypoxia = 0;
    this.impactKick = 0;
    this.lastImpact = 0;
    this.control = true;
    this.frozen = false; // cinematic control
    this.o2Used = 0;
  }

  get forward() {
    return _v.set(0, 0, -1).applyQuaternion(this.quat);
  }

  dvRemaining() {
    return this.n2 * SUIT.deltaV;
  }

  spendDv(dv) {
    const f = dv / SUIT.deltaV;
    if (this.n2 <= 0) return false;
    this.n2 = Math.max(0, this.n2 - f);
    return true;
  }

  engageAAH() {
    if (this.aah || this.aahEngaging > 0) return false;
    this.aahEngaging = 0.001;
    return true;
  }

  // input: { move: Vector3 (body frame, -z forward), roll, lookX, lookY, brake, grab }
  update(dt, input, world) {
    if (this.frozen) {
      this.pos.addScaledVector(this.vel, dt);
      this.integrateRotation(dt);
      return;
    }
    const ctl = this.control && this.alive;
    this.thrusting = 0;
    this.rotThrust = 0;
    this.thrustVec.set(0, 0, 0);

    // ---------------- attitude ----------------
    if (this.aahEngaging > 0) {
      // SAFER fires its attitude jets until the body rates are nulled.
      this.aahEngaging += dt;
      const before = this.angVel.length();
      this.angVel.multiplyScalar(Math.exp(-dt * 2.2));
      const used = before - this.angVel.length();
      if (this.n2 > 0) this.spendDv(used * 0.35);
      this.rotThrust = Math.min(1, before * 1.5);
      if (this.angVel.length() < 0.02) {
        this.angVel.set(0, 0, 0);
        this.aah = true;
        this.aahEngaging = 0;
      }
    }
    if (ctl) {
      const authority = this.aah ? 1 : 0.25;
      if (input.lookX || input.lookY) {
        _q.setFromAxisAngle(Y, -input.lookX * authority);
        this.quat.multiply(_q);
        _q.setFromAxisAngle(X, -input.lookY * authority);
        this.quat.multiply(_q);
        this.spendDv((Math.abs(input.lookX) + Math.abs(input.lookY)) * 0.012);
      }
      if (input.roll) {
        if (this.aah) {
          _q.setFromAxisAngle(Z, input.roll * 0.9 * dt);
          this.quat.multiply(_q);
          this.spendDv(Math.abs(input.roll) * dt * 0.02);
          this.rotThrust = Math.max(this.rotThrust, 0.4);
        } else {
          this.angVel.z += input.roll * 0.4 * dt;
        }
      }
    }
    if (this.aah && this.aahEngaging === 0 && this.angVel.lengthSq() > 1e-6) {
      // hold: damp any residual rate (bumps, impacts)
      const before = this.angVel.length();
      this.angVel.multiplyScalar(Math.exp(-dt * 3));
      this.spendDv((before - this.angVel.length()) * 0.3);
      this.rotThrust = Math.max(this.rotThrust, Math.min(1, before * 2));
    }
    this.integrateRotation(dt);

    // ---------------- translation ----------------
    const hasGas = this.n2 > 0;
    if (ctl && this.anchored) {
      this.vel.multiplyScalar(Math.exp(-dt * 10));
      if (this.anchor) {
        this.pos.lerp(this.anchor, 1 - Math.exp(-dt * 6));
      }
      if (input.grab) {
        // let go, keeping station-relative rest
        this.anchored = false;
        this.anchor = null;
        this.vel.set(0, 0, 0);
      } else if (input.move.z < -0.5) {
        // push off in the direction you're looking
        this.anchored = false;
        this.anchor = null;
        this.vel.copy(this.forward).multiplyScalar(SUIT.pushOff);
        world.onPushOff && world.onPushOff();
      }
    } else if (ctl) {
      _w.copy(input.move);
      if (_w.lengthSq() > 1) _w.normalize();
      if (input.brake) {
        const rel = _v.copy(this.vel).sub(world.referenceVelocity);
        const sp = rel.length();
        if (sp > 0.005) {
          const dv = Math.min(sp, SUIT.thrustAccel * dt);
          if (hasGas && this.spendDv(dv)) {
            this.vel.addScaledVector(rel.normalize(), -dv);
            this.thrusting = Math.max(this.thrusting, Math.min(1, sp * 4));
            this.thrustVec.copy(rel).negate();
          }
        }
      }
      if (_w.lengthSq() > 0.01 && hasGas) {
        _w.applyQuaternion(this.quat);
        const dv = SUIT.thrustAccel * dt * _w.length();
        if (this.spendDv(dv)) {
          this.vel.addScaledVector(_w, SUIT.thrustAccel * dt);
          this.thrusting = 1;
          this.thrustVec.copy(_w);
        }
      }
      if (input.grab) {
        const d = world.station.sdf(this.pos);
        if (d.d < SUIT.grabRange && d.c && d.c.grab) {
          this.anchored = true;
          const n = world.station.normalAt(this.pos, d.c);
          this.anchor = this.pos.clone().addScaledVector(n, -(d.d - 0.75));
          world.onGrab && world.onGrab(Math.max(0, -this.vel.dot(n)));
        }
      }
    }
    if (!this.anchored) this.pos.addScaledVector(this.vel, dt);

    // ---------------- collisions ----------------
    const s = world.station.sdf(this.pos);
    if (s.c && s.d < SUIT.radius) {
      const n = world.station.normalAt(this.pos, s.c).clone();
      this.pos.addScaledVector(n, SUIT.radius - s.d);
      const vn = this.vel.dot(n);
      if (vn < 0) {
        const impact = -vn;
        this.vel.addScaledVector(n, -1.3 * vn);
        // scrape: friction on the tangential part
        const vt = _v.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
        this.vel.addScaledVector(vt, -0.35);
        if (impact > 0.15) {
          world.onCollide && world.onCollide(impact, s.c);
          this.angVel.add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(impact * 0.6));
          if (impact > 2.2) this.lastImpact = impact;
        }
      }
    }
    // EV2's body
    if (world.crewmate) {
      const cm = world.crewmate;
      _v.copy(this.pos).sub(cm.root.position);
      const d = _v.length();
      const min = SUIT.radius + cm.radius;
      if (d < min && d > 1e-4) {
        _v.divideScalar(d);
        this.pos.addScaledVector(_v, min - d);
        const rel = this.vel.clone().sub(cm.state.velocity);
        const vn = rel.dot(_v);
        if (vn < 0) {
          // equal-ish masses: split the momentum
          this.vel.addScaledVector(_v, -vn * 0.6);
          cm.state.velocity.addScaledVector(_v, vn * 0.5);
          world.onBumpCrewmate && world.onBumpCrewmate(-vn);
        }
      }
    }
  }

  integrateRotation(dt) {
    const w = this.angVel;
    const ang = w.length() * dt;
    if (ang > 1e-7) {
      _q.setFromAxisAngle(_w.copy(w).normalize(), ang);
      this.quat.multiply(_q);
    }
    this.quat.normalize();
  }

  // Physiology and life support. `env` carries the stressors.
  updateBody(dt, env) {
    let target = 0.08;
    target += env.dark ? (this.lights ? 0.08 : 0.18) : 0;
    target += Math.min(0.5, this.angVel.length() * 0.35);
    target += env.debrisWarning ? 0.2 : 0;
    target += env.debrisActive ? (env.exposed ? 0.55 : 0.3) : 0;
    target += this.o2 < 0.25 ? 0.45 * (1 - this.o2 / 0.25) : 0;
    target += env.scare || 0;
    target += Math.min(0.3, Math.max(0, this.vel.length() - 1.5) * 0.15);
    target += env.distanceFear || 0;
    target = Math.min(1, target);
    const tau = target > this.stress ? 1.2 : 9;
    this.stress += (target - this.stress) * (1 - Math.exp(-dt / tau));

    const hrTarget = 70 + this.stress * 112 + (this.hypoxia > 0 ? -this.hypoxia * 40 : 0);
    this.hr += (hrTarget - this.hr) * (1 - Math.exp(-dt / 2.5));
    this.breathRate = 11 + this.stress * 26;
    const breathHz = this.breathRate / 60;
    this.breathPhase = (this.breathPhase + dt * breathHz) % 1;

    // O2: metabolism (scales with heart rate) + leak through the suit breach.
    if (env.consumeO2 !== false) {
      const metabolic = 0.00105 * (this.hr / 80);
      const use = (metabolic + this.leak) * dt;
      this.o2 = Math.max(0, this.o2 - use);
      this.o2Used += use;
    }
    this.psi = Math.max(0, SUIT.nominalPsi - this.leak * 520 - (this.o2 < 0.05 ? (0.05 - this.o2) * 40 : 0));
    this.hypoxia = this.o2 < 0.06 ? (0.06 - this.o2) / 0.06 : 0;
    if (this.o2 <= 0 && this.alive) {
      this.dying += dt;
    }
  }

  // Estimated seconds of oxygen left at the current rate.
  o2Seconds() {
    const rate = 0.00105 * (this.hr / 80) + this.leak;
    return this.o2 / rate;
  }
}
