import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The script. Everything that happens to you, and when.
// Radio lines are captioned; the audio is band-limited, half-heard speech
// under static, the way a flight loop sounds from inside a helmet.
// ---------------------------------------------------------------------------

const SPEAKERS = {
  capcom: { label: 'CAPCOM', pitch: 108, quindar: true, cls: 'capcom' },
  ev2: { label: 'EV2 · ELLISON', pitch: 196, quindar: false, cls: 'ev2' },
  ev1: { label: 'EV1', cls: 'ev1', silent: true },
  suit: { label: 'SUIT', cls: 'suit', silent: true },
  none: { label: '', cls: 'fx', silent: true },
};

// Debris crossings, in seconds after the strike.
export const PASSES = [
  { at: 100, dur: 9, dir: [-0.35, 0.16, 1], breakWing: -1 },
  { at: 206, dur: 10, dir: [0.25, -0.1, 1], breakWing: 4 },
  { at: 322, dur: 10, dir: [-0.15, 0.3, 1], breakWing: 1 },
  { at: 436, dur: 11, dir: [0.4, 0.05, 1], breakWing: 2 },
  { at: 550, dur: 11, dir: [-0.3, -0.2, 1], breakWing: -1 },
  { at: 664, dur: 12, dir: [0.1, 0.25, 1], breakWing: -1 },
];

export class Story {
  constructor(game) {
    this.g = game;
    this.queue = [];
    this.reset(false);
  }

  reset(skipIntro) {
    this.queue.length = 0;
    this.t = 0;
    this.phase = skipIntro ? 'strike' : 'intro';
    this.sinceStrike = -1;
    this.flags = {};
    this.comm = 'AOS';
    this.objectiveId = null;
    this.stabilizedAt = -1;
    this.bottleAt = -1;
    this.endingT = -1;
    this.scare = 0;
    this.lostT = -1;
    this.lastPassWarned = -1;
    this.interactT = 0;
    this.interactKind = null;
  }

  // Schedule `fn` to run `delay` seconds from now.
  after(delay, fn) {
    this.queue.push({ at: this.t + delay, fn });
  }

  say(who, text, { delay = 0, urgency = 0, broken = 0, dur } = {}) {
    const s = SPEAKERS[who];
    const words = text.split(/\s+/).length;
    const d = dur || Math.max(1.6, words / 2.7 + 0.5);
    const go = () => {
      if (who === 'capcom' && this.comm === 'LOS') return;
      if (!s.silent) this.g.audio.transmit(d, { pitch: s.pitch, quindar: s.quindar, urgency, broken });
      this.g.hud.subtitle(s.label, text, d + 1.6, s.cls);
    };
    if (delay > 0) this.after(delay, go);
    else go();
    return d;
  }

  setObjective(id, text, hint) {
    this.objectiveId = id;
    this.g.hud.objective(text, hint);
  }

  // ------------------------------------------------------------------ intro
  beginIntro() {
    const g = this.g;
    g.hud.setMode('minimal');
    this.setObjective('intro', 'EVA 2 · antenna swap complete', '<kbd>Mouse</kbd> look around');
    this.say('capcom', "EV1, Houston. Good copy on the antenna swap. You're about twenty minutes ahead of the timeline.", { delay: 2.0 });
    this.say('ev2', 'Copy that, Houston.', { delay: 8.4 });
    this.say('ev2', 'Hey. Take a second. Look down.', { delay: 10.6 });
    this.say('ev2', 'Never gets old, does it?', { delay: 14.8 });
    this.say('capcom', "Enjoy it. Sunset in under two minutes. Let's stow the tools and head for the airlock.", { delay: 17.6 });
    this.after(22.4, () => g.distantFlashes(true));
    this.say('ev2', "Houston, EV2. I'm seeing flashes off the starboard arrays. Like... glitter?", { delay: 22.8 });
    this.say('capcom', 'EV2, say again? ... EV1, EV2, debris strike, debris strike! Get behind the—', { delay: 28.0, urgency: 1, dur: 3.2 });
    this.after(30.6, () => this.strike());
  }

  // ------------------------------------------------------------------ strike
  strike() {
    const g = this.g;
    this.phase = 'play';
    this.sinceStrike = 0;
    g.distantFlashes(false);
    g.strike();
    g.hud.setMode('full');
    g.hud.objective(null);
    g.audio.scream(1.5);
    g.hud.subtitle('EV2 · ELLISON', '[screaming]', 2.2, 'ev2');
    this.after(1.6, () => {
      g.audio.crackle(2);
      g.audio.setStaticBase(0.012);
    });
    this.after(2.2, () => {
      g.hud.alert('pressure', 'SUIT PRESSURE DECAY', 'warning');
      g.hud.alert('o2flow', 'O₂ FLOW HIGH', 'caution');
      g.audio.setAlarm(2);
    });
    this.after(9, () => g.audio.setAlarm(1));
    this.say('capcom', 'EV1! EV1, Houston, respond!', { delay: 4.2, urgency: 1, broken: 0.4 });
    this.after(8.5, () => {
      if (this.flags.stabilized) return;
      this.say('capcom', "You're tumbling. Hit your SAFER. Attitude hold. Now.", { urgency: 0.8, broken: 0.3 });
      this.setObjective('stabilize', 'Stop the tumble', '<kbd>R</kbd> SAFER automatic attitude hold');
    });
    this.after(26, () => {
      if (this.flags.stabilized || this.g.player.aahEngaging) return;
      this.say('capcom', 'EV1, attitude hold. The button on your SAFER hand controller.', { urgency: 0.6 });
    });
    // debris crossings
    for (const p of PASSES) {
      g.debris.schedule(g.debris.time + p.at, p.dur, new THREE.Vector3(...p.dir), { breakWing: p.breakWing, density: 1, lethality: 1 });
    }
  }

  onStabilized() {
    if (this.flags.stabilized) return;
    this.flags.stabilized = true;
    this.stabilizedAt = this.sinceStrike;
    const g = this.g;
    g.hud.objective(null);
    this.say('capcom', 'Good. Good. We see your rates coming down.', { delay: 1.2 });
    this.say('capcom', "EV1, your suit is leaking. You won't make the airlock on what you have.", { delay: 4.6 });
    this.say('capcom', "Ellison was carrying the spare O2 bottle. Her beacon's still transmitting.", { delay: 10.0 });
    this.after(11.5, () => {
      this.flags.beacon = true;
      this.setObjective('ev2', 'Reach EV2 · recover the spare O₂ bottle', '<kbd>W A S D</kbd> thrust · <kbd>Space</kbd>/<kbd>Shift</kbd> up/down · <kbd>X</kbd> brake · <kbd>G</kbd> grab handrail');
    });
    this.say('capcom', "We're not getting any vitals from her, EV1. I'm sorry.", { delay: 16.5 });
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    this.t += dt;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].at <= this.t) {
        const e = this.queue.splice(i, 1)[0];
        e.fn();
      }
    }
    if (this.phase === 'intro') return;
    if (this.phase === 'ending' || this.phase === 'dead') return;
    this.sinceStrike += dt;
    const g = this.g;
    const p = g.player;
    const S = this.sinceStrike;

    if (!this.flags.stabilized && p.aah) this.onStabilized();

    // sunset warning
    const toSunset = g.orbit.secondsToSunset();
    if (!this.flags.sunsetWarn && g.orbit.sunVisible > 0.5 && toSunset < 24 && S > 6) {
      this.flags.sunsetWarn = true;
      this.say('capcom', "Heads up, sunset in twenty seconds. It's going to get very dark. Helmet lights.");
      this.after(3, () => g.hud.alert('lights', 'L · HELMET LIGHTS', 'info', 8));
    }

    // debris warnings
    const next = g.debris.next();
    if (next && next !== this._warned) {
      const tt = next.start - g.debris.time;
      if (tt < 34) {
        this._warned = next;
        const idx = g.debris.passes.indexOf(next);
        if (idx === 0) {
          this.say('capcom', 'EV1, listen to me. The fragments are still up there. They cross your orbit again in thirty seconds.', { urgency: 0.5 });
          this.say('capcom', 'Put something solid between you and them. A module. The truss. Not the arrays.', { delay: 7.5, urgency: 0.5 });
        } else if (this.comm === 'AOS') {
          this.say('capcom', `EV1, next crossing in ${Math.round(tt / 5) * 5} seconds. Get behind something.`, { urgency: 0.6 });
        } else {
          g.hud.alert('debriswarn', 'CONJUNCTION WARNING · SEEK SHIELDING', 'warning', 6);
        }
        g.audio.riser(Math.min(tt, 30));
      }
    }

    // loss of signal: the relay gap
    if (!this.flags.los && S > 118 && this.flags.stabilized) {
      this.flags.los = true;
      const d = this.say('capcom', "EV1, we're losing you. Relay gap, couple of minutes. You'll be on your own. Stay calm. Breathe slow.", { broken: 0.5 });
      this.after(d + 0.6, () => {
        this.comm = 'LOS';
        g.audio.setStaticBase(0.02);
        g.hud.alert('los', 'COMM · LOSS OF SIGNAL', 'caution', 5);
      });
    }
    if (this.comm === 'LOS' && this.flags.los && !this.flags.aos) {
      const aosAt = Math.max(175, this.bottleAt >= 0 ? this.bottleAt + 24 : 1e9);
      if (S > aosAt || (S > 250 && this.bottleAt < 0)) {
        this.flags.aos = true;
        this.comm = 'AOS';
        g.audio.setStaticBase(0.006);
        this.say('capcom', 'EV1, Houston, how do you read? ... We have you again.');
        if (this.bottleAt >= 0) {
          this.say('capcom', 'We see your O2 coming up. Well done. Now get to that airlock.', { delay: 4.5 });
        } else {
          this.say('capcom', 'EV1, your O2 is critical. You need that bottle.', { delay: 4.5, urgency: 0.5 });
        }
      }
    }

    // EV2
    const cm = g.crewmate;
    const dEV2 = p.pos.distanceTo(cm.root.position);
    if (this.flags.beacon && this.bottleAt < 0) {
      g.audio.setBeacon(THREE.MathUtils.clamp(3.5 - dEV2 / 18, 0.4, 3.2));
      if (!this.flags.ev2Alarm && dEV2 < 24) {
        this.flags.ev2Alarm = true;
        g.hud.subtitle('EV2 · ELLISON', "[her suit's caution tone, still sounding]", 5, 'fx');
      }
      if (!this.flags.scare && dEV2 < 7.5 && S > 30) {
        this.flags.scare = true;
        g.ev2Scare();
        this.scare = 0.75;
      }
    }
    if (this.scare > 0) this.scare = Math.max(0, this.scare - dt * 0.12);

    // interaction: EV2's bottle, or the hatch
    let promptText = null;
    let holdTime = 0;
    let kind = null;
    if (this.objectiveId === 'ev2' && this.bottleAt < 0 && dEV2 < 2.8) {
      kind = 'bottle';
      holdTime = 2.2;
      promptText = '<kbd>F</kbd> hold · take the spare O₂ bottle';
    }
    const dHatch = p.pos.distanceTo(g.station.airlock.approach);
    if (this.objectiveId === 'airlock' && dHatch < 3.0) {
      kind = 'hatch';
      holdTime = 2.6;
      promptText = '<kbd>F</kbd> hold · open EV hatch 1';
    }
    if (kind) {
      if (g.lastInput.interact && p.alive) {
        this.interactT += dt;
        if (this.interactT >= holdTime) {
          this.interactT = 0;
          if (kind === 'bottle') this.takeBottle();
          else this.beginEnding();
          g.hud.prompt(null);
          return;
        }
      } else {
        this.interactT = Math.max(0, this.interactT - dt * 2);
      }
      g.hud.prompt(promptText, this.interactT / holdTime);
    } else {
      this.interactT = 0;
      g.hud.prompt(null);
    }

    // consumables
    if (p.o2 < 0.25 && !this.flags.o2caution) {
      this.flags.o2caution = true;
      g.hud.alert('o2', 'O₂ LOW', 'caution');
      g.audio.setAlarm(Math.max(1, g.audio._alarm.level));
      if (this.comm === 'AOS') this.say('capcom', 'EV1, watch your O2.', { urgency: 0.4 });
    }
    if (p.o2 < 0.1 && !this.flags.o2warn) {
      this.flags.o2warn = true;
      g.hud.alert('o2', 'O₂ CRITICAL', 'warning');
      g.audio.setAlarm(2);
    }
    if (p.o2 > 0.3 && this.flags.o2caution) {
      this.flags.o2caution = this.flags.o2warn = false;
      g.hud.clearAlert('o2');
      g.audio.setAlarm(0);
    }
    if (p.n2 < 0.15 && !this.flags.n2low) {
      this.flags.n2low = true;
      g.hud.alert('n2', 'SAFER N₂ LOW · PUSH OFF HANDRAILS', 'caution', 10);
    }
    if (p.n2 <= 0.001 && !this.flags.n2out) {
      this.flags.n2out = true;
      g.hud.alert('n2', 'SAFER PROPELLANT DEPLETED', 'warning');
    }

    // lost: no propellant, drifting away from everything
    const dStation = p.pos.length();
    const outward = p.vel.dot(p.pos) / Math.max(dStation, 1e-3);
    if (this.lostT < 0 && p.n2 <= 0.002 && dStation > 140 && outward > 0.04) {
      this.lostT = 0;
      if (this.comm === 'AOS') this.say('capcom', "EV1... we can't reach you. I'm so sorry.", { urgency: 0 });
    }
    if (this.lostT >= 0) {
      this.lostT += dt;
      if (this.lostT > 14) this.g.death('lost');
    }

    if (p.dying > 7) this.g.death('o2');
  }

  takeBottle() {
    const g = this.g;
    this.bottleAt = this.sinceStrike;
    g.takeBottle();
    g.audio.setBeacon(0);
    g.hud.subtitle('EV1', "...I'm sorry, Mara.", 4, 'ev1');
    g.hud.alert('o2recharge', 'O₂ BOTTLE CONNECTED · PRIMARY RECHARGED', 'info', 5);
    this.setObjective('airlock', 'Get to the airlock', 'Starboard side of Node 1 · <kbd>F</kbd> hold at the hatch');
    this.after(15, () => {
      g.audio.micClicks(3);
      g.hud.subtitle('EV2 · ELLISON', '[her channel keys up. Three clicks. Nothing else.]', 5, 'fx');
      this.scare = Math.max(this.scare, 0.45);
    });
  }

  // ------------------------------------------------------------------ ending
  beginEnding() {
    const g = this.g;
    this.phase = 'ending';
    this.endingT = 0;
    g.beginEnding();
    const T = (s, fn) => this.after(s, fn);
    T(5.5, () => {
      this.comm = 'AOS';
      this.say('capcom', 'EV1, Houston. We see the hatch closed. Starting repress.', {});
    });
    T(9.5, () => g.audio.repress(7));
    T(17.5, () => this.say('capcom', "Pressure's good. You made it, EV1. Get that helmet off. Breathe.", {}));
    T(24.5, () => this.say('capcom', "We'll figure out the rest in the morning.", {}));
    T(30.5, () => g.audio.knock());
    T(31.8, () => g.audio.knock());
    T(33.1, () => g.audio.knock());
    T(33.4, () => g.hud.subtitle('', '[three knocks, from the other side of the hatch]', 4, 'fx'));
    T(37.5, () => g.audio.stinger('low'));
    T(38.5, () => g.win());
  }
}
