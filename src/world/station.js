import * as THREE from 'three';
import { makeBlanket, makeFoil, makeSolar, makeRadiator, makeDecal, makeWindowGlow, rng } from './textures.js';

// ---------------------------------------------------------------------------
// Station ARGUS — a fictional, ISS-class outpost. ~115 m across the arrays.
// Frame: X = flight direction, Y = zenith, Z = starboard. Metres.
// Every solid part registers a signed-distance collider used for collisions,
// grabbing handrails, and working out whether you are shielded from debris.
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// ----- signed distance primitives (local space) -----
function sdCylinder(p, halfLen, r) {
  // axis = local Y
  const dx = Math.hypot(p.x, p.z) - r;
  const dy = Math.abs(p.y) - halfLen;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy);
}
function sdBox(p, hx, hy, hz) {
  const qx = Math.abs(p.x) - hx;
  const qy = Math.abs(p.y) - hy;
  const qz = Math.abs(p.z) - hz;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0);
}
function sdSphere(p, r) {
  return p.length() - r;
}

class Collider {
  // shape: 'cyl' {halfLen, r} axis local Y; 'box' {hx,hy,hz}; 'sphere' {r}
  constructor(shape, params, matrix, parent = null, { shield = true, grab = true, name = '' } = {}) {
    this.shape = shape;
    this.params = params;
    this.local = matrix.clone(); // collider space -> parent space
    this.parent = parent; // Object3D whose world matrix applies (rotating arrays)
    this.shield = shield;
    this.grab = grab;
    this.name = name;
    this.enabled = true;
    this.inv = new THREE.Matrix4();
    this.world = new THREE.Matrix4();
    this.bound = 0;
    this.center = new THREE.Vector3();
    const p = params;
    this.bound = shape === 'cyl' ? Math.hypot(p.halfLen, p.r) : shape === 'box' ? Math.hypot(p.hx, p.hy, p.hz) : p.r;
    this.refresh();
  }
  refresh() {
    if (this.parent) {
      this.parent.updateWorldMatrix(true, false);
      this.world.multiplyMatrices(this.parent.matrixWorld, this.local);
    } else {
      this.world.copy(this.local);
    }
    this.inv.copy(this.world).invert();
    this.center.setFromMatrixPosition(this.world);
  }
  dist(pw) {
    _v.copy(pw).applyMatrix4(this.inv);
    const p = this.params;
    if (this.shape === 'cyl') return sdCylinder(_v, p.halfLen, p.r);
    if (this.shape === 'box') return sdBox(_v, p.hx, p.hy, p.hz);
    return sdSphere(_v, p.r);
  }
}

function matFromPosQuat(pos, quat) {
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
}
const QX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2); // Y -> X
const QZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // Y -> Z

// Scale a geometry's UVs so a texture tile covers `tile` metres.
function tileUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

export function buildStation({ maxAnisotropy = 8 } = {}) {
  const root = new THREE.Group();
  root.name = 'ARGUS';
  const colliders = [];
  const rand = rng(1977);
  const updaters = [];

  // ---------------- materials ----------------
  const blanket = makeBlanket(11);
  const blanketB = makeBlanket(23);
  const gold = makeFoil(5, true);
  const silver = makeFoil(8, false);
  const solar = makeSolar(3);
  const radiator = makeRadiator(4);
  for (const t of [blanket.map, blanketB.map, solar.map]) t.anisotropy = maxAnisotropy;

  const M = {
    white: new THREE.MeshStandardMaterial({ map: blanket.map, normalMap: blanket.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.86, metalness: 0 }),
    whiteB: new THREE.MeshStandardMaterial({ map: blanketB.map, normalMap: blanketB.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.88, metalness: 0, color: new THREE.Color(0.93, 0.95, 0.88) }),
    sage: new THREE.MeshStandardMaterial({ map: blanketB.map, normalMap: blanketB.normalMap, roughness: 0.9, metalness: 0, color: new THREE.Color(0.74, 0.78, 0.66) }),
    gold: new THREE.MeshStandardMaterial({ map: gold.map, normalMap: gold.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughnessMap: gold.roughnessMap, roughness: 0.55, metalness: 1 }),
    silver: new THREE.MeshStandardMaterial({ map: silver.map, normalMap: silver.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughnessMap: silver.roughnessMap, roughness: 0.5, metalness: 1 }),
    truss: new THREE.MeshStandardMaterial({ color: 0xaeb2b8, roughness: 0.42, metalness: 0.75 }),
    trussDark: new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.5, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.62, metalness: 0.3 }),
    ring: new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.38, metalness: 0.85 }),
    solarFront: new THREE.MeshStandardMaterial({ map: solar.map, roughnessMap: solar.roughnessMap, roughness: 1, metalness: 0.55, envMapIntensity: 1.4 }),
    solarBack: new THREE.MeshStandardMaterial({ map: solar.backMap, roughness: 0.8, metalness: 0 }),
    radiator: new THREE.MeshStandardMaterial({ map: radiator.map, roughness: 0.45, metalness: 0.05 }),
    rail: new THREE.MeshStandardMaterial({ color: 0xd9a61e, roughness: 0.45, metalness: 0.2 }),
    window: new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.05, metalness: 0.9, emissiveMap: makeWindowGlow(), emissive: new THREE.Color(1, 0.86, 0.66), emissiveIntensity: 2.2 }),
  };

  // ---------------- helpers ----------------
  function add(mesh, parent = root) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function collider(shape, params, pos, quat = new THREE.Quaternion(), parent = null, opts = {}) {
    const c = new Collider(shape, params, matFromPosQuat(pos, quat), parent, opts);
    colliders.push(c);
    return c;
  }

  // Cylindrical pressurised module along X, with ribs and end cones.
  function module({ x0, x1, r, mat = M.white, name, ribs = true, cones = true, tile = 2.2 }) {
    const len = x1 - x0;
    const g = tileUV(new THREE.CylinderGeometry(r, r, len, 56, 1, true), (2 * Math.PI * r) / tile, len / tile);
    const m = add(new THREE.Mesh(g, mat));
    m.quaternion.copy(QX);
    m.position.set((x0 + x1) / 2, 0, 0);
    if (ribs) {
      const n = Math.max(2, Math.round(len / 2.6));
      for (let i = 0; i <= n; i++) {
        const ring = add(new THREE.Mesh(new THREE.TorusGeometry(r + 0.02, 0.045, 6, 56), M.ring));
        ring.rotation.y = Math.PI / 2;
        ring.position.set(x0 + (len * i) / n, 0, 0);
      }
    }
    if (cones) {
      for (const [xe, dir] of [[x0, -1], [x1, 1]]) {
        const cone = add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r, 0.55, 48, 1, false), M.silver));
        cone.quaternion.copy(QX);
        if (dir < 0) cone.rotateX(Math.PI);
        cone.position.set(xe + dir * 0.27, 0, 0);
      }
    }
    collider('cyl', { halfLen: len / 2 + 0.3, r }, new THREE.Vector3((x0 + x1) / 2, 0, 0), QX, null, { name });
    // handrails in four rows
    for (const ang of [0.8, 2.35, 3.9, 5.5]) {
      for (let x = x0 + 0.9; x < x1 - 0.9; x += 1.6) rails.push({ p: new THREE.Vector3(x, Math.sin(ang) * (r + 0.12), Math.cos(ang) * (r + 0.12)), axis: 'x' });
    }
    return m;
  }
  const rails = [];

  // ================= pressurised segment =================
  module({ x0: -3.2, x1: 3.2, r: 2.3, name: 'Node 1' });
  module({ x0: 3.2, x1: 12.8, r: 2.15, name: 'Laboratory', mat: M.white });
  module({ x0: 12.8, x1: 19.0, r: 2.3, name: 'Node 2', mat: M.whiteB });
  module({ x0: -15.0, x1: -3.2, r: 2.05, name: 'FGB', mat: M.sage, tile: 2.6 });
  module({ x0: -26.5, x1: -15.0, r: 2.15, name: 'Service module', mat: M.sage, tile: 2.6 });
  module({ x0: -29.6, x1: -26.5, r: 1.35, name: 'Aft port', mat: M.silver, ribs: false });

  // Gold foil sections, like the ISS's older modules.
  const goldBand = add(new THREE.Mesh(tileUV(new THREE.CylinderGeometry(2.17, 2.17, 3.0, 48, 1, true), 4, 1.5), M.gold));
  goldBand.quaternion.copy(QX);
  goldBand.position.set(-20.2, 0, 0);

  // Name on the lab.
  const nameDecal = new THREE.Mesh(
    new THREE.PlaneGeometry(4.0, 1.0),
    new THREE.MeshStandardMaterial({ map: makeDecal(['ARGUS'], { size: 96, color: '#1b2233' }), transparent: true, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  nameDecal.position.set(8.0, 0.0, 2.17);
  root.add(nameDecal);

  // Docking adapter + crew capsule at the forward port.
  const pma = add(new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.3, 1.6, 40), M.silver));
  pma.quaternion.copy(QX);
  pma.position.set(19.8, 0, 0);
  const capsulePts = [
    [0.0, 0.0], [0.72, 0.0], [0.75, 0.15], [1.65, 2.4], [1.95, 2.9], [1.97, 3.05], [1.9, 3.1], [1.9, 6.4], [1.8, 6.5], [0, 6.5],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const capsuleGeo = new THREE.LatheGeometry(capsulePts, 56);
  const capsule = add(new THREE.Mesh(capsuleGeo, new THREE.MeshStandardMaterial({ color: 0xe9e7e1, roughness: 0.55, metalness: 0.1 })));
  capsule.quaternion.copy(QX);
  capsule.position.set(20.6, 0, 0);
  // trunk solar cells on one half
  const trunkCells = add(new THREE.Mesh(tileUV(new THREE.CylinderGeometry(1.915, 1.915, 3.2, 40, 1, true, 0, Math.PI), 2, 1), M.solarFront));
  trunkCells.quaternion.copy(QX);
  trunkCells.position.set(20.6 + 4.75, 0, 0);
  collider('cyl', { halfLen: 3.3, r: 1.95 }, new THREE.Vector3(23.9, 0, 0), QX, null, { name: 'Capsule' });
  collider('cyl', { halfLen: 0.8, r: 1.3 }, new THREE.Vector3(19.8, 0, 0), QX, null, { name: 'Adapter' });

  // Service-module solar panels (small, fixed).
  for (const side of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(-22.5, 0, side * 2.2);
    root.add(g);
    const mast = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 11, 8), M.truss), g);
    mast.quaternion.copy(QZ);
    mast.position.z = side * 5.5;
    for (let i = 0; i < 4; i++) {
      const pz = side * (1.6 + i * 2.45);
      const front = add(new THREE.Mesh(tileUV(new THREE.PlaneGeometry(2.3, 3.4), 1, 0.5), M.solarFront), g);
      front.rotation.x = -Math.PI / 2;
      front.position.set(0, 0.03, pz);
      const back = add(new THREE.Mesh(new THREE.PlaneGeometry(2.3, 3.4), M.solarBack), g);
      back.rotation.x = Math.PI / 2;
      back.position.set(0, 0.0, pz);
    }
    collider('box', { hx: 1.7, hy: 0.1, hz: 5.2 }, new THREE.Vector3(-22.5, 0, side * 7.6), undefined, null, { shield: false, name: 'SM array' });
  }

  // ================= airlock (starboard of Node 1) =================
  const airlockGroup = new THREE.Group();
  root.add(airlockGroup);
  const eqLock = add(new THREE.Mesh(tileUV(new THREE.CylinderGeometry(2.0, 2.0, 2.8, 48, 1, false), 5.5, 1.3), M.whiteB), airlockGroup);
  eqLock.quaternion.copy(QZ);
  eqLock.position.set(0, 0, 3.6);
  const crewLock = add(new THREE.Mesh(tileUV(new THREE.CylinderGeometry(1.3, 1.3, 2.6, 40, 1, false), 3.6, 1.2), M.white), airlockGroup);
  crewLock.quaternion.copy(QZ);
  crewLock.position.set(0, 0, 6.3);
  for (const z of [2.3, 5.0, 7.55]) {
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(z < 5.5 ? 2.02 : 1.32, 0.05, 6, 48), M.ring), airlockGroup);
    ring.position.set(0, 0, z);
  }
  // High-pressure gas tanks on the equipment lock.
  for (const [x, y] of [[1.2, 2.0], [-1.2, 2.0]]) {
    const tank = add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), M.gold), airlockGroup);
    tank.position.set(x, y, 4.0);
    collider('sphere', { r: 0.6 }, new THREE.Vector3(x, y, 4.0), undefined, null, { name: 'Gas tank' });
  }
  // Hatch: recessed disc, handle, warning stripes, status light.
  const hatchFrame = add(new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.08, 10, 40), M.ring), airlockGroup);
  hatchFrame.position.set(0, 0, 7.62);
  const hatchPivot = new THREE.Group();
  hatchPivot.position.set(0.62, 0, 7.6);
  airlockGroup.add(hatchPivot);
  const hatch = add(new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.1, 40), new THREE.MeshStandardMaterial({ color: 0xd8d6cf, roughness: 0.6, metalness: 0.3 })), hatchPivot);
  hatch.quaternion.copy(QZ);
  hatch.position.set(-0.62, 0, 0.02);
  const handle = add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 20, Math.PI), M.rail), hatchPivot);
  handle.position.set(-0.62, 0, 0.12);
  const stripes = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.95, 40),
    new THREE.MeshStandardMaterial({ map: makeDecal([''], { w: 512, h: 64, stripe: true }), roughness: 0.7, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  stripes.position.set(0, 0, 7.615);
  airlockGroup.add(stripes);
  const hatchLabel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.225),
    new THREE.MeshStandardMaterial({ map: makeDecal(['EV HATCH 1', 'CREWLOCK · PUSH TO OPEN'], { size: 60, color: '#20242e' }), transparent: true, roughness: 0.9, depthWrite: false }),
  );
  hatchLabel.position.set(0, 1.315, 6.9);
  hatchLabel.rotation.x = -Math.PI / 2;
  airlockGroup.add(hatchLabel);
  collider('cyl', { halfLen: 1.5, r: 2.0 }, new THREE.Vector3(0, 0, 3.6), QZ, null, { name: 'Equipment lock' });
  collider('cyl', { halfLen: 1.35, r: 1.3 }, new THREE.Vector3(0, 0, 6.3), QZ, null, { name: 'Crew lock' });
  for (let a = 0; a < 4; a++) {
    const ang = (a / 4) * Math.PI * 2 + Math.PI / 4;
    rails.push({ p: new THREE.Vector3(Math.cos(ang) * 1.05, Math.sin(ang) * 1.05, 7.75), axis: a % 2 ? 'x' : 'y' });
  }
  for (let z = 5.3; z < 7.4; z += 0.9) {
    for (const ang of [0.6, 2.5, 3.8, 5.6]) rails.push({ p: new THREE.Vector3(Math.cos(ang) * 1.42, Math.sin(ang) * 1.42, z), axis: 'z' });
  }

  // Status lamp beside the hatch + a work floodlight aimed at it.
  const statusLamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 3.0, 0.6) }));
  statusLamp.position.set(-0.85, 0.55, 7.66);
  airlockGroup.add(statusLamp);
  const flood = new THREE.SpotLight(0xfff0dc, 9, 22, 0.6, 0.7, 2);
  flood.position.set(0, 2.4, 6.9);
  flood.target.position.set(0, 0, 9.5);
  airlockGroup.add(flood, flood.target);
  const floodLens = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.8, 2.5) }));
  floodLens.position.set(0, 2.36, 6.95);
  floodLens.lookAt(0, 0, 9.5);
  airlockGroup.add(floodLens);
  const floodHousing = add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.3), M.dark), airlockGroup);
  floodHousing.position.set(0, 2.45, 6.85);
  const floodPost = add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.2, 8), M.truss), airlockGroup);
  floodPost.position.set(0, 1.85, 6.85);

  // ================= cupola (nadir of Node 1) =================
  const cupola = new THREE.Group();
  cupola.position.set(0, -2.3, 0);
  root.add(cupola);
  const cupBody = add(new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.0, 1.1, 6, 1, false), M.silver), cupola);
  cupBody.position.y = -0.55;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.62), M.window);
    const rr = 1.075;
    w.position.set(Math.cos(a) * rr, -0.55, Math.sin(a) * rr);
    w.lookAt(Math.cos(a) * 5, -0.55 - 3.9 * 0.4, Math.sin(a) * 5);
    cupola.add(w);
  }
  const topWin = new THREE.Mesh(new THREE.CircleGeometry(0.62, 32), M.window);
  topWin.position.y = -1.12;
  topWin.rotation.x = Math.PI / 2;
  cupola.add(topWin);
  collider('cyl', { halfLen: 0.6, r: 1.45 }, new THREE.Vector3(0, -2.9, 0), undefined, null, { name: 'Cupola' });
  const cupolaLight = new THREE.PointLight(0xffd9a8, 2.5, 9, 2);
  cupolaLight.position.set(0, -3.8, 0);
  root.add(cupolaLight);

  // Small windows along the lab.
  for (const x of [5.0, 10.5]) {
    const w = new THREE.Mesh(new THREE.CircleGeometry(0.25, 24), M.window);
    w.position.set(x, -2.16, 0);
    w.rotation.x = Math.PI / 2;
    root.add(w);
  }

  // ================= Z1 strut & main truss =================
  const z1 = add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.4, 2.2), M.white));
  z1.position.set(0, 3.9, 0);
  collider('box', { hx: 1.1, hy: 1.7, hz: 1.1 }, new THREE.Vector3(0, 3.9, 0), undefined, null, { name: 'Z1' });

  const TRUSS_Y = 7.0;
  const struts = [];
  function lattice(z0, z1_, w, h, bay, cx = 0, cy = TRUSS_Y, into = struts) {
    const hw = w / 2;
    const hh = h / 2;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (const [x, y] of corners) into.push([new THREE.Vector3(cx + x, cy + y, z0), new THREE.Vector3(cx + x, cy + y, z1_), 0.13]);
    const n = Math.max(1, Math.round((z1_ - z0) / bay));
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1_ - z0) * i) / n;
      for (let k = 0; k < 4; k++) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        into.push([new THREE.Vector3(cx + a[0], cy + a[1], z), new THREE.Vector3(cx + b[0], cy + b[1], z), 0.09]);
      }
      if (i < n) {
        const zn = z0 + ((z1_ - z0) * (i + 1)) / n;
        for (let k = 0; k < 4; k++) {
          const a = corners[k];
          const b = corners[(k + 1) % 4];
          if ((i + k) % 2) into.push([new THREE.Vector3(cx + a[0], cy + a[1], z), new THREE.Vector3(cx + b[0], cy + b[1], zn), 0.065]);
          else into.push([new THREE.Vector3(cx + b[0], cy + b[1], z), new THREE.Vector3(cx + a[0], cy + a[1], zn), 0.065]);
        }
      }
    }
  }
  function strutMesh(list, mat, parent = root) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([a, b, r], i) => {
      const len = a.distanceTo(b);
      _v.subVectors(b, a).normalize();
      _q.setFromUnitVectors(UP, _v);
      _m.compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), _q, new THREE.Vector3(r, len, r));
      inst.setMatrixAt(i, _m);
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    parent.add(inst);
    return inst;
  }
  lattice(-31, 31, 4.4, 3.6, 3.1);
  strutMesh(struts, M.truss);
  collider('box', { hx: 2.3, hy: 1.9, hz: 31 }, new THREE.Vector3(0, TRUSS_Y, 0), undefined, null, { name: 'Main truss' });
  for (let z = -29; z <= 29; z += 3.1) {
    for (const x of [-2.25, 2.25]) rails.push({ p: new THREE.Vector3(x, TRUSS_Y + 1.95, z), axis: 'z' });
  }

  // Equipment boxes (ORUs), cable trays and a mobile transporter rail.
  const oruWhite = [];
  const oruGold = [];
  for (let z = -29.5; z < 29.5; z += 1.3 + rand() * 1.8) {
    if (Math.abs(z) < 1.4) continue;
    const s = new THREE.Vector3(0.5 + rand() * 0.8, 0.4 + rand() * 0.6, 0.5 + rand() * 0.9);
    const face = Math.floor(rand() * 3);
    const p = new THREE.Vector3(face === 0 ? -0.8 + rand() * 1.6 : (rand() < 0.5 ? -1 : 1) * (2.2 - s.x / 2), face === 0 ? TRUSS_Y + 1.8 - s.y / 2 : TRUSS_Y - 1.0 + rand() * 1.6, z);
    (rand() < 0.35 ? oruGold : oruWhite).push([p, s]);
  }
  const oruMat = new THREE.MeshStandardMaterial({ color: 0xd9d7d0, roughness: 0.72, metalness: 0.05 });
  for (const [list, mat] of [[oruWhite, oruMat], [oruGold, M.gold]]) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, list.length);
    list.forEach(([p, s], i) => {
      _m.compose(p, new THREE.Quaternion(), s);
      inst.setMatrixAt(i, _m);
    });
    inst.castShadow = inst.receiveShadow = true;
    root.add(inst);
  }
  const railBar = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 62), M.trussDark));
  railBar.position.set(0, TRUSS_Y + 1.86, 0);

  // Radiators, fanned aft of the truss.
  const radiators = [];
  for (const side of [-1, 1]) {
    for (const zc of [13, 21]) {
      const g = new THREE.Group();
      g.position.set(-2.3, TRUSS_Y - 0.6, side * zc);
      g.rotation.z = 0.35;
      root.add(g);
      for (let i = 0; i < 5; i++) {
        const panel = add(new THREE.Mesh(tileUV(new THREE.BoxGeometry(3.0, 0.08, 3.4), 1, 1), M.radiator), g);
        panel.position.set(-1.7 - i * 3.1, 0, 0);
      }
      const spine = add(new THREE.Mesh(new THREE.BoxGeometry(15.6, 0.14, 0.2), M.trussDark), g);
      spine.position.set(-7.9, 0.05, 0);
      g.updateMatrixWorld(true);
      const c = new Collider('box', { hx: 7.8, hy: 0.12, hz: 1.75 }, matFromPosQuat(new THREE.Vector3(-7.9, 0, 0), new THREE.Quaternion()), g, { name: 'Radiator' });
      colliders.push(c);
      radiators.push(g);
    }
  }

  // Antenna worksite (where the EVA was happening): a dish on a short boom
  // off the ram face of the starboard truss.
  const antenna = new THREE.Group();
  antenna.position.set(2.2, TRUSS_Y + 0.6, 22.2);
  root.add(antenna);
  const boom = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.8, 10), M.truss), antenna);
  boom.quaternion.copy(QX);
  boom.position.x = 0.9;
  const mount = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), M.dark), antenna);
  mount.position.set(1.8, 0, 0);
  const dish = add(new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 12, 0, Math.PI * 2, 0, 0.85), new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide })), antenna);
  dish.position.set(2.0, 0.9, 0);
  dish.rotation.z = -0.25;
  dish.rotation.x = Math.PI;
  const feed = add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), M.dark), antenna);
  feed.position.set(2.1, 0.55, 0);
  const antennaCollider = collider('sphere', { r: 0.9 }, new THREE.Vector3(4.2, TRUSS_Y + 1.2, 22.2), undefined, null, { name: 'Antenna' });
  const footRestraint = add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.5), M.rail));
  footRestraint.position.set(2.3, TRUSS_Y + 0.4, 25.4);

  // ================= solar array assemblies =================
  const arrays = []; // rotating groups (alpha joints)
  const wings = [];
  for (const side of [-1, 1]) {
    const joint = add(new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 2.0, 32), M.trussDark));
    joint.quaternion.copy(QZ);
    joint.position.set(0, TRUSS_Y, side * 32);
    collider('cyl', { halfLen: 1.0, r: 1.9 }, new THREE.Vector3(0, TRUSS_Y, side * 32), QZ, null, { name: 'Alpha joint' });

    const alpha = new THREE.Group();
    alpha.position.set(0, TRUSS_Y, 0);
    root.add(alpha);
    arrays.push(alpha);
    const pvStruts = [];
    const z0 = side * 33;
    const z1e = side * 57;
    lattice(Math.min(z0, z1e), Math.max(z0, z1e), 3.0, 3.0, 3.0, 0, 0, pvStruts);
    strutMesh(pvStruts, M.truss, alpha);
    colliders.push(new Collider('box', { hx: 1.6, hy: 1.6, hz: 12 }, matFromPosQuat(new THREE.Vector3(0, 0, side * 45), new THREE.Quaternion()), alpha, { name: 'PV truss' }));

    for (const zc of [side * 39.5, side * 51.5]) {
      const canister = add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.2, 1.6), M.gold), alpha);
      canister.position.set(0, 0, zc);
      colliders.push(new Collider('box', { hx: 0.75, hy: 1.65, hz: 0.85 }, matFromPosQuat(new THREE.Vector3(0, 0, zc), new THREE.Quaternion()), alpha, { name: 'Mast canister' }));
      for (const dir of [-1, 1]) {
        const wing = new THREE.Group();
        wing.position.set(0, dir * 1.6, zc);
        if (dir < 0) wing.rotation.x = Math.PI;
        alpha.add(wing);
        const L = 32;
        for (const off of [-2.9, 2.9]) {
          const front = add(new THREE.Mesh(tileUV(new THREE.PlaneGeometry(4.6, L), 1.4, 7), M.solarFront), wing);
          front.rotation.y = Math.PI / 2;
          front.position.set(0.02, L / 2 + 0.2, off);
          const back = add(new THREE.Mesh(tileUV(new THREE.PlaneGeometry(4.6, L), 1, 6), M.solarBack), wing);
          back.rotation.y = -Math.PI / 2;
          back.position.set(-0.02, L / 2 + 0.2, off);
        }
        const mast = add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, L, 8), M.truss), wing);
        mast.position.y = L / 2;
        const tip = add(new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 10.6), M.trussDark), wing);
        tip.position.y = L + 0.3;
        const c = new Collider('box', { hx: 0.12, hy: L / 2 + 0.3, hz: 5.3 }, matFromPosQuat(new THREE.Vector3(0, L / 2, 0), new THREE.Quaternion()), wing, { shield: false, name: 'Solar wing' });
        colliders.push(c);
        wings.push({ group: wing, collider: c, side, alpha, broken: false, home: { position: wing.position.clone(), quaternion: wing.quaternion.clone() } });
      }
    }
  }

  // ================= handrails (instanced) =================
  const railGeo = new THREE.BoxGeometry(0.035, 0.035, 0.9);
  const railInst = new THREE.InstancedMesh(railGeo, M.rail, rails.length);
  rails.forEach((r, i) => {
    const q = new THREE.Quaternion();
    if (r.axis === 'x') q.setFromAxisAngle(UP, Math.PI / 2);
    else if (r.axis === 'y') q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    _m.compose(r.p, q, new THREE.Vector3(1, 1, 1));
    railInst.setMatrixAt(i, _m);
  });
  railInst.castShadow = true;
  root.add(railInst);

  // ================= navigation beacons =================
  const beacons = [];
  function beacon(pos, color, period, phase, parent = root) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: color.clone() }));
    m.position.copy(pos);
    parent.add(m);
    beacons.push({ m, color, period, phase });
  }
  beacon(new THREE.Vector3(0, 1.6, 56.8), new THREE.Color(0.3, 6, 0.8), 2.0, 0, arrays[1]);
  beacon(new THREE.Vector3(0, 1.6, -56.8), new THREE.Color(7, 0.3, 0.2), 2.0, 0.5, arrays[0]);
  beacon(new THREE.Vector3(27.1, 1.3, 0), new THREE.Color(6, 6, 6), 1.3, 0.2);
  beacon(new THREE.Vector3(-29.7, 0, 0.8), new THREE.Color(7, 0.3, 0.2), 1.7, 0.7);
  beacon(new THREE.Vector3(0, TRUSS_Y + 2.0, 31), new THREE.Color(0.3, 6, 0.8), 2.4, 0.3);
  beacon(new THREE.Vector3(0, TRUSS_Y + 2.0, -31), new THREE.Color(7, 0.3, 0.2), 2.4, 0.9);

  // ================= runtime =================
  const hatchState = { open: 0, target: 0 };
  let windowFlicker = 1;
  let windowsDead = false;
  let cabinPower = 1;

  function trackSun(sunDir, dt, night) {
    // Arrays rotate on their alpha joints to face the Sun; park edge-on at night.
    const target = night ? Math.PI / 2 : Math.atan2(sunDir.y, sunDir.x);
    for (const a of arrays) {
      let d = target - a.rotation.z;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      a.rotation.z += THREE.MathUtils.clamp(d, -0.12 * dt, 0.12 * dt);
    }
  }

  const detached = [];
  // Snap a wing free: it tumbles away, silently, forever.
  function breakWing(index, impulse = new THREE.Vector3(0.4, 0.3, 0.2)) {
    const w = wings[index];
    if (!w || w.broken) return null;
    w.broken = true;
    w.collider.enabled = false;
    w.group.updateWorldMatrix(true, false);
    const worldM = w.group.matrixWorld.clone();
    root.attach(w.group);
    w.group.matrix.copy(worldM);
    w.group.matrix.decompose(w.group.position, w.group.quaternion, w.group.scale);
    const piece = {
      obj: w.group,
      vel: impulse.clone(),
      spin: new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.16),
    };
    detached.push(piece);
    return piece;
  }

  function update(dt, time, orbit) {
    trackSun(orbit.sunDir, dt, orbit.sunVisible < 0.05);
    for (const c of colliders) if (c.parent) c.refresh();

    for (const b of beacons) {
      const ph = ((time / b.period + b.phase) % 1 + 1) % 1;
      const on = ph < 0.06 ? 1 : ph > 0.12 && ph < 0.16 ? 0.6 : 0;
      b.m.material.color.copy(b.color).multiplyScalar(0.02 + on);
    }
    for (const p of detached) {
      p.obj.position.addScaledVector(p.vel, dt);
      _q.setFromEuler(new THREE.Euler(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt));
      p.obj.quaternion.multiply(_q);
    }
    // Cabin lights stutter after the strike.
    if (!windowsDead) {
      const flickerRate = cabinPower < 1 ? 0.06 : 0.004;
      windowFlicker = Math.random() < flickerRate ? 0.05 + Math.random() * 0.5 : THREE.MathUtils.lerp(windowFlicker, 1, 0.2);
      M.window.emissiveIntensity = 2.2 * windowFlicker * cabinPower;
      cupolaLight.intensity = 2.5 * windowFlicker * cabinPower;
    }
    hatchState.open = THREE.MathUtils.damp(hatchState.open, hatchState.target, 1.6, dt);
    hatchPivot.rotation.y = -hatchState.open * 1.9;
    for (const u of updaters) u(dt, time);
  }

  function killWindows(dead = true) {
    if (dead) {
      windowsDead = true;
      M.window.emissiveIntensity = 0.02;
      cupolaLight.intensity = 0;
    } else {
      cabinPower = 0.55;
    }
  }

  function hideAntenna() {
    antenna.visible = false;
    antennaCollider.enabled = false;
  }

  // Put everything back the way it was before the cascade (for a retry).
  function restore() {
    for (const w of wings) {
      if (!w.broken) continue;
      w.alpha.add(w.group);
      w.group.position.copy(w.home.position);
      w.group.quaternion.copy(w.home.quaternion);
      w.group.scale.set(1, 1, 1);
      w.collider.enabled = true;
      w.broken = false;
    }
    detached.length = 0;
    hatchState.open = hatchState.target = 0;
    windowsDead = false;
    cabinPower = 1;
    antenna.visible = true;
    antennaCollider.enabled = true;
  }

  // ---------- queries ----------
  const nrm = new THREE.Vector3();
  function sdf(p, filter = null) {
    let best = Infinity;
    let bestC = null;
    for (const c of colliders) {
      if (!c.enabled || (filter && !filter(c))) continue;
      const cheap = p.distanceTo(c.center) - c.bound;
      if (cheap > best) continue;
      const d = c.dist(p);
      if (d < best) {
        best = d;
        bestC = c;
      }
    }
    return { d: best, c: bestC };
  }
  function normalAt(p, c) {
    const e = 0.01;
    const px = c.dist(_tmp.set(p.x + e, p.y, p.z)) - c.dist(_tmp.set(p.x - e, p.y, p.z));
    const py = c.dist(_tmp.set(p.x, p.y + e, p.z)) - c.dist(_tmp.set(p.x, p.y - e, p.z));
    const pz = c.dist(_tmp.set(p.x, p.y, p.z + e)) - c.dist(_tmp.set(p.x, p.y, p.z - e));
    return nrm.set(px, py, pz).normalize();
  }
  const _tmp = new THREE.Vector3();
  const _rp = new THREE.Vector3();

  // Sphere-trace along a ray; returns hit distance or Infinity.
  function raycast(origin, dir, maxDist = 150, filter = null) {
    let t = 0;
    for (let i = 0; i < 96 && t < maxDist; i++) {
      _rp.copy(origin).addScaledVector(dir, t);
      const { d } = sdf(_rp, filter);
      if (d < 0.03) return t;
      t += Math.max(d * 0.9, 0.05);
    }
    return Infinity;
  }
  const shieldFilter = (c) => c.shield;

  return {
    root,
    colliders,
    materials: M,
    wings,
    arrays,
    beacons,
    hatchState,
    airlock: {
      hatchPos: new THREE.Vector3(0, 0, 7.7),
      hatchNormal: new THREE.Vector3(0, 0, 1),
      approach: new THREE.Vector3(0, 0, 9.2),
      statusLamp,
      flood,
    },
    worksite: new THREE.Vector3(3.15, TRUSS_Y + 1.2, 25.4),
    update,
    breakWing,
    killWindows,
    hideAntenna,
    restore,
    sdf,
    normalAt,
    raycast,
    shieldFilter,
    detached,
  };
}
