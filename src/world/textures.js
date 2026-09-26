import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural surface textures for the station, painted on canvases at load:
// beta-cloth micrometeoroid blankets, crinkled Kapton foil, solar cells,
// radiator panels and stencilled markings.
// ---------------------------------------------------------------------------

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Seeded PRNG so the station looks identical every run.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Height canvas -> tangent-space normal map.
function normalFromHeight(src, strength = 2) {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext('2d');
  const hd = sctx.getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const H = (x, y) => hd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function tex(c, { srgb = true, repeat = [1, 1], aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

function speckle(ctx, w, h, n, r, alpha, rand, color = '0,0,0') {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = `rgba(${color},${alpha * rand()})`;
    ctx.beginPath();
    ctx.arc(rand() * w, rand() * h, r * (0.3 + rand()), 0, Math.PI * 2);
    ctx.fill();
  }
}

// White beta-cloth MMOD blankets: quilted panels, seams, velcro, grime.
export function makeBlanket(seed = 1) {
  const rand = rng(seed);
  const S = 512;
  const col = canvas(S, S);
  const hgt = canvas(S, S);
  const c = col.getContext('2d');
  const h = hgt.getContext('2d');
  c.fillStyle = '#dcd8cc';
  c.fillRect(0, 0, S, S);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, S, S);

  // Weave noise
  const img = c.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n * 0.9;
  }
  c.putImageData(img, 0, 0);

  // Panels (4x2 per tile) with puffy centres and stitched seams.
  const cols = 4;
  const rows = 2;
  const pw = S / cols;
  const ph = S / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const gx = x * pw + pw / 2;
      const gy = y * ph + ph / 2;
      const g = h.createRadialGradient(gx, gy, 5, gx, gy, pw * 0.75);
      g.addColorStop(0, '#9a9a9a');
      g.addColorStop(1, '#707070');
      h.fillStyle = g;
      h.fillRect(x * pw, y * ph, pw, ph);
      // subtle tone variation per panel
      c.fillStyle = `rgba(${rand() < 0.5 ? '255,250,235' : '120,115,100'},${0.04 + rand() * 0.06})`;
      c.fillRect(x * pw, y * ph, pw, ph);
    }
  }
  // quilting stitches
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      for (let k = 0; k < 3; k++) {
        const sx = x * pw + pw * (0.25 + k * 0.25);
        for (let j = 0; j < 3; j++) {
          const sy = y * ph + ph * (0.25 + j * 0.25);
          h.fillStyle = '#5a5a5a';
          h.beginPath();
          h.arc(sx, sy, 3, 0, Math.PI * 2);
          h.fill();
          c.fillStyle = 'rgba(90,85,75,0.35)';
          c.beginPath();
          c.arc(sx, sy, 1.6, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
  }
  // seams
  c.strokeStyle = 'rgba(70,66,58,0.55)';
  h.strokeStyle = '#3a3a3a';
  c.lineWidth = 2;
  h.lineWidth = 4;
  for (let x = 0; x <= cols; x++) {
    c.beginPath(); c.moveTo(x * pw, 0); c.lineTo(x * pw, S); c.stroke();
    h.beginPath(); h.moveTo(x * pw, 0); h.lineTo(x * pw, S); h.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    c.beginPath(); c.moveTo(0, y * ph); c.lineTo(S, y * ph); c.stroke();
    h.beginPath(); h.moveTo(0, y * ph); h.lineTo(S, y * ph); h.stroke();
  }
  // velcro patches and tie-downs
  for (let i = 0; i < 6; i++) {
    const x = rand() * S;
    const y = rand() * S;
    c.fillStyle = 'rgba(200,196,185,1)';
    c.fillRect(x, y, 14, 30);
    c.strokeStyle = 'rgba(90,85,75,0.5)';
    c.strokeRect(x, y, 14, 30);
  }
  // grime from years of atomic oxygen and thruster plumes
  speckle(c, S, S, 260, 6, 0.05, rand, '80,70,50');
  const grime = c.createLinearGradient(0, 0, 0, S);
  grime.addColorStop(0, 'rgba(120,100,70,0.06)');
  grime.addColorStop(0.5, 'rgba(0,0,0,0)');
  grime.addColorStop(1, 'rgba(120,100,70,0.08)');
  c.fillStyle = grime;
  c.fillRect(0, 0, S, S);

  return {
    map: tex(col),
    normalMap: tex(normalFromHeight(hgt, 3), { srgb: false }),
  };
}

// Crinkled multi-layer insulation (gold Kapton or silver).
export function makeFoil(seed = 2, gold = true) {
  const rand = rng(seed);
  const S = 512;
  const hgt = canvas(S, S);
  const h = hgt.getContext('2d');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, S, S);
  // crinkles: many random facets
  for (let i = 0; i < 900; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = 8 + rand() * 40;
    const a = rand() * Math.PI;
    const v = Math.floor(90 + rand() * 90);
    h.fillStyle = `rgba(${v},${v},${v},0.35)`;
    h.beginPath();
    h.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    h.lineTo(x + Math.cos(a + 2.1) * r * 0.6, y + Math.sin(a + 2.1) * r * 0.6);
    h.lineTo(x + Math.cos(a + 4.0) * r * 0.8, y + Math.sin(a + 4.0) * r * 0.8);
    h.closePath();
    h.fill();
  }
  const col = canvas(64, 64);
  const c = col.getContext('2d');
  c.fillStyle = gold ? '#c99a45' : '#b8bcc2';
  c.fillRect(0, 0, 64, 64);
  const rough = canvas(128, 128);
  const r = rough.getContext('2d');
  r.fillStyle = '#5a5a5a';
  r.fillRect(0, 0, 128, 128);
  speckle(r, 128, 128, 200, 6, 0.4, rand, '160,160,160');
  return {
    map: tex(col),
    normalMap: tex(normalFromHeight(hgt, 5), { srgb: false }),
    roughnessMap: tex(rough, { srgb: false }),
  };
}

// Photovoltaic blanket: 8 x 32 cells per tile, silver interconnects.
export function makeSolar(seed = 3) {
  const rand = rng(seed);
  const W = 256;
  const H = 1024;
  const col = canvas(W, H);
  const c = col.getContext('2d');
  c.fillStyle = '#6d7078';
  c.fillRect(0, 0, W, H);
  const nx = 8;
  const ny = 32;
  const cw = W / nx;
  const ch = H / ny;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = rand();
      const r = 10 + v * 6;
      const g = 18 + v * 10;
      const b = 48 + v * 22;
      c.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
      c.fillRect(x * cw + 1.5, y * ch + 1.5, cw - 3, ch - 3);
      // fingers
      c.fillStyle = 'rgba(160,170,190,0.18)';
      for (let k = 1; k < 6; k++) c.fillRect(x * cw + 2, y * ch + (k * ch) / 6, cw - 4, 0.6);
    }
  }
  // copper bus every 8 rows
  c.fillStyle = '#9a6a3a';
  for (let y = 0; y <= ny; y += 8) c.fillRect(0, y * ch - 2, W, 4);

  const rough = canvas(W / 4, H / 4);
  const r = rough.getContext('2d');
  r.fillStyle = '#2e2e2e';
  r.fillRect(0, 0, W / 4, H / 4);
  r.fillStyle = '#9a9a9a';
  for (let x = 0; x <= nx; x++) r.fillRect((x * cw) / 4 - 0.5, 0, 1, H / 4);
  for (let y = 0; y <= ny; y++) r.fillRect(0, (y * ch) / 4 - 0.5, W / 4, 1);

  const back = canvas(64, 256);
  const bc = back.getContext('2d');
  bc.fillStyle = '#b9b4a6';
  bc.fillRect(0, 0, 64, 256);
  bc.fillStyle = 'rgba(80,70,50,0.25)';
  for (let y = 0; y < 256; y += 8) bc.fillRect(0, y, 64, 1);

  return {
    map: tex(col),
    roughnessMap: tex(rough, { srgb: false }),
    backMap: tex(back),
  };
}

export function makeRadiator(seed = 4) {
  const rand = rng(seed);
  const W = 256;
  const H = 256;
  const col = canvas(W, H);
  const c = col.getContext('2d');
  c.fillStyle = '#e4e2dc';
  c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(150,148,140,0.6)';
  for (let x = 8; x < W; x += 16) c.fillRect(x, 0, 2, H);
  c.fillStyle = 'rgba(120,118,110,0.8)';
  c.fillRect(0, 0, W, 4);
  c.fillRect(0, H - 4, W, 4);
  speckle(c, W, H, 80, 4, 0.08, rand, '90,80,60');
  return { map: tex(col) };
}

// Stencilled markings: text decals on transparent canvases.
export function makeDecal(lines, { w = 512, h = 128, color = '#1d2230', size = 64, font = '600 {s}px "Jost", "Futura", "Avenir Next", sans-serif', align = 'center', stripe = false } = {}) {
  const cv = canvas(w, h);
  const c = cv.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (stripe) {
    for (let x = -h; x < w; x += 40) {
      c.fillStyle = '#e8b21a';
      c.beginPath();
      c.moveTo(x, h);
      c.lineTo(x + 20, h);
      c.lineTo(x + 20 + h, 0);
      c.lineTo(x + h, 0);
      c.fill();
    }
  }
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((line, i) => {
    const s = i === 0 ? size : size * 0.55;
    c.font = font.replace('{s}', s);
    c.fillText(line, align === 'center' ? w / 2 : 10, (h / (n + 1)) * (i + 1));
  });
  const t = tex(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// The US flag, as flown on the station's modules.
export function makeFlag() {
  const cv = canvas(190, 100);
  const c = cv.getContext('2d');
  for (let i = 0; i < 13; i++) {
    c.fillStyle = i % 2 ? '#f2f0ea' : '#a3272f';
    c.fillRect(0, (i * 100) / 13, 190, 100 / 13 + 0.5);
  }
  c.fillStyle = '#26315e';
  c.fillRect(0, 0, 76, 54);
  c.fillStyle = '#f2f0ea';
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < (y % 2 ? 5 : 6); x++) {
      c.beginPath();
      c.arc(6 + x * 12.6 + (y % 2 ? 6.3 : 0), 4 + y * 5.6, 1.6, 0, Math.PI * 2);
      c.fill();
    }
  }
  const t = tex(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Window glow: warm cabin light seen through thick fused silica.
export function makeWindowGlow() {
  const cv = canvas(128, 128);
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, '#fff2d8');
  g.addColorStop(0.55, '#e8c89a');
  g.addColorStop(1, '#6a5a44');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  // silhouettes of equipment racks inside
  c.fillStyle = 'rgba(40,34,28,0.55)';
  c.fillRect(10, 20, 22, 90);
  c.fillRect(92, 30, 26, 80);
  c.fillRect(40, 96, 50, 20);
  return tex(cv);
}

// A small round sprite used by particles and beacons.
export function makeSprite(soft = true) {
  const cv = canvas(64, 64);
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  if (soft) {
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  }
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
