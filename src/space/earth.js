import * as THREE from 'three';
import { R_EARTH, R_ORBIT, ATMO } from './orbit.js';

// ---------------------------------------------------------------------------
// Earth + atmosphere, drawn as one full-screen pass per pixel:
//   * exact ray/sphere intersection (no tessellation at 400 km altitude)
//   * single-scattering Rayleigh + Mie with ozone absorption; sunlight optical
//     depth via the Chapman approximation, so sunsets, the Earth's shadow on
//     its own atmosphere and the blue limb all fall out of the physics
//   * ocean sun glint, cloud shadows, city lights, night-side lightning
//   * the green 557.7 nm airglow line and the auroral ovals
//   * the Sun's disc itself, reddened by the atmosphere near the limb
// Units: kilometres. The camera sits at the origin of the LVLH frame.
// ---------------------------------------------------------------------------

const vert = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec3 vRay;
void main() {
  vec4 p = uInvProj * vec4(position.xy, 1.0, 1.0);
  vRay = mat3(uCamWorld) * (p.xyz / p.w);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const frag = /* glsl */ `
precision highp float;

uniform mat3 uToEarth;
uniform vec3 uSunDir;
uniform float uSunE;
uniform float uTime;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uBRC;
uniform vec4 uBolts[6];
uniform vec3 uMagPole;
uniform float uDrawSun;
uniform float uCityLights;
uniform float uAurora;

varying vec3 vRay;

#define PI 3.14159265359
const float RP = ${R_EARTH.toFixed(1)};
const float RA = ${(R_EARTH + 100).toFixed(1)};
const float RC = ${R_ORBIT.toFixed(1)};
const vec3 BR = vec3(${ATMO.betaR.map((v) => v.toExponential(4)).join(',')});
const float HR = ${ATMO.HR.toFixed(2)};
const float BM = 3.996e-3;
const float BME = ${ATMO.betaMext.toExponential(4)};
const float HM = ${ATMO.HM.toFixed(2)};
const vec3 BO = vec3(${ATMO.betaO.map((v) => v.toExponential(4)).join(',')});
const float MIE_G = 0.76;
const float SUN_COS = 0.99998917; // angular radius 0.2666 deg

// ---------- noise ----------
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p, float octaves) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= octaves) break;
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

// ---------- geometry ----------
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Length of [0,tMax] that lies inside the spherical shell r1 < |p| < r2.
float shellPath(vec3 ro, vec3 rd, float r1, float r2, float tMax) {
  vec2 o = raySphere(ro, rd, r2);
  float outer = max(0.0, min(o.y, tMax) - max(o.x, 0.0));
  vec2 i = raySphere(ro, rd, r1);
  float inner = max(0.0, min(i.y, tMax) - max(i.x, 0.0));
  return max(outer - inner, 0.0);
}

float chapman(float X, float h, float mu) {
  float c = sqrt(X + h);
  if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h);
  float c0 = sqrt(x0);
  return min(2.0 * c0 * exp(min(X - x0, 60.0)) - c / (1.0 - c * mu) * exp(-h), 1e7);
}

vec3 sunTransmittance(float r, float mu) {
  float h = max(r - RP, 0.0);
  float dR = HR * chapman(RP / HR, h / HR, mu);
  float dM = HM * chapman(RP / HM, h / HM, mu);
  return exp(-(BR * dR + BME * dM + BO * dR * 1.875));
}

float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu) {
  float g = MIE_G, g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
         ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

// Single scattering along [t0, t1]. Returns in-scattered radiance; writes the
// view-path transmittance. 'dense' concentrates samples near the tangent point.
vec3 scatter(vec3 ro, vec3 rd, float t0, float t1, bool groundHit, out vec3 transmittance) {
  const int N = 18;
  float mu = dot(rd, uSunDir);
  float pR = phaseR(mu), pM = phaseM(mu);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  vec3 od = vec3(0.0);
  float tMid = clamp(-dot(ro, rd), t0, t1);
  float prevT = t0;
  for (int i = 0; i < N; i++) {
    float s = (float(i) + 1.0) / float(N);
    float t;
    if (groundHit) {
      // denser toward the ground where the air is thick
      t = t0 + (t1 - t0) * (1.0 - (1.0 - s) * (1.0 - s));
    } else {
      // symmetric, denser around the tangent point
      float k = s * 2.0 - 1.0;
      float w = sign(k) * k * k;
      t = w < 0.0 ? mix(tMid, t0, -w) : mix(tMid, t1, w);
      if (i == 0) prevT = t0;
    }
    float tm = 0.5 * (prevT + t);
    float ds = abs(t - prevT);
    prevT = t;
    vec3 p = ro + rd * tm;
    float r = length(p);
    float h = r - RP;
    float dR = exp(-h / HR) * ds;
    float dM = exp(-h / HM) * ds;
    od += vec3(dR, dM, 0.0);
    vec3 Tv = exp(-(BR * od.x + BME * od.y + BO * od.x * 1.875));
    vec3 Ts = sunTransmittance(r, dot(p, uSunDir) / r);
    vec3 tt = Tv * Ts;
    sumR += tt * dR;
    sumM += tt * dM;
  }
  transmittance = exp(-(BR * od.x + BME * od.y + BO * od.x * 1.875));
  return uSunE * (sumR * BR * pR + sumM * BM * pM);
}

vec2 earthUV(vec3 ne) {
  return vec2(atan(-ne.z, ne.x) / (2.0 * PI) + 0.5, asin(clamp(ne.y, -1.0, 1.0)) / PI + 0.5);
}

float ggx(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

vec3 aurora(vec3 ro, vec3 rd, float tMax) {
  if (uAurora < 0.01) return vec3(0.0);
  vec2 sh = raySphere(ro, rd, RP + 330.0);
  float t0 = max(sh.x, 0.0);
  float t1 = min(sh.y, tMax);
  if (t1 <= t0) return vec3(0.0);
  const int N = 20;
  float dt = (t1 - t0) / float(N);
  vec3 acc = vec3(0.0);
  float jitter = hash13(vec3(gl_FragCoord.xy, fract(uTime) * 91.0));
  vec3 ax = normalize(cross(uMagPole, vec3(0.0, 0.0, 1.0)));
  vec3 ay = cross(uMagPole, ax);
  for (int i = 0; i < N; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 q = ro + rd * t;
    float r = length(q);
    float alt = r - RP;
    if (alt < 92.0 || alt > 330.0) continue;
    vec3 qe = uToEarth * (q / r);
    float sm = dot(qe, uMagPole);
    float mlat = asin(clamp(abs(sm), 0.0, 1.0));
    if (mlat < 0.98 || mlat > 1.32) continue;
    float mlon = atan(dot(qe, ay), dot(qe, ax));
    float ph = mlon + (sm < 0.0 ? 2.1 : 0.0);
    // substorm activity comes and goes along the oval
    float activity = smoothstep(0.42, 0.72, fbm(vec3(ph * 1.7, uTime * 0.006, 3.0), 3.0));
    if (activity <= 0.0) continue;
    float center = 1.15 + 0.035 * sin(ph * 3.0 + uTime * 0.04) + 0.025 * (fbm(vec3(ph * 6.0, uTime * 0.05, 1.0), 3.0) - 0.5);
    float sheet = exp(-pow((mlat - center) / 0.02, 2.0));
    float halo = exp(-pow((mlat - center) / 0.06, 2.0)) * 0.1;
    float rays = 0.3 + 0.7 * fbm(vec3(ph * 110.0, uTime * 0.3, alt * 0.004), 3.0);
    float green = smoothstep(92.0, 106.0, alt) * exp(-(alt - 104.0) / 32.0);
    float red = exp(-pow((alt - 230.0) / 50.0, 2.0)) * 0.07;
    vec3 col = vec3(0.16, 1.0, 0.42) * green + vec3(0.9, 0.15, 0.3) * red;
    acc += col * (sheet * rays + halo) * activity * dt;
  }
  return acc * 0.0016 * uAurora;
}

void main() {
  vec3 rd = normalize(vRay);
  vec3 ro = vec3(0.0, RC, 0.0); // camera relative to Earth centre

  vec2 hitP = raySphere(ro, rd, RP);
  bool ground = hitP.x > 0.0 && hitP.x < 1e8;

  // Surface point for texture derivatives in uniform control flow: exact hit,
  // or the closest point on the sphere for rays that miss.
  vec3 closest = ro + rd * max(-dot(ro, rd), 0.0);
  vec3 surf = ground ? ro + rd * hitP.x : normalize(closest) * RP;
  vec3 ne = uToEarth * normalize(surf);
  vec2 uv = earthUV(ne);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= floor(dx.x + 0.5);
  dy.x -= floor(dy.x + 0.5);
  float footprint = max(length(dx), length(dy)) * 2.0 * PI * RP; // km per pixel

  vec2 atm = raySphere(ro, rd, RA);
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  if (ground) {
    vec3 N = normalize(surf);
    vec3 L = uSunDir;
    vec3 V = -rd;
    float NdotL = dot(N, L);
    vec3 sunE = uToEarth * L;

    vec4 brc = textureGrad(uBRC, uv, dx, dy);
    vec3 albedo = textureGrad(uDay, uv, dx, dy).rgb;
    float rough = brc.g;
    float ocean = 1.0 - smoothstep(0.08, 0.2, rough);

    // Fine detail the 4k maps cannot carry when you look straight down.
    vec3 pk = ne * RP;
    float detailFade = 1.0 - smoothstep(1.5, 6.0, footprint);
    float dn = fbm(pk * 0.08, 4.0);
    albedo *= mix(1.0, 0.82 + 0.36 * dn, detailFade * (1.0 - ocean * 0.7));

    float cloud = smoothstep(0.12, 0.85, brc.b);
    float cd = fbm(pk * 0.045 + vec3(uTime * 0.002, 0.0, 0.0), 5.0);
    cloud = clamp(cloud + (cd - 0.5) * 0.9 * detailFade * cloud * (1.0 - cloud) * 4.0, 0.0, 1.0);
    cloud = mix(cloud, cloud * cloud * (3.0 - 2.0 * cloud), 0.5);

    // Cloud shadow cast along the sunlight direction (~6 km cloud tops).
    vec3 tang = sunE - ne * dot(ne, sunE);
    vec3 neS = normalize(ne + tang * (6.0 / RP) / max(dot(ne, sunE), 0.08));
    float shadowCloud = smoothstep(0.15, 0.85, texture(uBRC, earthUV(neS)).b);

    vec3 Ts = sunTransmittance(RP + 0.5, NdotL);
    vec3 E = uSunE * Ts * max(NdotL, 0.0);

    vec3 groundCol = albedo * E / PI * (1.0 - 0.75 * shadowCloud);
    // Sun glint on water.
    vec3 H = normalize(L + V);
    float NdotV = max(dot(N, V), 1e-3);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    float spec = ggx(max(dot(N, H), 0.0), 0.16) * fres / (4.0 * NdotV);
    groundCol += ocean * spec * E * (1.0 - shadowCloud);

    // Clouds: bright, softly wrapped around the terminator.
    float wrap = clamp((NdotL + 0.08) / 1.08, 0.0, 1.0);
    vec3 cloudCol = vec3(0.92) * uSunE * sunTransmittance(RP + 6.0, NdotL) * wrap / PI;

    vec3 surfaceCol = mix(groundCol, cloudCol, cloud);

    // City lights on the night side, dimmed by cloud.
    float night = smoothstep(0.06, -0.14, NdotL);
    vec3 lights = textureGrad(uNight, uv, dx, dy).rgb;
    lights = pow(lights, vec3(1.7)) * vec3(1.0, 0.72, 0.42);
    surfaceCol += lights * night * (1.0 - 0.85 * cloud) * 0.09 * uCityLights;

    // Lightning inside the cloud decks.
    for (int i = 0; i < 6; i++) {
      vec4 b = uBolts[i];
      if (b.w <= 0.0) continue;
      float dkm = length(ne - b.xyz) * RP;
      float g = exp(-dkm * dkm / 900.0) * b.w;
      surfaceCol += vec3(0.75, 0.82, 1.0) * g * (0.25 + cloud) * 0.25;
    }

    vec3 Tv;
    vec3 ins = scatter(ro, rd, max(atm.x, 0.0), hitP.x, true, Tv);
    color = surfaceCol * Tv + ins;

    // airglow & aurora seen against the dark planet
    float agl = shellPath(ro, rd, RP + 86.0, RP + 102.0, hitP.x);
    color += vec3(0.42, 1.0, 0.36) * agl * 0.000022;
    color += aurora(ro, rd, hitP.x);
    alpha = 1.0;
  } else {
    vec3 Tv = vec3(1.0);
    if (atm.y > 0.0) {
      color = scatter(ro, rd, max(atm.x, 0.0), atm.y, false, Tv);
    }
    float agl = shellPath(ro, rd, RP + 86.0, RP + 102.0, 1e9);
    color += vec3(0.42, 1.0, 0.36) * agl * 0.000022;
    float red = shellPath(ro, rd, RP + 150.0, RP + 290.0, 1e9);
    color += vec3(0.9, 0.18, 0.12) * red * 0.0000012;
    color += aurora(ro, rd, 1e9);

    // The Sun's disc with limb darkening, reddened by the atmosphere.
    float cs = dot(rd, uSunDir);
    if (uDrawSun > 0.5 && cs > SUN_COS - 2e-5) {
      float rr = clamp((1.0 - cs) / (1.0 - SUN_COS), 0.0, 1.0);
      float limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - rr));
      float edge = 1.0 - smoothstep(0.85, 1.05, rr);
      color += vec3(1.0, 0.97, 0.92) * 1800.0 * limb * edge * Tv;
    }
    alpha = 1.0 - clamp(dot(Tv, vec3(0.3333)), 0.0, 1.0);
  }

  gl_FragColor = vec4(color, alpha);
}
`;

export function createEarth(textures) {
  const uniforms = {
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uToEarth: { value: new THREE.Matrix3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunE: { value: 6.0 },
    uTime: { value: 0 },
    uDay: { value: textures.day },
    uNight: { value: textures.night },
    uBRC: { value: textures.brc },
    uBolts: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uMagPole: { value: new THREE.Vector3(0, 1, 0) },
    uDrawSun: { value: 1 },
    uCityLights: { value: 1 },
    uAurora: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  // Rays are rebuilt for whatever camera draws us (main view or env cube face).
  mesh.onBeforeRender = (renderer, scene, camera) => {
    uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    uniforms.uCamWorld.value.copy(camera.matrixWorld);
    material.uniformsNeedUpdate = true;
  };

  // --- lightning scheduler ------------------------------------------------
  const bolts = [];
  let nextBolt = 1;
  const tmp = new THREE.Vector3();

  function update(dt, time, orbit) {
    uniforms.uTime.value = time;
    uniforms.uToEarth.value.copy(orbit.toEarth);
    uniforms.uSunDir.value.copy(orbit.sunDir);
    uniforms.uMagPole.value.copy(orbit.magPoleE);
    // Aurora is invisible against a sunlit sky; skip its raymarch in daylight.
    uniforms.uAurora.value = 1 - THREE.MathUtils.smoothstep(orbit.sunVisible, 0.3, 0.9);

    // Storms flicker somewhere in the visible disc, mostly on the night side.
    nextBolt -= dt;
    if (nextBolt <= 0) {
      nextBolt = 0.15 + Math.random() * (orbit.sunVisible > 0.5 ? 3.0 : 0.9);
      // random point within ~1800 km of the nadir, biased forward & sideways
      const ang = Math.random() * Math.PI * 2;
      const dist = (0.04 + Math.random() * 0.26);
      tmp.set(Math.cos(ang) * dist, 1, Math.sin(ang) * dist).normalize();
      const ne = tmp.clone().applyMatrix3(orbit.toEarth);
      const n = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        bolts.push({
          dir: ne.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.004, (Math.random() - 0.5) * 0.004, (Math.random() - 0.5) * 0.004)).normalize(),
          t: -k * (0.08 + Math.random() * 0.2),
          life: 0.12 + Math.random() * 0.25,
          peak: 0.5 + Math.random() * 1.5,
        });
      }
    }
    for (let i = bolts.length - 1; i >= 0; i--) {
      bolts[i].t += dt;
      if (bolts[i].t > bolts[i].life) bolts.splice(i, 1);
    }
    for (let i = 0; i < 6; i++) {
      const u = uniforms.uBolts.value[i];
      const b = bolts[i];
      if (!b || b.t < 0) {
        u.w = 0;
        continue;
      }
      const f = b.t / b.life;
      const flick = 0.55 + 0.45 * Math.sin(b.t * 90.0 + i);
      u.set(b.dir.x, b.dir.y, b.dir.z, b.peak * (1 - f) * flick);
    }
  }

  return { mesh, uniforms, update };
}
