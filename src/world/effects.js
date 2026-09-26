import * as THREE from 'three';
import { makeSprite } from './textures.js';

// ---------------------------------------------------------------------------
// Particles & transient light: hypervelocity impact flashes, sparks, venting
// gas that flash-freezes into glittering ice, and drifting shrapnel.
// Nothing here makes a sound. That's the point.
// ---------------------------------------------------------------------------

const pointVert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
uniform float uScale;
uniform float uMaxSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.05), 1.0, uMaxSize);
  vColor = aColor;
}
`;
const pointFrag = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor * t.a, t.a);
}
`;

class PointPool {
  constructor(max, { blending = THREE.AdditiveBlending, soft = true, maxSize = 64 } = {}) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.base = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uMap: { value: makeSprite(soft) }, uScale: { value: 600 }, uMaxSize: { value: maxSize } };
    this.points = new THREE.Points(
      this.geo,
      new THREE.ShaderMaterial({
        vertexShader: pointVert,
        fragmentShader: pointFrag,
        uniforms: this.uniforms,
        blending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  spawn(p, v, color, size, life, grow = 0, kind = 0) {
    let i = this.count;
    if (i >= this.max) {
      // recycle the oldest-looking slot
      i = Math.floor(Math.random() * this.max);
    } else {
      this.count++;
    }
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.base.set([color.r, color.g, color.b], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = this.size0[i] = size;
    this.grow[i] = grow;
    this.life[i] = life;
    this.age[i] = 0;
    this.kind[i] = kind;
  }
  kill(i) {
    const j = --this.count;
    if (i === j) return;
    for (const arr of [this.pos, this.vel, this.base, this.col]) arr.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.size[i] = this.size[j];
    this.size0[i] = this.size0[j];
    this.grow[i] = this.grow[j];
    this.life[i] = this.life[j];
    this.age[i] = this.age[j];
    this.kind[i] = this.kind[j];
  }
  flush() {
    this.geo.setDrawRange(0, this.count);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

export function createEffects(scene) {
  const sparks = new PointPool(1600, { soft: false, maxSize: 7 });
  const gas = new PointPool(1400, { soft: true, maxSize: 90 });
  scene.add(sparks.points, gas.points);

  // ----- flashes: pooled point lights + billboards -----
  const flashes = [];
  for (let i = 0; i < 3; i++) {
    const l = new THREE.PointLight(0xfff0e0, 0, 40, 2);
    scene.add(l);
    flashes.push({ light: l, t: 1, peak: 0 });
  }
  const flashSprites = [];
  const spriteMat = new THREE.SpriteMaterial({ map: makeSprite(true), color: new THREE.Color(30, 26, 22), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  for (let i = 0; i < 12; i++) {
    const s = new THREE.Sprite(spriteMat.clone());
    s.visible = false;
    scene.add(s);
    flashSprites.push({ s, t: 1, life: 0.12, size: 1 });
  }
  let flashIdx = 0;
  let spriteIdx = 0;

  // ----- shrapnel -----
  const shardGeos = [
    new THREE.TetrahedronGeometry(0.12),
    new THREE.BoxGeometry(0.3, 0.012, 0.18),
    new THREE.BoxGeometry(0.08, 0.05, 0.22),
    new THREE.PlaneGeometry(0.5, 0.35, 2, 2),
  ];
  // crumple the foil sheet
  const pa = shardGeos[3].attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setZ(i, (Math.random() - 0.5) * 0.08);
  shardGeos[3].computeVertexNormals();
  const shardMats = [
    new THREE.MeshStandardMaterial({ color: 0xa9adb3, metalness: 0.9, roughness: 0.3 }),
    new THREE.MeshStandardMaterial({ color: 0xe2ded4, metalness: 0, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: 0xc99a45, metalness: 1, roughness: 0.3, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0x14203a, metalness: 0.5, roughness: 0.25, side: THREE.DoubleSide }),
  ];
  const SHARDS_PER = 90;
  const shardSets = shardGeos.map((g, i) => {
    const inst = new THREE.InstancedMesh(g, shardMats[i], SHARDS_PER);
    inst.count = 0;
    inst.castShadow = true;
    inst.frustumCulled = false;
    scene.add(inst);
    return { inst, items: [] };
  });
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3(1, 1, 1);
  const _v = new THREE.Vector3();
  const _c = new THREE.Color();

  function shard(p, v, type = Math.floor(Math.random() * 4)) {
    const set = shardSets[type];
    const item = {
      p: p.clone(),
      v: v.clone(),
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
      w: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
      scale: 0.3 + Math.random() * 0.7,
      age: 0,
    };
    if (set.items.length >= SHARDS_PER) set.items.shift();
    set.items.push(item);
  }

  // ----- vents: persistent leaks that puff crystals -----
  const vents = [];
  function addVent(pos, dir, rate = 60, speed = 3.5, life = 60) {
    vents.push({ pos: pos.clone(), dir: dir.clone().normalize(), rate, speed, life, acc: 0, age: 0 });
  }

  function impact(p, normal, strength = 1, { sparks: nSparks = 40, shards: nShards = 4, puff = false } = {}) {
    // flash light
    const f = flashes[flashIdx++ % flashes.length];
    f.light.position.copy(p).addScaledVector(normal, 0.5);
    f.t = 0;
    f.peak = 900 * strength;
    const fs = flashSprites[spriteIdx++ % flashSprites.length];
    fs.s.position.copy(p).addScaledVector(normal, 0.1);
    fs.t = 0;
    fs.life = 0.09 + Math.random() * 0.08;
    fs.size = 1.5 + strength * 3;
    fs.s.visible = true;
    // spark spray: a cone around the reflected direction
    for (let i = 0; i < nSparks * strength; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.8).add(normal).normalize();
      _v.multiplyScalar(3 + Math.random() * 18 * strength);
      const hot = 0.6 + Math.random() * 0.4;
      _c.setRGB(9 * hot, 5.5 * hot, 2.2 * hot);
      sparks.spawn(p, _v, _c, 0.035 + Math.random() * 0.05, 0.25 + Math.random() * 0.9, 0, 0);
    }
    for (let i = 0; i < nShards * strength; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.6).add(normal).normalize();
      _v.multiplyScalar(0.3 + Math.random() * 2.5);
      shard(p.clone().addScaledVector(normal, 0.2), _v);
    }
    if (puff) {
      for (let i = 0; i < 35; i++) {
        _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.2).add(normal).normalize();
        _v.multiplyScalar(1 + Math.random() * 5);
        _c.setRGB(0.22, 0.23, 0.25);
        gas.spawn(p, _v, _c, 0.05 + Math.random() * 0.08, 1.5 + Math.random() * 2.5, 0.35, 1);
      }
    }
  }

  // Lighting of gas/ice: bright in sunlight, faint otherwise.
  let sunLevel = 1;
  let lampPos = new THREE.Vector3();
  let lampDir = new THREE.Vector3(0, 0, -1);
  let lampOn = false;

  function update(dt, env) {
    sunLevel = env.sunLevel;
    lampOn = env.lampOn;
    lampPos.copy(env.lampPos);
    lampDir.copy(env.lampDir);
    sparks.uniforms.uScale.value = env.pointScale;
    gas.uniforms.uScale.value = env.pointScale;

    for (const f of flashes) {
      f.t += dt;
      f.light.intensity = f.t < 0.2 ? f.peak * Math.exp(-f.t * 30) : 0;
    }
    for (const fs of flashSprites) {
      if (!fs.s.visible) continue;
      fs.t += dt;
      const k = fs.t / fs.life;
      if (k >= 1) {
        fs.s.visible = false;
        continue;
      }
      const sz = fs.size * (0.6 + k * 1.5);
      fs.s.scale.set(sz, sz, sz);
      fs.s.material.opacity = 1 - k;
    }

    // vents
    for (const v of vents) {
      v.age += dt;
      if (v.age > v.life) continue;
      const fade = 1 - v.age / v.life;
      v.acc += v.rate * fade * dt;
      while (v.acc > 1) {
        v.acc -= 1;
        _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.5).add(v.dir).normalize().multiplyScalar(v.speed * (0.5 + Math.random()));
        _c.setRGB(0.3, 0.31, 0.33);
        gas.spawn(v.pos, _v, _c, 0.04 + Math.random() * 0.07, 3 + Math.random() * 4, 0.3, 1);
      }
    }

    // sparks: ballistic, cooling from white-yellow to dull red
    for (let i = sparks.count - 1; i >= 0; i--) {
      sparks.age[i] += dt;
      const k = sparks.age[i] / sparks.life[i];
      if (k >= 1) {
        sparks.kill(i);
        continue;
      }
      const o = i * 3;
      sparks.pos[o] += sparks.vel[o] * dt;
      sparks.pos[o + 1] += sparks.vel[o + 1] * dt;
      sparks.pos[o + 2] += sparks.vel[o + 2] * dt;
      const cool = 1 - k;
      sparks.col[o] = sparks.base[o] * cool;
      sparks.col[o + 1] = sparks.base[o + 1] * cool * cool;
      sparks.col[o + 2] = sparks.base[o + 2] * cool * cool * cool;
    }
    sparks.flush();

    // gas / ice crystals: expand, glitter in light
    for (let i = gas.count - 1; i >= 0; i--) {
      gas.age[i] += dt;
      const k = gas.age[i] / gas.life[i];
      if (k >= 1) {
        gas.kill(i);
        continue;
      }
      const o = i * 3;
      gas.pos[o] += gas.vel[o] * dt;
      gas.pos[o + 1] += gas.vel[o + 1] * dt;
      gas.pos[o + 2] += gas.vel[o + 2] * dt;
      gas.size[i] = gas.size0[i] + gas.grow[i] * gas.age[i];
      let light = 0.02 + sunLevel * 1.4;
      if (lampOn) {
        _v.set(gas.pos[o] - lampPos.x, gas.pos[o + 1] - lampPos.y, gas.pos[o + 2] - lampPos.z);
        const d = _v.length();
        const cone = Math.max(0, _v.dot(lampDir) / Math.max(d, 1e-3) - 0.8) * 5;
        light += (cone * 6) / (1 + d * d * 0.05);
      }
      const glitter = Math.random() < 0.03 ? 4 : 1;
      const a = (1 - k) * (1 - k) * light * glitter;
      gas.col[o] = gas.base[o] * a;
      gas.col[o + 1] = gas.base[o + 1] * a;
      gas.col[o + 2] = gas.base[o + 2] * a;
    }
    gas.flush();

    // shards
    for (const set of shardSets) {
      set.inst.count = set.items.length;
      set.items.forEach((it, i) => {
        it.age += dt;
        it.p.addScaledVector(it.v, dt);
        _q.setFromEuler(new THREE.Euler(it.w.x * dt, it.w.y * dt, it.w.z * dt));
        it.q.multiply(_q);
        _s.setScalar(it.scale);
        _m.compose(it.p, it.q, _s);
        set.inst.setMatrixAt(i, _m);
      });
      set.inst.instanceMatrix.needsUpdate = true;
    }
  }

  // Scatter a slow cloud of wreckage around a point (post-strike debris field).
  function wreckage(center, radius, n) {
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(Math.random() * radius);
      const p = center.clone().add(_v);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.25);
      shard(p, v);
    }
  }

  function clear() {
    sparks.count = 0;
    gas.count = 0;
    vents.length = 0;
    for (const s of shardSets) s.items.length = 0;
    for (const f of flashes) f.light.intensity = 0;
    for (const fs of flashSprites) fs.s.visible = false;
  }

  return { impact, addVent, update, shard, wreckage, clear, vents };
}
