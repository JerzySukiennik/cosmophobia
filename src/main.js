import './style.css';
import * as THREE from 'three';
import { Game } from './game.js';
import dayUrl from './assets/textures/earth_day_4096.jpg';
import nightUrl from './assets/textures/earth_night_4096.jpg';
import brcUrl from './assets/textures/earth_bump_roughness_clouds_4096.jpg';

const $ = (id) => document.getElementById(id);
const screens = { title: $('title'), pause: $('pause'), end: $('end'), loading: $('loading') };

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

function setLoading(frac, msg) {
  $('l-fill').style.transform = `scaleX(${frac})`;
  if (msg) $('l-msg').textContent = msg;
}

function webgl2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

async function loadTextures(renderer) {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const list = [
    ['day', dayUrl, true, 'Loading the Earth'],
    ['night', nightUrl, true, 'Switching on the cities'],
    ['brc', brcUrl, false, 'Forming clouds'],
  ];
  const out = {};
  let i = 0;
  for (const [key, url, srgb, msg] of list) {
    setLoading(0.1 + (i / list.length) * 0.6, msg);
    const t = await loader.loadAsync(url);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    out[key] = t;
    i++;
  }
  return out;
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const ENDINGS = {
  won: {
    title: 'You made it inside.',
    body: 'The fragments of the cascade now circle the Earth in a shell of their own. Every ninety-two minutes the station passes through it again. Mara Ellison is still out there, a few hundred metres off the starboard truss, keeping pace.',
  },
  o2: {
    title: 'Oxygen depleted.',
    body: 'Your body will stay up for months, until the thin upper air finally drags it down. It will burn up in a few seconds somewhere over the Pacific: a bright streak that someone on a beach will make a wish on.',
  },
  breach: {
    title: 'Suit breach.',
    body: 'Vacuum takes about fifteen seconds to take consciousness. You spent them looking at the Earth.',
  },
  lost: {
    title: 'Lost.',
    body: "With no propellant there is nothing left to push against. Your orbit and the station's drift apart a little more every lap, and the radio gets quieter.",
  },
};

async function boot() {
  if (!webgl2()) {
    setLoading(0, 'This game needs WebGL 2. Try a current Chrome, Edge, Firefox or Safari.');
    return;
  }
  const canvas = $('view');
  // A throwaway renderer only to read capabilities before the real one exists.
  const probe = { capabilities: { getMaxAnisotropy: () => 8 } };
  setLoading(0.05, 'Loading the Earth');
  const textures = await loadTextures(probe);
  setLoading(0.75, 'Building the station');
  await new Promise((r) => setTimeout(r, 30));

  let game;
  const onState = (state, stats) => {
    if (state === 'title') show('title');
    else if (state === 'intro' || state === 'play') show(null);
    else if (state === 'end') showEnd(stats);
  };
  game = new Game({ canvas, hudRoot: $('hud'), textures, onStateChange: onState });
  window.__game = game;

  setLoading(0.9, 'Compiling shaders');
  await new Promise((r) => setTimeout(r, 30));
  try {
    game.r.renderer.compile(game.r.farScene, game.r.farCam);
    game.r.renderer.compile(game.r.nearScene, game.r.nearCam);
  } catch (e) {
    console.warn(e);
  }
  setLoading(1, 'Ready');

  // ---------------------------------------------------------------- UI
  const hasPlayed = (() => {
    try {
      return localStorage.getItem('cosmophobia.played') === '1';
    } catch {
      return false;
    }
  })();
  $('begin-skip').hidden = !hasPlayed;

  function begin(skipIntro) {
    try {
      localStorage.setItem('cosmophobia.played', '1');
    } catch {
      /* ignore */
    }
    show(null);
    game.startMission({ skipIntro });
    if (game.input.isTouch && !game.input.touchUI) {
      game.input.buildTouchUI(document.body, {
        aah: () => game.player.engageAAH(),
        lights: () => game.toggleLights(),
        pause: () => pause(),
      });
    }
    if (game.input.touchUI) game.input.touchUI.hidden = false;
  }
  $('begin').addEventListener('click', () => begin(false));
  $('begin-skip').addEventListener('click', () => begin(true));

  // Title music starts on the first interaction (browsers require one).
  const wake = async () => {
    if (game.state !== 'title') return;
    await game.audio.start();
    game.audio.startPad();
  };
  screens.title.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', (e) => {
    if (game.state === 'title' && e.code === 'Enter' && screens.title.hidden === false) begin(false);
  });

  function pause() {
    if (!(game.state === 'intro' || game.state === 'play')) return;
    game.paused = true;
    game.audio.ctx?.suspend();
    show('pause');
    game.input.exitLock();
  }
  function resume() {
    game.paused = false;
    game.audio.ctx?.resume();
    show(null);
    game.input.requestLock();
    last = performance.now();
  }
  game.input.onLockChange = (locked) => {
    if (!locked && !game.paused && (game.state === 'intro' || game.state === 'play')) pause();
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !game.input.locked) {
      if (game.paused) resume();
      else pause();
    }
    if (e.code === 'KeyP') {
      if (game.paused) resume();
      else pause();
    }
  });
  canvas.addEventListener('click', () => {
    if ((game.state === 'intro' || game.state === 'play') && !game.input.locked && !game.paused) game.input.requestLock();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  $('resume').addEventListener('click', resume);
  $('restart').addEventListener('click', () => {
    game.paused = false;
    game.audio.ctx?.resume();
    begin(true);
  });
  $('quit').addEventListener('click', () => {
    game.paused = false;
    game.audio.ctx?.resume();
    game.audio.silenceSuit();
    game.toTitle();
  });
  $('sens').addEventListener('input', (e) => (game.input.sensitivity = +e.target.value));
  $('vol').addEventListener('input', (e) => game.audio.setVolume(+e.target.value));
  $('invert').addEventListener('change', (e) => (game.input.invertY = e.target.checked));
  $('quality').addEventListener('change', (e) => game.setQuality(+e.target.value));
  $('music').addEventListener('change', (e) => {
    game._musicOn = e.target.checked;
    game.audio.musicLevel = e.target.checked ? 1 : 0;
  });
  $('again').addEventListener('click', () => begin(true));
  $('to-title').addEventListener('click', () => game.toTitle());

  function showEnd(stats) {
    const e = ENDINGS[stats.kind] || ENDINGS.o2;
    $('e-kicker').textContent = stats.kind === 'won' ? `Inside · ${fmt(stats.time)} after the strike` : `Signal lost · ${fmt(stats.time)} after the strike`;
    $('e-title').textContent = e.title;
    $('e-body').textContent = e.body;
    $('e-stats').innerHTML = `
      <dt>Time</dt><dd>${fmt(stats.time)}</dd>
      <dt>O₂ left</dt><dd>${Math.round(stats.o2 * 100)}%</dd>
      <dt>Δv used</dt><dd>${stats.dvUsed.toFixed(1)} m/s</dd>
      <dt>Debris hits</dt><dd>${stats.hits}</dd>`;
    if (game.input.touchUI) game.input.touchUI.hidden = true;
    show('end');
  }

  // Auto-reduce quality on slow machines.
  let slowFrames = 0;
  let checked = false;

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    game.update(dt);
    game.render();
    if (!checked && game.state !== 'loading') {
      if (dt > 1 / 28) slowFrames++;
      else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 90) {
        checked = true;
        if (game.quality > 0.75) {
          game.setQuality(0.75);
          $('quality').value = '0.75';
        }
      }
    }
  }
  game.toTitle();
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  setLoading(0, `Something went wrong: ${e.message}`);
});
