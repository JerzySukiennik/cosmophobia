import * as THREE from 'three';
import starsDataUrl from '../assets/stars.bin?inline';

// ---------------------------------------------------------------------------
// The real night sky: 28,495 stars from the HYG catalogue (to magnitude 7.6),
// coloured from their B-V index, plus a Milky Way laid along the true galactic
// plane with the Great Rift's dust lanes. Stars do not twinkle up here.
// Sky objects live in the Earth-fixed frame (sidereal time 0 at Greenwich) and
// are rotated into the station frame each frame.
// ---------------------------------------------------------------------------

function decodeStars() {
  const b64 = starsDataUrl.slice(starsDataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const count = bytes.length / 8;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const mag = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const o = i * 8;
    // equatorial unit vector -> Earth-fixed frame (x, z_eq, -y_eq)
    const x = view.getInt16(o, true) / 32767;
    const y = view.getInt16(o + 2, true) / 32767;
    const z = view.getInt16(o + 4, true) / 32767;
    const m = view.getUint8(o + 6) / 25 - 1.5;
    const bv = view.getUint8(o + 7) / 100 - 0.4;
    pos[i * 3] = x;
    pos[i * 3 + 1] = z;
    pos[i * 3 + 2] = -y;
    mag[i] = m;
    bvToColor(bv, c);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  return { pos, col, mag, count };
}

// B-V colour index -> blackbody temperature (Ballesteros) -> linear RGB.
function bvToColor(bv, out) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = t / 100;
  let r, g, b;
  if (k <= 66) {
    r = 255;
    g = 99.47 * Math.log(k) - 161.12;
    b = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(k - 60, -0.1332);
    g = 288.12 * Math.pow(k - 60, -0.0755);
    b = 255;
  }
  out.setRGB(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255,
    THREE.SRGBColorSpace,
  );
  // keep saturation gentle: the eye sees star colour only faintly
  const l = (out.r + out.g + out.b) / 3;
  out.r = THREE.MathUtils.lerp(l, out.r, 0.7);
  out.g = THREE.MathUtils.lerp(l, out.g, 0.7);
  out.b = THREE.MathUtils.lerp(l, out.b, 0.7);
  return out;
}

const starVert = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
uniform float uGain;
uniform float uPixelRatio;
uniform float uLimit;
varying vec3 vColor;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * 90000.0, 1.0);
  gl_Position = projectionMatrix * mv;
  float flux = pow(10.0, -0.4 * (aMag - 1.0));
  // perceptual size: bright stars bloom into slightly larger points
  float size = clamp(1.4 + 1.5 * log(1.0 + flux * 2.0), 1.4, 5.0);
  gl_PointSize = size * uPixelRatio;
  // magnitude limit rises as the eye dark-adapts
  float vis = smoothstep(uLimit + 0.4, uLimit - 0.6, aMag);
  // compressive response: faint stars stay visible next to Sirius
  vColor = aColor * pow(min(flux, 40.0), 0.55) * uGain;
  vFade = vis;
}
`;

const starFrag = /* glsl */ `
varying vec3 vColor;
varying float vFade;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float g = exp(-r2 * 4.5);
  if (g < 0.01) discard;
  gl_FragColor = vec4(vColor * g * vFade, 1.0);
}
`;

const mwVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position * 95000.0, 1.0);
}
`;

const mwFrag = /* glsl */ `
precision highp float;
uniform float uGain;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.07 + 3.1; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  // Earth-fixed -> equatorial
  vec3 eq = vec3(d.x, -d.z, d.y);
  // equatorial (J2000) -> galactic
  vec3 g = vec3(
    dot(vec3(-0.0548755604, -0.8734370902, -0.4838350155), eq),
    dot(vec3( 0.4941094279, -0.4448296300,  0.7469822445), eq),
    dot(vec3(-0.8676661490, -0.1980763734,  0.4559837762), eq));
  float b = asin(clamp(g.z, -1.0, 1.0));
  float l = atan(g.y, g.x);

  float centre = exp(-l * l / 0.9);
  float band = exp(-pow(b / (0.11 + 0.08 * centre), 2.0)) * (0.35 + 0.65 * centre);
  float bulge = exp(-(l * l * 1.6 + b * b * 9.0) / 0.18) * 0.9;
  float clumps = 0.55 + 0.9 * fbm(g * 9.0);
  float lanes = fbm(g * 16.0 + 4.0);
  float rift = exp(-pow((b - 0.03 * sin(l * 2.0) - 0.01) / (0.035 + 0.02 * centre), 2.0)) * smoothstep(1.4, 0.2, abs(l));
  float dust = 1.0 - 0.8 * clamp(rift * (0.6 + lanes) + (lanes - 0.45) * band * 0.8, 0.0, 1.0);
  float I = (band * clumps + bulge) * dust;
  vec3 col = mix(vec3(0.80, 0.86, 1.0), vec3(1.0, 0.86, 0.68), centre * 0.8 + bulge * 0.4);
  gl_FragColor = vec4(col * I * uGain, 1.0);
}
`;

export function createSky() {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;

  const data = decodeStars();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(data.col, 3));
  geo.setAttribute('aMag', new THREE.BufferAttribute(data.mag, 1));
  const starUniforms = {
    uGain: { value: 0 },
    uPixelRatio: { value: 1 },
    uLimit: { value: 6.5 },
  };
  const stars = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      vertexShader: starVert,
      fragmentShader: starFrag,
      uniforms: starUniforms,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  stars.frustumCulled = false;
  stars.renderOrder = 2;

  const mwUniforms = { uGain: { value: 0 } };
  const milkyWay = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 48),
    new THREE.ShaderMaterial({
      vertexShader: mwVert,
      fragmentShader: mwFrag,
      uniforms: mwUniforms,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  milkyWay.frustumCulled = false;
  milkyWay.renderOrder = 1;

  group.add(milkyWay, stars);

  // `adaptation` 0..1: how dark-adapted the eye is. In sunlight the glare of
  // the Earth and the station washes the stars out completely.
  function update(orbit, adaptation, pixelRatio) {
    group.matrix.copy(orbit.eciToLvlh);
    group.matrixWorldNeedsUpdate = true;
    const a = THREE.MathUtils.clamp(adaptation, 0, 1);
    starUniforms.uGain.value = 0.26 * a * a;
    starUniforms.uLimit.value = 2.0 + 5.4 * a;
    starUniforms.uPixelRatio.value = pixelRatio;
    mwUniforms.uGain.value = 0.014 * Math.pow(a, 3);
  }

  return { group, update, count: data.count };
}
