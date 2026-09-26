import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeDecal, rng } from './textures.js';

// ---------------------------------------------------------------------------
// EV2 — Mission Specialist Mara Ellison, in an EMU-style suit with the red
// leg stripes that tell crews apart. After the strike she floats in the
// relaxed "neutral body posture" every body takes in microgravity: arms
// drifting up, knees bent. Her helmet lamps still work. Mostly.
// ---------------------------------------------------------------------------

function crackTexture(seed = 7) {
  const rand = rng(seed);
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, S, S);
  const cx = S * 0.42;
  const cy = S * 0.46;
  c.lineCap = 'round';
  function branch(x, y, ang, len, w, depth) {
    let px = x;
    let py = y;
    const steps = 8 + Math.floor(rand() * 8);
    for (let i = 0; i < steps; i++) {
      ang += (rand() - 0.5) * 0.7;
      const nx = px + Math.cos(ang) * (len / steps);
      const ny = py + Math.sin(ang) * (len / steps);
      c.strokeStyle = `rgba(235,245,255,${0.5 + 0.5 * rand()})`;
      c.lineWidth = w * (1 - i / steps) + 0.6;
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(nx, ny);
      c.stroke();
      if (depth > 0 && rand() < 0.22) branch(nx, ny, ang + (rand() - 0.5) * 1.8, len * 0.5, w * 0.6, depth - 1);
      px = nx;
      py = ny;
    }
  }
  for (let i = 0; i < 11; i++) branch(cx, cy, (i / 11) * Math.PI * 2 + rand() * 0.4, 120 + rand() * 180, 3.2, 2);
  // concentric fracture rings around the impact point
  for (let r = 14; r < 70; r += 12 + rand() * 10) {
    c.strokeStyle = `rgba(230,240,255,${0.35 + rand() * 0.3})`;
    c.lineWidth = 1.2;
    c.beginPath();
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const rr = r + (rand() - 0.5) * 6;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (a === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    c.stroke();
  }
  // frost bloom
  const g = c.createRadialGradient(cx, cy, 4, cx, cy, 180);
  g.addColorStop(0, 'rgba(220,235,255,0.55)');
  g.addColorStop(1, 'rgba(220,235,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildCrewmate({ name = 'ELLISON', stripes = true } = {}) {
  const root = new THREE.Group();
  root.name = 'EV2';
  const body = new THREE.Group();
  root.add(body);

  const suitMat = new THREE.MeshStandardMaterial({ color: 0xdcd9d2, roughness: 0.82, metalness: 0 });
  const suitDark = new THREE.MeshStandardMaterial({ color: 0x9c9a94, roughness: 0.7, metalness: 0.1 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xa8acb2, roughness: 0.35, metalness: 0.9 });
  const red = new THREE.MeshStandardMaterial({ color: 0xa3232b, roughness: 0.75 });
  const visorMat = new THREE.MeshPhysicalMaterial({ color: 0xd9a441, metalness: 1, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.8 });
  const crackMat = new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false, color: new THREE.Color(1.4, 1.5, 1.7) });
  const glove = new THREE.MeshStandardMaterial({ color: 0xdedbd2, roughness: 0.9 });

  const all = [];
  function mesh(geo, mat, parent) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    all.push(m);
    return m;
  }

  // Torso (hard upper torso) + PLSS backpack + chest display.
  const torso = mesh(new THREE.CapsuleGeometry(0.26, 0.34, 8, 18), suitMat, body);
  torso.scale.set(1.25, 1, 0.85);
  torso.position.y = 0.2;
  const plss = mesh(new RoundedBoxGeometry(0.56, 0.72, 0.26, 3, 0.06), suitMat, body);
  plss.position.set(0, 0.26, -0.33);
  const plssTop = mesh(new RoundedBoxGeometry(0.5, 0.08, 0.22, 2, 0.02), suitDark, body);
  plssTop.position.set(0, 0.66, -0.33);
  // SAFER jetpack hugging the bottom of the backpack
  const safer = mesh(new RoundedBoxGeometry(0.6, 0.2, 0.34, 2, 0.04), suitDark, body);
  safer.position.set(0, -0.16, -0.36);
  for (const sx of [-1, 1]) {
    const tower = mesh(new RoundedBoxGeometry(0.1, 0.56, 0.12, 2, 0.03), suitDark, body);
    tower.position.set(sx * 0.33, 0.12, -0.38);
  }
  const dcm = mesh(new RoundedBoxGeometry(0.32, 0.14, 0.14, 2, 0.03), suitDark, body);
  dcm.position.set(0, 0.1, 0.3);
  // umbilical hose from display unit to the backpack
  const hose = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.15, 0.1, 0.33), new THREE.Vector3(0.34, 0.05, 0.2), new THREE.Vector3(0.36, 0.2, -0.1), new THREE.Vector3(0.25, 0.3, -0.25),
  ]), 20, 0.018, 6), suitDark, body);
  const nameTag = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.055), new THREE.MeshStandardMaterial({ map: makeDecal([name], { w: 512, h: 128, size: 88, color: '#20242c' }), transparent: true, roughness: 0.9 }));
  nameTag.position.set(0.14, 0.36, 0.24);
  nameTag.rotation.y = 0.35;
  body.add(nameTag);
  // spare O2 bottle strapped to her mini-workstation
  const bottle = mesh(new THREE.CapsuleGeometry(0.07, 0.3, 6, 12), new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 0.4, metalness: 0.3 }), body);
  bottle.position.set(-0.22, -0.05, 0.3);
  bottle.rotation.z = 0.2;
  const bottleCap = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 10), metal, bottle);
  bottleCap.position.y = 0.22;

  // Helmet: EVVA shell, gold visor (cracked), lamps.
  const head = new THREE.Group();
  head.position.set(0, 0.62, 0.04);
  body.add(head);
  const bubble = mesh(new THREE.SphereGeometry(0.2, 28, 18), new THREE.MeshPhysicalMaterial({ color: 0x0b0e12, roughness: 0.15, metalness: 0, transmission: 0, clearcoat: 1 }), head);
  bubble.scale.set(1, 1.05, 1);
  const shell = mesh(new THREE.SphereGeometry(0.225, 28, 18, Math.PI * 0.62, Math.PI * 1.76, 0, Math.PI * 0.75), suitMat, head);
  shell.rotation.y = 0;
  const visor = mesh(new THREE.SphereGeometry(0.232, 32, 20, -Math.PI * 0.36, Math.PI * 0.72, Math.PI * 0.2, Math.PI * 0.46), visorMat, head);
  visor.rotation.y = Math.PI / 2;
  const crack = new THREE.Mesh(new THREE.SphereGeometry(0.235, 32, 20, -Math.PI * 0.36, Math.PI * 0.72, Math.PI * 0.2, Math.PI * 0.46), crackMat);
  crack.rotation.y = Math.PI / 2;
  head.add(crack);
  const lamps = [];
  for (const sx of [-1, 1]) {
    const housing = mesh(new RoundedBoxGeometry(0.06, 0.07, 0.14, 2, 0.015), suitDark, head);
    housing.position.set(sx * 0.21, 0.1, 0.06);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 1.9, 1.7) }));
    lens.position.set(sx * 0.21, 0.1, 0.132);
    head.add(lens);
    lamps.push(lens);
  }
  const lampLight = new THREE.SpotLight(0xfff1dd, 5, 25, 0.42, 0.5, 1.8);
  lampLight.position.set(0, 0.1, 0.15);
  lampLight.target.position.set(0, 0.0, 3);
  head.add(lampLight, lampLight.target);

  // Limbs: pivots so the pose reads naturally.
  function limb(parent, pos, rot, segs) {
    const pivot = new THREE.Group();
    pivot.position.copy(pos);
    pivot.rotation.copy(rot);
    parent.add(pivot);
    let p = pivot;
    const joints = [pivot];
    segs.forEach((s, i) => {
      const seg = mesh(new THREE.CapsuleGeometry(s.r, s.len, 6, 14), s.mat || suitMat, p);
      seg.position.y = -s.len / 2 - s.r * 0.4;
      // bearing ring at the top of each segment
      const ring = mesh(new THREE.TorusGeometry(s.r + 0.004, 0.012, 6, 18), metal, p);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -s.r * 0.25;
      if (s.stripe && stripes) {
        const band = mesh(new THREE.CylinderGeometry(s.r + 0.006, s.r + 0.006, 0.07, 16, 1, true), red, p);
        band.position.y = seg.position.y + s.len * 0.15;
      }
      if (i < segs.length - 1) {
        const j = new THREE.Group();
        j.position.y = -s.len - s.r * 0.7;
        j.rotation.copy(s.bend || new THREE.Euler());
        p.add(j);
        joints.push(j);
        p = j;
      } else if (s.end) {
        const e = mesh(s.end.geo, s.end.mat, p);
        e.position.y = -s.len - s.r * 0.9;
        if (s.end.rot) e.rotation.copy(s.end.rot);
      }
    });
    return joints;
  }

  const gloveGeo = new RoundedBoxGeometry(0.09, 0.14, 0.065, 2, 0.025);
  const bootGeo = new RoundedBoxGeometry(0.14, 0.13, 0.3, 2, 0.04);
  const arms = [];
  for (const sx of [-1, 1]) {
    arms.push(
      limb(body, new THREE.Vector3(sx * 0.36, 0.42, 0), new THREE.Euler(-0.5, 0, sx * 0.95), [
        { r: 0.085, len: 0.25, bend: new THREE.Euler(-1.1, 0, 0) },
        { r: 0.075, len: 0.24, end: { geo: gloveGeo, mat: glove } },
      ]),
    );
  }
  const legs = [];
  for (const sx of [-1, 1]) {
    legs.push(
      limb(body, new THREE.Vector3(sx * 0.14, -0.2, 0), new THREE.Euler(0.8, 0, sx * 0.12), [
        { r: 0.11, len: 0.36, stripe: true, bend: new THREE.Euler(-1.05, 0, 0) },
        { r: 0.09, len: 0.36, stripe: true, end: { geo: bootGeo, mat: suitDark, rot: new THREE.Euler(0.6, 0, 0) } },
      ]),
    );
  }
  const brief = mesh(new THREE.CapsuleGeometry(0.2, 0.08, 6, 14), suitMat, body);
  brief.scale.set(1.2, 1, 0.9);
  brief.position.y = -0.18;
  const waistRing = mesh(new THREE.TorusGeometry(0.25, 0.025, 8, 24), metal, body);
  waistRing.rotation.x = Math.PI / 2;
  waistRing.scale.set(1.15, 0.85, 1);
  waistRing.position.y = -0.05;

  // A severed safety tether, curling where the debris cut it.
  const tetherCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.22, -0.1, 0.05),
    new THREE.Vector3(0.6, -0.4, 0.3),
    new THREE.Vector3(0.9, -0.2, 0.9),
    new THREE.Vector3(1.3, -0.7, 1.2),
    new THREE.Vector3(1.2, -1.1, 1.8),
    new THREE.Vector3(1.55, -1.2, 2.3),
  ]);
  const tether = mesh(new THREE.TubeGeometry(tetherCurve, 64, 0.008, 6), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.4, metalness: 0.8 }), body);

  body.rotation.set(0.3, 0.6, 0.2);

  // ----- dynamics & behaviour -----
  const state = {
    velocity: new THREE.Vector3(),
    spin: new THREE.Vector3(0.05, 0.11, -0.03),
    lampLevel: 1,
    lampAlive: true,
    faceTarget: null,
    faceT: 0,
    bottleTaken: false,
  };
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _m = new THREE.Matrix4();
  let t = Math.random() * 10;
  let flicker = 1;

  function update(dt, time) {
    t += dt;
    root.position.addScaledVector(state.velocity, dt);
    if (state.faceTarget) {
      // Turn slowly, as if something made her look at you.
      state.faceT = Math.min(1, state.faceT + dt / 5.5);
      _m.lookAt(state.faceTarget, root.position, UP);
      _q.setFromRotationMatrix(_m);
      root.quaternion.slerp(_q, 0.012 + state.faceT * 0.02);
    } else {
      _q.setFromEuler(_e.set(state.spin.x * dt, state.spin.y * dt, state.spin.z * dt));
      root.quaternion.multiply(_q);
    }
    // Limbs drift in the joints' slack.
    arms.forEach((a, i) => {
      a[0].rotation.x = -0.5 + Math.sin(t * 0.37 + i) * 0.08;
      a[1].rotation.x = -1.1 + Math.sin(t * 0.29 + i * 2) * 0.1;
    });
    legs.forEach((l, i) => {
      l[1].rotation.x = -1.05 + Math.sin(t * 0.23 + i) * 0.06;
    });
    // Failing lamps: mostly on, sometimes gasping.
    if (state.lampAlive) {
      if (Math.random() < dt * 1.6) flicker = Math.random() * 0.4;
      flicker = THREE.MathUtils.lerp(flicker, 1, dt * 6);
      const lv = state.lampLevel * flicker;
      lampLight.intensity = 5 * lv;
      for (const l of lamps) l.material.color.setRGB(2 * lv, 1.9 * lv, 1.7 * lv);
    } else {
      lampLight.intensity = 0;
      for (const l of lamps) l.material.color.setRGB(0.02, 0.02, 0.02);
    }
  }

  const homeRot = body.rotation.clone();
  function reset() {
    state.velocity.set(0, 0, 0);
    state.spin.set(0.05, 0.11, -0.03);
    state.lampLevel = 1;
    state.lampAlive = true;
    state.faceTarget = null;
    state.faceT = 0;
    state.bottleTaken = false;
    bottle.visible = true;
    root.quaternion.identity();
    body.rotation.copy(homeRot);
  }

  function killLamps() {
    state.lampAlive = false;
  }

  function takeBottle() {
    state.bottleTaken = true;
    bottle.visible = false;
  }

  const UP = new THREE.Vector3(0, 1, 0);
  const helmetWorld = new THREE.Vector3();
  function helmetPosition() {
    return head.getWorldPosition(helmetWorld);
  }

  return { root, state, update, reset, killLamps, takeBottle, helmetPosition, radius: 0.75 };
}
