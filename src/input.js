import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Keyboard + mouse (pointer lock, or drag-to-look where lock is unavailable),
// and a touch layout for phones and tablets.
// ---------------------------------------------------------------------------

const BIND = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['Space'],
  down: ['ShiftLeft', 'ShiftRight', 'KeyC'],
  rollL: ['KeyQ'],
  rollR: ['KeyE'],
  brake: ['KeyX'],
  interact: ['KeyF'],
  grab: ['KeyG'],
};

export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.edges = new Set();
    this.mdx = 0;
    this.mdy = 0;
    this.locked = false;
    this.dragging = false;
    this.rightDown = false;
    this.rightEdge = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.enabled = false;
    this.touch = { move: new THREE.Vector2(), up: 0, lookX: 0, lookY: 0, brake: false, interact: false, grabEdge: false };
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.edges.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    this.el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 2) {
        this.rightDown = true;
        this.rightEdge = true;
      }
      if (e.button === 0 && !this.locked) this.dragging = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightDown = false;
      if (e.button === 0) this.dragging = false;
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || this.dragging) {
        this.mdx += e.movementX || 0;
        this.mdy += e.movementY || 0;
      }
    });
  }

  requestLock() {
    if (this.isTouch) return;
    try {
      const p = this.el.requestPointerLock?.({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.el.requestPointerLock?.());
    } catch {
      /* drag-to-look still works */
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(action) {
    return BIND[action].some((k) => this.keys.has(k));
  }

  pressed(code) {
    return this.edges.has(code);
  }

  // Build this frame's control state and clear the edge/delta accumulators.
  frame() {
    const move = new THREE.Vector3(
      (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0),
      (this.down('up') ? 1 : 0) - (this.down('down') ? 1 : 0),
      (this.down('back') ? 1 : 0) - (this.down('forward') ? 1 : 0),
    );
    const t = this.touch;
    if (t.move.lengthSq() > 0.01) {
      move.x += t.move.x;
      move.z += -t.move.y;
    }
    move.y += t.up;
    const k = 0.0022 * this.sensitivity;
    const out = {
      move,
      roll: (this.down('rollL') ? 1 : 0) - (this.down('rollR') ? 1 : 0),
      lookX: this.mdx * k + t.lookX * 0.005 * this.sensitivity,
      lookY: (this.mdy * k + t.lookY * 0.005 * this.sensitivity) * (this.invertY ? -1 : 1),
      brake: this.down('brake') || t.brake,
      grab: this.pressed('KeyG') || this.rightEdge || t.grabEdge,
      interact: this.down('interact') || t.interact,
    };
    this.mdx = this.mdy = 0;
    t.lookX = t.lookY = 0;
    t.grabEdge = false;
    this.rightEdge = false;
    return out;
  }

  endFrame() {
    this.edges.clear();
  }

  // ------------------------------------------------------------- touch UI
  buildTouchUI(root, actions) {
    const ui = document.createElement('div');
    ui.className = 'touch';
    ui.innerHTML = `
      <div class="stick" data-stick><div class="knob"></div></div>
      <div class="tbtns tbtns-left">
        <button data-hold="up">Up</button>
        <button data-hold="down">Down</button>
      </div>
      <div class="tbtns tbtns-right">
        <button data-tap="aah">Stabilize</button>
        <button data-hold="brake">Brake</button>
        <button data-tap="grab">Grab</button>
        <button data-hold="interact">Use</button>
        <button data-tap="lights">Lights</button>
        <button data-tap="pause">Menu</button>
      </div>`;
    root.appendChild(ui);
    const t = this.touch;
    const stick = ui.querySelector('[data-stick]');
    const knob = stick.querySelector('.knob');
    let stickId = null;
    let origin = null;
    const moveStick = (x, y) => {
      const r = 50;
      let dx = x - origin.x;
      let dy = y - origin.y;
      const l = Math.hypot(dx, dy);
      if (l > r) {
        dx = (dx / l) * r;
        dy = (dy / l) * r;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      t.move.set(dx / r, -dy / r);
    };
    stick.addEventListener('touchstart', (e) => {
      const touch = e.changedTouches[0];
      stickId = touch.identifier;
      const rect = stick.getBoundingClientRect();
      origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      moveStick(touch.clientX, touch.clientY);
      e.preventDefault();
    }, { passive: false });
    let lookId = null;
    let last = null;
    this.el.addEventListener('touchstart', (e) => {
      for (const touch of e.changedTouches) {
        if (lookId === null) {
          lookId = touch.identifier;
          last = { x: touch.clientX, y: touch.clientY };
        }
      }
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === stickId) moveStick(touch.clientX, touch.clientY);
        if (touch.identifier === lookId) {
          t.lookX += touch.clientX - last.x;
          t.lookY += touch.clientY - last.y;
          last = { x: touch.clientX, y: touch.clientY };
        }
      }
    }, { passive: true });
    const end = (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === stickId) {
          stickId = null;
          knob.style.transform = '';
          t.move.set(0, 0);
        }
        if (touch.identifier === lookId) lookId = null;
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    for (const b of ui.querySelectorAll('[data-hold]')) {
      const key = b.dataset.hold;
      const set = (v) => {
        if (key === 'up') t.up = v ? 1 : 0;
        else if (key === 'down') t.up = v ? -1 : 0;
        else t[key] = v;
        b.classList.toggle('on', v);
      };
      b.addEventListener('touchstart', (e) => { set(true); e.preventDefault(); }, { passive: false });
      b.addEventListener('touchend', () => set(false));
      b.addEventListener('touchcancel', () => set(false));
    }
    for (const b of ui.querySelectorAll('[data-tap]')) {
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const a = b.dataset.tap;
        if (a === 'grab') t.grabEdge = true;
        else actions[a]?.();
      }, { passive: false });
    }
    this.touchUI = ui;
    return ui;
  }
}
