import * as THREE from 'three';
import { createRenderer } from './render.js';
import { Orbit, PERIOD_REAL, TIME_SCALE } from './space/orbit.js';
import { createEarth } from './space/earth.js';
import { createSky } from './space/sky.js';
import { buildStation } from './world/station.js';
import { buildCrewmate } from './world/crewmate.js';
import { createEffects } from './world/effects.js';
import { DebrisStorm } from './world/debris.js';
import { Player, SUIT } from './player.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { AudioEngine } from './audio.js';
import { Story } from './story.js';

const INTRO_PHASE = 20.0; // degrees: over the Pacific, late afternoon, ~100 s before sunset
const STRIKE_PHASE = 32.0;
const SUN_I = 6.0; // sunlight irradiance in scene units

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

export class Game {
  constructor({ canvas, hudRoot, textures, onStateChange }) {
    this.canvas = canvas;
    this.onStateChange = onStateChange || (() => {});
    this.r = createRenderer(canvas);
    const { farScene, nearScene, nearCam } = this.r;
    this.quality = 1;

    // ---- far: Earth & sky ----
    this.orbit = new Orbit();
    this.orbit.setPhase(INTRO_PHASE);
    this.earth = createEarth(textures);
    this.sky = createSky();
    farScene.add(this.sky.group, this.earth.mesh);

    // ---- near: station, crew, effects ----
    const aniso = this.r.renderer.capabilities.getMaxAnisotropy();
    this.station = buildStation({ maxAnisotropy: Math.min(8, aniso) });
    nearScene.add(this.station.root);
    this.crewmate = buildCrewmate();
    nearScene.add(this.crewmate.root);
    this.effects = createEffects(nearScene);
    this.debris = new DebrisStorm({ scene: nearScene, station: this.station, effects: this.effects });
    nearScene.add(nearCam);

    // ---- lighting ----
    this.sun = new THREE.DirectionalLight(0xffffff, SUN_I);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -66;
    sc.right = sc.top = 66;
    sc.near = 1;
    sc.far = 320;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.04;
    this.sun.target.position.set(0, 3, 0);
    nearScene.add(this.sun, this.sun.target);
    this.earthLight = new THREE.HemisphereLight(0x000000, 0x6f8fc4, 0);
    nearScene.add(this.earthLight);
    this.ambient = new THREE.AmbientLight(0x8090b0, 0.004);
    nearScene.add(this.ambient);

    // helmet lamps (two LED clusters on the EVVA)
    this.lamps = [];
    for (const sx of [-1, 1]) {
      const l = new THREE.SpotLight(0xfff4e6, 0, 70, 0.5, 0.55, 1.7);
      l.position.set(sx * 0.19, 0.12, 0.02);
      l.target.position.set(sx * 0.04, -0.2, -10);
      nearCam.add(l, l.target);
      this.lamps.push(l);
    }
    this.lamps[0].castShadow = true;
    this.lamps[0].shadow.mapSize.set(1024, 1024);
    this.lamps[0].shadow.camera.near = 0.2;
    this.lamps[0].shadow.camera.far = 70;
    this.lamps[0].shadow.bias = -0.0005;

    // ---- environment reflections ----
    this.cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    this.cubeCam = new THREE.CubeCamera(1, 2e6, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(this.r.renderer);
    this.envRT = null;
    this.envTimer = 0;

    // ---- systems ----
    this.player = new Player();
    this.input = new Input(canvas);
    this.hud = new HUD(hudRoot);
    this.audio = new AudioEngine();
    this.story = new Story(this);

    this.state = 'loading';
    this.paused = false;
    this.time = 0;
    this.exposure = 1;
    this.adaptation = 0;
    this.shake = 0;
    this.flash = 0;
    this.red = 0;
    this.fade = 1;
    this.fadeTarget = 0;
    this.goldVisor = 0;
    this.titleAngle = 3.9;
    this.lastInput = { interact: false };
    this.stats = {};
    this.distant = false;
    this.distantTimer = 0;
    this.breathFog = 0;
    this.fog = 0;

    this.debris.onPlayerHit = () => this.playerHit();
    this.debris.onImpactNear = (p, s) => this.impactNear(p, s);
    this.debris.onPassStart = () => {
      this.hud.alert('crossing', 'DEBRIS CROSSING', 'warning');
      this.audio.stinger('hit');
    };
    this.debris.onPassEnd = () => {
      this.hud.clearAlert('crossing');
      this.hud.clearAlert('debriswarn');
    };

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.updateEnvironment(true);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.r.nearCam.fov = w / h < 1.1 ? 84 : 66;
    this.r.setSize(w, h, this.quality);
  }

  setQuality(q) {
    this.quality = q;
    this.sun.shadow.mapSize.set(q >= 1 ? 4096 : 2048, q >= 1 ? 4096 : 2048);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.resize();
  }

  // ------------------------------------------------------------ environment
  updateEnvironment(force = false) {
    const r = this.r.renderer;
    const earthU = this.earth.uniforms;
    this.sky.group.visible = false;
    const aurora = earthU.uAurora.value;
    earthU.uDrawSun.value = 0;
    earthU.uAurora.value = 0;
    const ac = r.autoClear;
    r.autoClear = true;
    this.cubeCam.update(r, this.r.farScene);
    r.autoClear = ac;
    this.sky.group.visible = true;
    earthU.uDrawSun.value = 1;
    earthU.uAurora.value = aurora;
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    this.r.nearScene.environment = this.envRT.texture;
  }

  // ------------------------------------------------------------ states
  toTitle() {
    this.state = 'title';
    this.paused = false;
    this.orbit.setPhase(2);
    this.station.restore();
    this.crewmate.reset();
    this.effects.clear();
    this.debris.reset();
    this.hud.clearAll();
    this.hud.setVisible(false);
    this.player.reset();
    this.fadeTarget = 0;
    this.adaptation = 0;
    this.crewmate.root.position.set(1.4, 9.3, 22.6);
    this.input.enabled = false;
    this.r.visor.uniforms.uRim.value = 0;
    this.r.cracks.clear();
    this.onStateChange('title');
    if (this.audio.started) {
      this.audio.resetMix();
      this.audio.startPad();
    }
  }

  async startMission({ skipIntro = false } = {}) {
    await this.audio.start();
    this.audio.stopPad(4);
    this.audio.resetMix();
    this.audio.musicLevel = this._musicOn === false ? 0 : 1;
    this.state = skipIntro ? 'play' : 'intro';
    this.paused = false;
    this.input.enabled = true;
    this.hud.clearAll();
    this.hud.setVisible(true);
    this.r.visor.uniforms.uRim.value = 1;
    this.r.cracks.clear();
    this.station.restore();
    this.effects.clear();
    this.debris.reset();
    this.crewmate.reset();
    this.fade = 1;
    this.fadeTarget = 0;
    this.flash = 0;
    this.red = 0;
    this.shake = 0;
    this.goldVisor = 0;
    this.adaptation = 0;
    this.time = 0;
    this.stats = { start: performance.now(), n2Start: 1 };

    const p = this.player;
    p.reset();
    p.pos.copy(this.station.worksite);
    p.anchored = true;
    p.anchor = p.pos.clone();
    this.lookAt(p, new THREE.Vector3(10, 2.6, 18));
    this.crewmate.root.position.set(5.5, 7.0, 23.5);
    this.crewmate.root.lookAt(4.3, 8.3, 22.2);
    this.crewmate.state.spin.set(0, 0, 0);

    this.story.reset(skipIntro);
    if (skipIntro) {
      this.orbit.setPhase(STRIKE_PHASE);
      this.story.strike();
    } else {
      this.orbit.setPhase(INTRO_PHASE);
      this.story.beginIntro();
    }
    this.updateEnvironment(true);
    this.input.requestLock();
    this.onStateChange(this.state);
  }

  lookAt(p, target) {
    _m.lookAt(p.pos, target, new THREE.Vector3(0, 1, 0));
    p.quat.setFromRotationMatrix(_m);
  }

  // Distant hypervelocity impacts on the starboard arrays, just before the strike.
  distantFlashes(on) {
    this.distant = on;
  }

  strike() {
    const p = this.player;
    const cm = this.crewmate;
    this.state = 'play';
    this.onStateChange('play');
    this.orbit.setPhase(STRIKE_PHASE);
    p.anchored = false;
    p.anchor = null;
    p.vel.set(-0.42, 0.34, -0.12);
    p.angVel.set(0.85, 0.55, 1.05);
    p.aah = false;
    p.o2 = 0.6;
    p.leak = 0.00085;
    p.hits = 1;
    p.stress = 0.9;
    p.hr = 150;
    cm.state.velocity.set(0.38, 0.42, 0.62);
    cm.state.spin.set(0.22, 0.34, -0.17);
    this.r.cracks.add(0.35);
    this.flash = 1;
    this.shake = 1.4;
    this.red = 0.6;
    this.audio.suitHit();
    this.audio.stinger('hit');
    this.audio.setLeak(p.leak);
    // the antenna site erupts
    const site = new THREE.Vector3(4.0, 8.4, 23.0);
    for (let i = 0; i < 9; i++) {
      const pos = site.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 10));
      this.effects.impact(pos, new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5).normalize(), 1.2, { sparks: 50, shards: 6, puff: i % 3 === 0 });
    }
    this.effects.wreckage(site, 9, 70);
    this.effects.wreckage(new THREE.Vector3(0, 12, 45), 18, 60);
    // wounds that keep bleeding
    this.effects.addVent(new THREE.Vector3(23.5, 1.6, 1.0), new THREE.Vector3(0.2, 1, 0.4), 45, 3, 900);
    this.effects.addVent(new THREE.Vector3(9.5, 1.9, 1.1), new THREE.Vector3(0, 1, 0.5), 25, 2.2, 900);
    this.station.breakWing(7, new THREE.Vector3(0.25, 0.35, 0.45));
    this.station.breakWing(5, new THREE.Vector3(-0.1, -0.2, 0.3));
    this.station.hideAntenna();
    this.station.killWindows(false);
  }

  ev2Scare() {
    const cm = this.crewmate;
    cm.state.faceTarget = this.player.pos;
    cm.state.faceT = 0;
    cm.state.lampLevel = 3;
    this.audio.setBeacon(0);
    setTimeout(() => {
      cm.killLamps();
      this.audio.stinger('low');
      this.shake = Math.max(this.shake, 0.3);
    }, 2200);
  }

  takeBottle() {
    const p = this.player;
    p.o2 = Math.min(1, p.o2 + 0.62);
    p.leak *= 0.6;
    this.audio.setLeak(p.leak);
    this.crewmate.takeBottle();
    this.crewmate.state.faceTarget = null;
    this.crewmate.state.spin.set(0.03, -0.05, 0.02);
    this.audio.thud(0.4);
    this.hud.clearAlert('o2flow');
  }

  playerHit() {
    const p = this.player;
    if (!p.alive) return;
    p.hits++;
    p.leak += 0.0011;
    p.angVel.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6));
    p.vel.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.3));
    this.r.cracks.add(0.6 + Math.random() * 0.5);
    this.flash = 0.7;
    this.red = 0.8;
    this.shake = 1.2;
    this.audio.suitHit();
    this.audio.setLeak(p.leak);
    this.hud.alert('pressure', 'SUIT BREACH · PRESSURE DECAY', 'warning');
    this.effects.impact(p.pos.clone().add(this.player.forward.clone().multiplyScalar(0.6)), this.player.forward.clone().negate(), 0.6, { sparks: 25, shards: 1 });
    if (p.hits >= 4) this.death('breach');
  }

  impactNear(pos, strength) {
    const p = this.player;
    const d = pos.distanceTo(p.pos);
    if (d < 60) this.audio.crackle(Math.min(1.5, strength * (1.2 - d / 60)));
    if (p.anchored && d < 30) this.audio.tonk(strength * (1 - d / 30));
    if (d < 12) this.shake = Math.max(this.shake, 0.3 * (1 - d / 12));
  }

  beginEnding() {
    const p = this.player;
    this.state = 'ending';
    p.control = false;
    this.input.enabled = false;
    this.hud.objective(null);
    this.hud.setMode('minimal');
    this.station.hatchState.target = 1;
    this.ending = { t: 0, from: p.pos.clone(), fromQ: p.quat.clone() };
    this.audio.setAlarm(0);
    this.audio.setBeacon(0);
  }

  win() {
    this.state = 'won';
    this.fadeTarget = 1;
    this.finish('won');
  }

  death(kind) {
    if (this.state === 'dead' || this.state === 'won') return;
    const p = this.player;
    p.alive = false;
    p.control = false;
    this.state = 'dead';
    this.story.phase = 'dead';
    this.input.enabled = false;
    this.audio.setAlarm(0);
    this.audio.setBeacon(0);
    if (kind === 'breach') {
      this.flash = 1;
      this.audio.stinger('hit');
      this.fadeTarget = 1;
      this.fadeRate = 0.35;
    } else {
      this.fadeTarget = 1;
      this.fadeRate = 0.18;
    }
    setTimeout(() => {
      this.audio.silenceSuit();
      this.finish(kind);
    }, kind === 'breach' ? 3500 : 6500);
  }

  finish(kind) {
    const p = this.player;
    const secs = this.story.sinceStrike;
    this.stats = {
      kind,
      time: Math.max(0, secs),
      o2: p.o2,
      dvUsed: (1 - p.n2) * SUIT.deltaV,
      hits: p.hits,
    };
    this.input.exitLock();
    this.onStateChange('end', this.stats);
  }

  // ------------------------------------------------------------ frame
  update(dt) {
    if (this.paused) return;
    this.time += dt;
    const input = this.input.enabled ? this.input.frame() : { move: new THREE.Vector3(), roll: 0, lookX: 0, lookY: 0, brake: false, grab: false, interact: false };
    this.lastInput = input;
    const orbit = this.orbit;
    const inMission = this.state === 'intro' || this.state === 'play' || this.state === 'ending' || this.state === 'dead';

    if (this.state !== 'title' || this.titleOrbit) orbit.update(dt);
    this.earth.update(dt, this.time, orbit);
    this.station.update(dt, this.time, orbit);
    this.crewmate.update(dt, this.time);
    if (this.state !== 'title') this.crewmateCollide();

    // key toggles
    if (this.input.enabled) {
      const I = this.input;
      if (I.pressed('KeyR') && this.state === 'play') this.player.engageAAH();
      if (I.pressed('KeyL')) this.toggleLights();
      if (I.pressed('KeyV')) this.player.goldVisor = !this.player.goldVisor;
      if (I.pressed('KeyH')) this.hud.setVisible(!this.hud.visible);
      if (I.pressed('KeyM')) this.toggleMusic();
    }

    const p = this.player;
    if (inMission) {
      const nearEV2 = p.pos.distanceTo(this.crewmate.root.position) < 14;
      const world = {
        station: this.station,
        crewmate: this.crewmate,
        referenceVelocity: nearEV2 ? this.crewmate.state.velocity : new THREE.Vector3(),
        onPushOff: () => this.audio.thud(0.12),
        onGrab: (v) => this.audio.thud(0.1 + v * 0.5),
        onCollide: (v, c) => this.collide(v, c),
        onBumpCrewmate: (v) => this.audio.thud(0.15 + v * 0.3),
      };
      this.referenceName = nearEV2 ? 'EV2' : 'station';
      if (this.state === 'intro') {
        // anchored at the worksite: look, don't fly
        const lookOnly = { ...input, move: new THREE.Vector3(), brake: false, grab: false };
        p.update(dt, lookOnly, world);
      } else if (this.state === 'ending') {
        this.updateEnding(dt);
      } else {
        p.update(dt, input, world);
      }

      if (this.state === 'play' || this.state === 'intro' || this.state === 'dead') {
        this.debris.update(dt, p.pos);
        const pass = this.debris.next();
        const ttn = this.debris.timeToNext();
        p.updateBody(dt, {
          dark: orbit.sunVisible < 0.1,
          debrisWarning: pass && ttn < 30 && ttn > 0,
          debrisActive: !!this.debris.active,
          exposed: this.debris.exposed,
          scare: this.story.scare,
          distanceFear: Math.min(0.3, Math.max(0, p.pos.length() - 70) / 150),
          consumeO2: this.state === 'play',
        });
      }
      this.story.update(dt);
      if (this.state === 'play' && p.lastImpact > 0) {
        const imp = p.lastImpact;
        p.lastImpact = 0;
        if (imp > 3.4) this.death('breach');
        else this.playerHit();
      }
    } else if (this.state === 'title') {
      this.updateTitleCamera(dt);
    }

    // lamps
    const lampOn = p.lights && inMission && this.state !== 'dead';
    for (const l of this.lamps) l.intensity = THREE.MathUtils.damp(l.intensity, lampOn ? 13 : 0, 12, dt);

    // lighting from the orbit model
    const sunVis = orbit.sunVisible;
    this.sun.color.copy(orbit.sunColor);
    const m = Math.max(orbit.sunColor.r, orbit.sunColor.g, orbit.sunColor.b, 1e-4);
    this.sun.color.multiplyScalar(1 / m);
    this.sun.intensity = SUN_I * m;
    this.sun.position.copy(orbit.sunDir).multiplyScalar(160).add(this.sun.target.position);
    this.sun.castShadow = m > 0.01;
    this.earthLight.intensity = SUN_I * 0.26 * orbit.dayFactor;
    this.earthLight.groundColor.setRGB(0.55, 0.68, 0.95);

    this.effects.update(dt, {
      sunLevel: sunVis,
      lampOn,
      lampPos: this.r.nearCam.position,
      lampDir: _v.set(0, 0, -1).applyQuaternion(this.r.nearCam.quaternion),
      pointScale: (this.h * this.r.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(this.r.nearCam.fov / 2))),
    });

    this.updateCamera(dt);
    this.updateExposure(dt, lampOn);

    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 0.8;
      this.updateEnvironment();
    }

    this.updateAudio(dt);
    if (inMission && this.state !== 'ending') this.updateHUD(dt);
    this.updateVisor(dt);

    // distant sparkle on the starboard arrays before the strike
    if (this.distant) {
      this.distantTimer -= dt;
      if (this.distantTimer <= 0) {
        this.distantTimer = 0.15 + Math.random() * 0.5;
        const w = this.station.wings[4 + Math.floor(Math.random() * 4)];
        if (w && !w.broken) {
          const pos = new THREE.Vector3(0, 4 + Math.random() * 28, (Math.random() - 0.5) * 9).applyMatrix4(w.group.matrixWorld);
          this.effects.impact(pos, new THREE.Vector3(1, 0, 0), 0.35, { sparks: 10, shards: 1 });
        }
      }
    }

    if (this.input.enabled) this.input.endFrame();
    else this.input.edges.clear();
  }

  // Her body drifts, and bounces off whatever it meets.
  crewmateCollide() {
    const cm = this.crewmate;
    const s = this.station.sdf(cm.root.position);
    if (s.c && s.d < 0.7) {
      const n = this.station.normalAt(cm.root.position, s.c).clone();
      cm.root.position.addScaledVector(n, 0.7 - s.d);
      const vn = cm.state.velocity.dot(n);
      if (vn < 0) {
        cm.state.velocity.addScaledVector(n, -1.4 * vn);
        cm.state.spin.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(-vn * 0.8));
        const d = cm.root.position.distanceTo(this.player.pos);
        if (this.player.anchored && d < 40) this.audio.tonk(0.4);
      }
    }
  }

  toggleLights() {
    this.player.lights = !this.player.lights;
    this.audio._click?.(0.05, this.audio.helmet, 2500);
  }

  toggleMusic() {
    this._musicOn = this._musicOn === false;
    this.audio.musicLevel = this._musicOn ? 1 : 0;
    this.hud.alert('music', this._musicOn ? 'SCORE ON' : 'SCORE OFF', 'info', 2);
  }

  collide(v, c) {
    this.audio.thud(Math.min(1.5, v * 0.7));
    this.shake = Math.max(this.shake, Math.min(1, v * 0.4));
    if (v > 1.2) this.hud.alert('collision', `IMPACT ${v.toFixed(1)} m/s`, v > 2.2 ? 'warning' : 'caution', 3);
  }

  updateEnding(dt) {
    const e = this.ending;
    const p = this.player;
    e.t += dt;
    const inside = new THREE.Vector3(0, 0, 6.5);
    const k = THREE.MathUtils.smoothstep(e.t, 1.2, 5.0);
    p.pos.lerpVectors(e.from, inside, k);
    _m.lookAt(p.pos, new THREE.Vector3(0, 0, 30), new THREE.Vector3(0, 1, 0));
    _q.setFromRotationMatrix(_m);
    p.quat.slerp(_q, Math.min(1, dt * 1.5));
    if (e.t > 4.2) this.station.hatchState.target = 0;
    if (e.t > 4.8) this.fadeTarget = 1;
    this.fadeRate = 0.45;
    p.updateBody(dt, { consumeO2: false, dark: true, scare: 0 });
    p.stress = Math.max(0.05, p.stress - dt * 0.05);
  }

  updateTitleCamera(dt) {
    this.titleAngle += dt * 0.018;
    const cam = this.r.nearCam;
    const a = this.titleAngle;
    const center = new THREE.Vector3(-4, 1, 6);
    cam.position.set(center.x + Math.cos(a) * 88, 22 + Math.sin(a * 0.7) * 6, center.z + Math.sin(a) * 88);
    _m.lookAt(cam.position, new THREE.Vector3(0, -12, 0), new THREE.Vector3(0, 1, 0));
    cam.quaternion.setFromRotationMatrix(_m);
    this.player.pos.copy(cam.position);
  }

  updateCamera(dt) {
    const cam = this.r.nearCam;
    if (this.state === 'title') return;
    const p = this.player;
    cam.position.copy(p.pos);
    cam.quaternion.copy(p.quat);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    if (this.shake > 0) {
      const s = this.shake * this.shake * 0.03;
      _e.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      _q.setFromEuler(_e);
      cam.quaternion.multiply(_q);
    }
    cam.updateMatrixWorld();
  }

  updateExposure(dt, lampOn) {
    const orbit = this.orbit;
    const cam = this.r.nearCam;
    const sunVis = orbit.sunVisible;
    // Is the Sun in view and unobstructed by the station?
    const sunDirCam = _v.copy(orbit.sunDir).applyQuaternion(_q.copy(cam.quaternion).invert());
    let sunOnScreen = 0;
    let sunUV = null;
    if (sunVis > 0.02 && sunDirCam.z < 0) {
      _v2.copy(orbit.sunDir).multiplyScalar(1000).add(cam.position).project(cam);
      if (Math.abs(_v2.x) < 1.3 && Math.abs(_v2.y) < 1.3) {
        const blocked = isFinite(this.station.raycast(cam.position, orbit.sunDir, 130));
        if (!blocked) {
          sunOnScreen = sunVis * THREE.MathUtils.smoothstep(-sunDirCam.z, 0.6, 0.98);
          sunUV = new THREE.Vector2((_v2.x + 1) / 2, (_v2.y + 1) / 2);
        }
      }
    }
    this.sunUV = sunUV;
    this.sunOnScreen = sunOnScreen;

    // Eye adaptation: fast into light, slow into darkness.
    const dayLevel = Math.max(sunVis, 0);
    const darkTarget = lampOn ? 0.55 : 1;
    const adaptTarget = this.state === 'title' ? (dayLevel > 0.3 ? 0 : 0.8) : dayLevel > 0.3 ? 0 : darkTarget * (1 - dayLevel * 3);
    const rate = adaptTarget > this.adaptation ? 0.06 : 1.8;
    this.adaptation += (adaptTarget - this.adaptation) * (1 - Math.exp(-dt * rate));
    let target = 1.0 + this.adaptation * 4.2;
    target *= 1 - sunOnScreen * 0.35;
    // Your own lamps on something close: the eye stops down.
    if (lampOn && this.state !== 'title') {
      const fwd = _v2.set(0, 0, -1).applyQuaternion(cam.quaternion);
      let d = this.station.raycast(cam.position, fwd, 30);
      const toCm = _v.copy(this.crewmate.root.position).sub(cam.position);
      const along = toCm.dot(fwd);
      if (along > 0 && toCm.addScaledVector(fwd, -along).length() < 1.0) d = Math.min(d, along);
      if (isFinite(d)) {
        const lum = (13 * 0.8) / Math.PI / Math.max(d * d, 0.3);
        target = Math.min(target, Math.max(0.55, 0.5 / lum));
      }
    }
    if (this.player.goldVisor) target *= 0.8;
    const er = target < this.exposure ? 3 : 0.5;
    this.exposure += (target - this.exposure) * (1 - Math.exp(-dt * er));
    this.r.renderer.toneMappingExposure = this.exposure;
    this.r.bloom.threshold = 2.2 / this.exposure;
    this.sky.update(orbit, this.adaptation * (this.player.goldVisor ? 0.3 : 1), this.r.pixelRatio);
  }

  updateVisor(dt) {
    const u = this.r.visor.uniforms;
    const p = this.player;
    u.uTime.value = this.time;
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.red = Math.max(0, this.red - dt * 0.6);
    const fr = this.fadeRate || 0.8;
    this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * (this.fadeTarget > this.fade ? fr * 3 : 0.9));
    u.uFlash.value = this.flash * this.flash;
    u.uRed.value = this.red + (this.state === 'play' && p.psi < 3.2 ? 0.04 : 0);
    u.uFade.value = this.fade;
    const inSuit = this.state !== 'title';
    // breath condensation: each exhale fogs the visor a little
    const ph = p.breathPhase;
    const exh = ph > 0.42 && ph < 0.95 ? Math.sin(((ph - 0.42) / 0.53) * Math.PI) : 0;
    this.breathFog += ((exh * (0.1 + p.stress * 0.35)) - this.breathFog) * Math.min(1, dt * 5);
    const fogTarget = inSuit ? Math.min(0.8, Math.max(0, p.stress - 0.35) * 0.9 + (p.leak > 0.002 ? 0.1 : 0)) : 0;
    this.fog += (fogTarget - this.fog) * Math.min(1, dt * 0.3);
    u.uFog.value = this.fog;
    u.uBreath.value = inSuit ? this.breathFog : 0;
    u.uHypoxia.value = inSuit ? p.hypoxia + (p.dying > 0 ? Math.min(1, p.dying / 7) : 0) : 0;
    u.uCrack.value = inSuit ? 1 : 0;
    this.goldVisor += ((p.goldVisor ? 1 : 0) - this.goldVisor) * Math.min(1, dt * 4);
    u.uGold.value = this.goldVisor;
    if (this.sunUV && inSuit) u.uSun.value.set(this.sunUV.x, this.sunUV.y, this.sunOnScreen * (1 - this.goldVisor * 0.7));
    else if (this.sunUV) u.uSun.value.set(this.sunUV.x, this.sunUV.y, this.sunOnScreen * 0.6);
    else u.uSun.value.z = 0;
  }

  updateAudio(dt) {
    if (!this.audio.started) return;
    const p = this.player;
    const inSuit = this.state === 'intro' || this.state === 'play' || this.state === 'ending' || this.state === 'dead';
    const pass = this.debris.next();
    const ttn = this.debris.timeToNext();
    let tension = 0.15;
    if (this.state === 'play') {
      tension += this.orbit.sunVisible < 0.1 ? 0.2 : 0;
      tension += pass && ttn < 30 ? 0.3 * (1 - ttn / 30) : 0;
      tension += this.debris.active ? 0.5 : 0;
      tension += p.o2 < 0.25 ? 0.3 : 0;
      tension += this.story.scare * 0.8;
      const dEV2 = p.pos.distanceTo(this.crewmate.root.position);
      if (this.story.bottleAt < 0 && this.story.flags.beacon) tension += Math.max(0, 0.35 - dEV2 / 60);
    }
    if (this.state === 'intro') tension = 0.05;
    this.audio.update(dt, {
      suitOn: inSuit && this.state !== 'won',
      alive: p.alive,
      breathPhase: p.breathPhase,
      breathRate: p.breathRate,
      stress: p.stress,
      hr: p.hr,
      hypoxia: p.hypoxia + (p.dying > 0 ? 0.5 : 0),
      thrusting: p.thrusting,
      rotThrust: p.rotThrust,
      tension,
      debrisActive: !!this.debris.active,
      inGame: inSuit,
    });
  }

  updateHUD(dt) {
    const p = this.player;
    const orbit = this.orbit;
    const story = this.story;
    const refV = this.referenceName === 'EV2' ? this.crewmate.state.velocity : new THREE.Vector3();
    let target = null;
    const markers = [];
    if (story.objectiveId === 'ev2' && story.bottleAt < 0) {
      const cp = this.crewmate.root.position;
      const rel = _v.copy(cp).sub(p.pos);
      const range = rel.length();
      const closing = -_v2.copy(p.vel).sub(this.crewmate.state.velocity).dot(rel.normalize());
      target = { name: 'EV2', range, closing };
      markers.push({ id: 'ev2', pos: cp, label: 'EV2 · suit beacon', kind: 'target' });
    }
    if (story.objectiveId === 'airlock') {
      const ap = this.station.airlock.hatchPos;
      const rel = _v.copy(ap).sub(p.pos);
      const range = rel.length();
      const closing = -p.vel.dot(rel.normalize());
      target = { name: 'HATCH', range, closing };
      markers.push({ id: 'hatch', pos: ap, label: 'EV hatch 1', kind: 'target' });
    }
    const pass = this.debris.next();
    const ttn = this.debris.timeToNext();
    let debris = null;
    if (this.state === 'play' && pass && ttn < 45) {
      debris = { t: ttn, active: !!this.debris.active, exposed: this.debris.exposed };
      markers.push({ id: 'debris', pos: pass.dir, infinite: true, label: 'debris stream', kind: 'danger' });
    }
    this.hud.markers(markers, this.r.nearCam, this.w, this.h);
    // contextual help for the free way to move: handrails
    let hint = '';
    if (this.state === 'play' && p.alive) {
      if (p.anchored) hint = '<kbd>W</kbd> push off where you look (no propellant) · <kbd>G</kbd> let go';
      else if (story.promptActive !== true) {
        const s = this.station.sdf(p.pos);
        if (s.d < SUIT.grabRange && s.c && s.c.grab) hint = '<kbd>G</kbd> / right-click · grab handrail';
      }
    }
    this.hud.hint(hint);
    const night = orbit.sunVisible < 0.05;
    this.hud.update(dt, {
      o2: p.o2,
      o2Seconds: p.o2Seconds(),
      n2: p.n2,
      dv: p.dvRemaining(),
      psi: p.psi,
      hits: p.hits,
      aah: p.aah,
      aahEngaging: p.aahEngaging > 0,
      lights: p.lights,
      hr: p.hr,
      alive: p.alive,
      night,
      toSunEvent: night ? orbit.secondsToSunrise() : orbit.secondsToSunset(),
      lat: orbit.latitude,
      lon: orbit.longitude,
      comm: story.comm,
      relSpeed: _v.copy(p.vel).sub(refV).length(),
      relRef: this.referenceName === 'EV2' ? 'to EV2' : 'to station',
      target,
      debris,
    });
  }

  render() {
    this.r.render();
  }
}
