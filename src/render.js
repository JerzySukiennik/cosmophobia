import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------------------
// Two scenes share one view: the far scene (Earth, atmosphere, stars; km)
// and the near scene (station, bodies, particles; m). Then HDR bloom, the
// helmet visor, and filmic tone mapping.
// ---------------------------------------------------------------------------

class WorldPass extends Pass {
  constructor(far, farCam, near, nearCam) {
    super();
    this.far = far;
    this.farCam = farCam;
    this.near = near;
    this.nearCam = nearCam;
    this.needsSwap = false;
  }
  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(this.far, this.farCam);
    renderer.clearDepth();
    renderer.render(this.near, this.nearCam);
  }
}

const VisorShader = {
  uniforms: {
    tDiffuse: { value: null },
    tFog: { value: null },
    tCrack: { value: null },
    uAspect: { value: 1 },
    uTime: { value: 0 },
    uFog: { value: 0 },
    uBreath: { value: 0 },
    uHypoxia: { value: 0 },
    uCrack: { value: 0 },
    uFlash: { value: 0 },
    uRed: { value: 0 },
    uGold: { value: 0 },
    uFade: { value: 0 },
    uSun: { value: new THREE.Vector3(0.5, 0.5, 0) },
    uRim: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tFog;
    uniform sampler2D tCrack;
    uniform float uAspect, uTime, uFog, uBreath, uHypoxia, uCrack, uFlash, uRed, uGold, uFade, uRim;
    uniform vec3 uSun;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    vec3 ghost(vec2 uv, vec2 at, float r, vec3 tint) {
      vec2 d = (uv - at) * vec2(uAspect, 1.0);
      float k = length(d) / r;
      return tint * (smoothstep(1.0, 0.7, k) * 0.6 + smoothstep(1.05, 0.95, k) * smoothstep(0.85, 0.95, k) * 0.8);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);

      // shattered visor: refraction around the cracks
      vec4 cr = texture2D(tCrack, uv);
      float crackA = cr.a * uCrack;
      vec2 cell = floor(uv * vec2(uAspect, 1.0) * 70.0);
      uv += (vec2(hash12(cell), hash12(cell + 17.0)) - 0.5) * 0.012 * crackA;

      // lateral chromatic aberration of the curved visor
      vec2 d = uv - 0.5;
      float ca = 0.006 * dot(d, d) + uHypoxia * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + d * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - d * ca).b;

      // condensation from your own breath, thickest near the mouth
      float blot = texture2D(tFog, uv * vec2(uAspect, 1.0) * 0.7).r;
      float mouth = smoothstep(0.62, 0.0, length((uv - vec2(0.5, -0.05)) * vec2(uAspect * 0.8, 1.25)));
      float edge = smoothstep(0.45, 0.95, length(c * vec2(0.9, 1.15)));
      float fog = clamp((uFog * 0.7 + uBreath) * (mouth * 0.9 + edge * 0.35) * (0.35 + blot * 1.1), 0.0, 0.92);
      if (fog > 0.01) {
        vec3 blur = vec3(0.0);
        for (int i = 0; i < 10; i++) {
          float a = float(i) * 0.6283 + blot * 3.0;
          blur += texture2D(tDiffuse, uv + vec2(cos(a), sin(a)) * (0.004 + 0.02 * fog)).rgb;
        }
        blur /= 10.0;
        float lum = dot(blur, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, blur * 0.75 + lum * 0.25 + 0.004, fog);
      }

      // sun glare: internal reflections in the visor, plus a starburst
      if (uSun.z > 0.0) {
        vec2 s = uSun.xy;
        vec2 axis = s - 0.5;
        vec3 g = vec3(0.0);
        g += ghost(uv, 0.5 - axis * 0.35, 0.05, vec3(0.10, 0.18, 0.09));
        g += ghost(uv, 0.5 - axis * 0.7, 0.11, vec3(0.04, 0.05, 0.13));
        g += ghost(uv, 0.5 - axis * 1.1, 0.03, vec3(0.18, 0.09, 0.05));
        g += ghost(uv, 0.5 + axis * 0.45, 0.07, vec3(0.03, 0.09, 0.11));
        vec2 sd = (uv - s) * vec2(uAspect, 1.0);
        float ang = atan(sd.y, sd.x);
        float rad = length(sd);
        float burst = pow(abs(cos(ang * 3.0 + 0.3)), 180.0) + pow(abs(cos(ang * 7.0)), 300.0) * 0.4;
        float glow = exp(-rad * 12.0) * 2.0 + burst * exp(-rad * 9.0) * 1.2;
        col += (g + glow * vec3(1.0, 0.93, 0.82)) * uSun.z;
      }

      // crack lines catch the light
      float lum0 = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += vec3(0.85, 0.92, 1.0) * crackA * (0.02 + lum0 * 0.6 + uSun.z * 0.4);

      // hypoxia: the world drains of colour and narrows to a tunnel
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(lum) * vec3(1.0, 0.95, 0.9), uHypoxia * 0.85);
      float tunnel = smoothstep(0.95 - uHypoxia * 0.75, 0.15 - uHypoxia * 0.1, length(c));
      col *= mix(1.0, tunnel, clamp(uHypoxia * 1.4, 0.0, 1.0));

      // the helmet itself: the visor's edge closing in on your view
      float rim = smoothstep(1.12, 0.68, length(c * vec2(0.84, 1.1)));
      col *= mix(1.0, mix(0.03, 1.0, rim), uRim);

      // gold sun visor lowered
      col *= mix(vec3(1.0), vec3(0.95, 0.6, 0.18) * 0.42, uGold);

      col = mix(col, vec3(2.2, 2.1, 2.0), uFlash);
      col += vec3(0.25, 0.0, 0.0) * uRed * (1.0 - rim * 0.6);

      // film grain
      float n = hash12(vUv * vec2(1920.0, 1080.0) + fract(uTime * 13.37) * 400.0) - 0.5;
      col *= 1.0 + n * (0.06 + uHypoxia * 0.1);

      col *= 1.0 - uFade;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

function makeFogTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, S, S);
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 2 + Math.random() * 16;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.08 + Math.random() * 0.25;
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      c.save();
      c.translate(ox, oy);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Visor crack canvas, re-drawn each time something hits you.
export class VisorCracks {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 576;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.count = 0;
  }
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    this.count = 0;
  }
  add(severity = 1) {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // impacts land away from the centre, often low (you tuck your chin)
    // away from the centre of view: low, or out toward the edges
    const side = Math.random() < 0.5 ? -1 : 1;
    const cx = W * (0.5 + side * (0.16 + Math.random() * 0.24));
    const cy = H * (0.18 + Math.random() * 0.5);
    c.lineCap = 'round';
    const branch = (x, y, ang, len, w, depth) => {
      const steps = 6 + Math.floor(Math.random() * 7);
      for (let i = 0; i < steps; i++) {
        ang += (Math.random() - 0.5) * 0.6;
        const nx = x + Math.cos(ang) * (len / steps);
        const ny = y + Math.sin(ang) * (len / steps);
        c.strokeStyle = `rgba(255,255,255,${0.55 + Math.random() * 0.45})`;
        c.lineWidth = Math.max(0.6, w * (1 - i / steps));
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(nx, ny);
        c.stroke();
        if (depth > 0 && Math.random() < 0.25) branch(nx, ny, ang + (Math.random() - 0.5) * 2, len * 0.45, w * 0.6, depth - 1);
        x = nx;
        y = ny;
      }
    };
    const n = 7 + Math.floor(severity * 6);
    for (let i = 0; i < n; i++) branch(cx, cy, (i / n) * Math.PI * 2 + Math.random() * 0.5, 80 + Math.random() * 260 * severity, 2.4, 2);
    for (let r = 8; r < 40 * severity; r += 7 + Math.random() * 8) {
      c.strokeStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.3})`;
      c.lineWidth = 1;
      c.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.35) {
        const rr = r + (Math.random() - 0.5) * 5;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (a === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, 26);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(cx - 30, cy - 30, 60, 60);
    this.texture.needsUpdate = true;
    this.count++;
  }
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const farScene = new THREE.Scene();
  const nearScene = new THREE.Scene();
  const nearCam = new THREE.PerspectiveCamera(66, 1, 0.04, 4000);
  const farCam = new THREE.PerspectiveCamera(66, 1, 1, 1e7);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  const world = new WorldPass(farScene, farCam, nearScene, nearCam);
  composer.addPass(world);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.6, 1.0);
  composer.addPass(bloom);
  const visor = new ShaderPass(VisorShader);
  visor.uniforms.tFog.value = makeFogTexture();
  const cracks = new VisorCracks();
  visor.uniforms.tCrack.value = cracks.texture;
  composer.addPass(visor);
  composer.addPass(new OutputPass());

  let pixelRatio = 1;
  function setSize(w, h, quality = 1) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    pixelRatio = Math.max(0.5, Math.min(dpr, quality >= 1 ? 1.5 : quality >= 0.75 ? 1.0 : 0.75));
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    nearCam.aspect = farCam.aspect = w / h;
    nearCam.updateProjectionMatrix();
    farCam.updateProjectionMatrix();
    visor.uniforms.uAspect.value = w / h;
  }

  function render() {
    farCam.quaternion.copy(nearCam.quaternion);
    farCam.position.set(0, 0, 0);
    farCam.fov = nearCam.fov;
    farCam.updateProjectionMatrix();
    farCam.updateMatrixWorld();
    composer.render();
  }

  return {
    renderer,
    composer,
    farScene,
    nearScene,
    nearCam,
    farCam,
    bloom,
    visor,
    cracks,
    setSize,
    render,
    get pixelRatio() {
      return pixelRatio;
    },
  };
}
