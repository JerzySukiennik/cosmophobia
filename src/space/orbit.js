import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Orbit & illumination model.
//
// Frames
//   E    Earth-fixed. X = (lat 0, lon 0), Y = north pole, Z = (lat 0, lon 90°W).
//        (Matches the equirectangular texture layout used by the Earth shader.)
//   LVLH Station frame, in which the whole near scene lives.
//        X = direction of flight (ram), Y = zenith (away from Earth), Z = X × Y.
//
// The orbit is ISS-like: 408 km, 51.64° inclination. Time runs faster than
// real life (TIME_SCALE) so one play session sees a sunset and a full night.
// ---------------------------------------------------------------------------

export const R_EARTH = 6371; // km
export const ALTITUDE = 408; // km
export const R_ORBIT = R_EARTH + ALTITUDE;
export const ORBIT_SPEED = 7.66; // km/s, real
export const PERIOD_REAL = 92.68 * 60; // s
export const TIME_SCALE = 6;

const DEG = Math.PI / 180;
const INCLINATION = 51.64 * DEG;
const RAAN = -165 * DEG; // ascending node over the central Pacific
const BETA = 24 * DEG; // sun elevation above the orbit plane
const SUN_PHASE = -52.2 * DEG; // chosen so sunset falls over the western US

// Rayleigh / Mie / ozone coefficients (per km), shared with the Earth shader.
export const ATMO = {
  betaR: [5.802e-3, 13.558e-3, 33.1e-3],
  HR: 8.0,
  betaMext: 4.4e-3,
  HM: 1.2,
  betaO: [0.65e-3, 1.881e-3, 0.085e-3],
};

export function latLonToE(lat, lon, out = new THREE.Vector3()) {
  const c = Math.cos(lat);
  return out.set(c * Math.cos(lon), Math.sin(lat), -c * Math.sin(lon));
}

// Schüler's approximation of the Chapman grazing-incidence function.
// X = planet radius / H, h = altitude / H, mu = cos(zenith angle).
export function chapman(X, h, mu) {
  const c = Math.sqrt(X + h);
  if (mu >= 0) return (c / (c * mu + 1)) * Math.exp(-h);
  const x0 = Math.sqrt(1 - mu * mu) * (X + h);
  const c0 = Math.sqrt(x0);
  return 2 * c0 * Math.exp(X - x0) - (c / (1 - c * mu)) * Math.exp(-h);
}

// Transmittance of sunlight reaching a point at `altitudeKm` whose zenith makes
// angle acos(mu) with the sun. Returns RGB in `out`.
export function sunTransmittance(altitudeKm, mu, out) {
  const chR = Math.min(chapman(R_EARTH / ATMO.HR, altitudeKm / ATMO.HR, mu), 1e7);
  const chM = Math.min(chapman(R_EARTH / ATMO.HM, altitudeKm / ATMO.HM, mu), 1e7);
  const dR = ATMO.HR * chR;
  const dM = ATMO.HM * chM;
  const r = Math.exp(-(ATMO.betaR[0] * dR + ATMO.betaMext * dM + ATMO.betaO[0] * dR * 1.875));
  const g = Math.exp(-(ATMO.betaR[1] * dR + ATMO.betaMext * dM + ATMO.betaO[1] * dR * 1.875));
  const b = Math.exp(-(ATMO.betaR[2] * dR + ATMO.betaMext * dM + ATMO.betaO[2] * dR * 1.875));
  return out.set(r, g, b);
}

export class Orbit {
  constructor() {
    this.a = latLonToE(0, RAAN);
    this.b = latLonToE(INCLINATION, RAAN + 90 * DEG);
    this.h = new THREE.Vector3().crossVectors(this.a, this.b).normalize();

    this.sunE = new THREE.Vector3()
      .addScaledVector(this.a, Math.cos(BETA) * Math.cos(SUN_PHASE))
      .addScaledVector(this.b, Math.cos(BETA) * Math.sin(SUN_PHASE))
      .addScaledVector(this.h, Math.sin(BETA))
      .normalize();

    // Geomagnetic north pole (80.7°N, 72.7°W) drives the auroral ovals.
    this.magPoleE = latLonToE(80.7 * DEG, -72.7 * DEG);

    this.meanMotion = (2 * Math.PI) / PERIOD_REAL; // rad/s real
    this.u = 0; // argument of latitude

    // Outputs, refreshed by update()
    this.X = new THREE.Vector3(); // LVLH axes expressed in E
    this.Y = new THREE.Vector3();
    this.Z = new THREE.Vector3();
    this.toEarth = new THREE.Matrix3(); // LVLH -> E
    this.eciToLvlh = new THREE.Matrix4(); // E -> LVLH (rotation only)
    this.sunDir = new THREE.Vector3(); // LVLH
    this.sunColor = new THREE.Color(1, 1, 1); // atmospheric transmittance
    this.sunVisible = 1; // 0..1, luminance of transmitted sunlight
    this.dayFactor = 1; // how much of the Earth below is sunlit (for earthshine)
    this.latitude = 0;
    this.longitude = 0;
    this._t = new THREE.Vector3();
  }

  // Place the station at a given argument of latitude (degrees).
  setPhase(uDeg) {
    this.u = uDeg * DEG;
    this.update(0);
  }

  // Seconds of game time until the station enters Earth's shadow (approx.).
  secondsToSunset() {
    const rate = this.meanMotion * TIME_SCALE;
    const sunsetU = SUN_PHASE + 112.2 * DEG;
    let d = sunsetU - this.u;
    while (d < 0) d += Math.PI * 2;
    return d / rate;
  }

  secondsToSunrise() {
    const rate = this.meanMotion * TIME_SCALE;
    const sunriseU = SUN_PHASE + 247.8 * DEG;
    let d = sunriseU - this.u;
    while (d < 0) d += Math.PI * 2;
    while (d > Math.PI * 2) d -= Math.PI * 2;
    return d / rate;
  }

  update(dt) {
    this.u += this.meanMotion * TIME_SCALE * dt;
    const cu = Math.cos(this.u);
    const su = Math.sin(this.u);
    const p = this.Y.set(0, 0, 0).addScaledVector(this.a, cu).addScaledVector(this.b, su);
    const v = this.X.set(0, 0, 0).addScaledVector(this.a, -su).addScaledVector(this.b, cu);
    this.Z.crossVectors(v, p);

    this.toEarth.set(
      this.X.x, this.Y.x, this.Z.x,
      this.X.y, this.Y.y, this.Z.y,
      this.X.z, this.Y.z, this.Z.z,
    );
    this.eciToLvlh.set(
      this.X.x, this.X.y, this.X.z, 0,
      this.Y.x, this.Y.y, this.Y.z, 0,
      this.Z.x, this.Z.y, this.Z.z, 0,
      0, 0, 0, 1,
    );

    this.sunDir.set(this.sunE.dot(this.X), this.sunE.dot(this.Y), this.sunE.dot(this.Z)).normalize();

    const mu = this.sunDir.y;
    sunTransmittance(ALTITUDE, mu, this._t);
    this.sunColor.setRGB(this._t.x, this._t.y, this._t.z);
    this.sunVisible = Math.min(1, 0.2126 * this._t.x + 0.7152 * this._t.y + 0.0722 * this._t.z);

    // Lit fraction of the visible Earth disk, soft around the terminator.
    this.dayFactor = THREE.MathUtils.clamp(0.5 + 0.62 * mu, 0, 1);

    this.latitude = Math.asin(THREE.MathUtils.clamp(p.y, -1, 1));
    this.longitude = Math.atan2(-p.z, p.x);
  }
}
