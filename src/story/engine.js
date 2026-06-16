// engine.js — the story engine.
//
// Responsibilities (the "what happens when you land on a step"):
//   1. Mount/maintain ONE 3D scene in #scene-host (VIZ's createScene).
//   2. Fill the narrative panel (#st-kicker / #st-title / #st-prose / #st-eq).
//   3. Build the step's exposed sliders into #st-controls; each slider calls
//      scene.update() live so the picture responds as you drag.
//   4. Cross-fade the narrative text whenever the step changes.
//   5. Handle window resize and clean disposal.
//
// It does NOT own navigation/keyboard/URL — that's nav.js. The engine just
// exposes goTo(index) and the engine + nav talk through a tiny callback.
//
// Typedefs (shared with steps.js) ------------------------------------------
/** @typedef {Object} SceneConfig
 *  @property {{amp:number,omega:number,sigma:number,pitch:number}} params
 *  @property {{vector:boolean,triad:string[],osculatingPlane:boolean,
 *              complexPlane:boolean,axes:boolean,frameRibbon:boolean}} show
 *  @property {{theta:number,phi:number,radius:number,autoRotate:boolean}} camera
 *  @property {boolean} decomposition
 *  @property {"line"|"circle"|"helix"|"complex"} [morph] */
/** @typedef {Object} Step
 *  @property {string} id
 *  @property {string} kicker
 *  @property {string} title
 *  @property {string[]} prose
 *  @property {{img:string,gloss:string}|null} math
 *  @property {SceneConfig} scene
 *  @property {string[]} controls */

import { createScene } from "../viz/scene.js";
import { createEventScene } from "../viz/event_scene.js";
import { RANGES, DEFAULTS } from "../math/curves.js";

// Friendly labels + units for the four parameters a slider can drive.
// (label uses the Greek symbol the prose refers to; unit is purely cosmetic.)
const PARAM_META = {
  amp:   { label: "amplitude", symbol: "A" },
  omega: { label: "rotation",  symbol: "ω" },
  sigma: { label: "growth",    symbol: "σ" },
  pitch: { label: "pitch",     symbol: "p" },
};

export class StoryEngine {
  /**
   * @param {object} refs   DOM handles (passed in by app.js so the engine
   *                         never has to guess at ids — easy to test).
   * @param {HTMLElement} refs.sceneHost   #scene-host
   * @param {HTMLElement} refs.content     #narrative-content (.content wrapper)
   * @param {HTMLElement} refs.kicker      #st-kicker
   * @param {HTMLElement} refs.title       #st-title
   * @param {HTMLElement} refs.prose       #st-prose
   * @param {HTMLElement} refs.eq          #st-eq  (figure)
   * @param {HTMLElement} refs.controls    #st-controls
   * @param {Step[]} steps
   */
  constructor(refs, steps) {
    this.refs = refs;
    this.steps = steps;
    this.index = -1;             // -1 = nothing shown yet
    this.scene = null;           // the live scene handle (createScene/createEventScene)
    this._sceneKind = null;      // "viz" (3D) | "event" (data plot) — for clean swaps

    // Per-step working copy of the curve params. Sliders mutate THIS object so
    // the values persist while you're on a step (and reset cleanly on enter).
    this.liveParams = { ...DEFAULTS };

    // nav.js registers a callback here to keep dots/counter/buttons in sync.
    /** @type {(index:number)=>void} */
    this.onChange = () => {};

    // Resize: keep the scene's renderer matched to the host element.
    this._onResize = () => this.scene && this.scene.resize();
    window.addEventListener("resize", this._onResize);
  }

  get count() { return this.steps.length; }

  /**
   * Move to a step. Cross-fades the narrative, then swaps content and
   * reconfigures the scene. Guards against out-of-range / same-step calls.
   * @param {number} i
   */
  goTo(i) {
    if (i < 0 || i >= this.steps.length || i === this.index) return;
    const first = this.index === -1;
    this.index = i;

    if (first) {
      // First mount: no fade-out (there's nothing to fade), just paint.
      this._render();
    } else {
      // Subsequent: fade the panel out, swap, fade back in. The CSS handles
      // the actual easing via the .leaving class (see design.css .content).
      const el = this.refs.content;
      el.classList.add("leaving");
      const after = () => {
        el.removeEventListener("transitionend", after);
        clearTimeout(timer);
        this._render();
        // next frame: drop .leaving so it eases back to full opacity
        requestAnimationFrame(() => el.classList.remove("leaving"));
      };
      el.addEventListener("transitionend", after);
      // Fallback in case transitionend doesn't fire (e.g. reduced motion).
      const timer = setTimeout(after, 360);
    }

    this.onChange(i);            // let nav update dots/counter/buttons
  }

  /** Paint the current step: narrative text + controls + scene config. */
  _render() {
    const step = this.steps[this.index];

    // --- narrative text -----------------------------------------------------
    this.refs.kicker.textContent = step.kicker;
    this.refs.title.textContent = step.title;
    // prose is an array of HTML paragraph bodies → wrap each in <p>.
    this.refs.prose.innerHTML = step.prose.map((p) => `<p>${p}</p>`).join("");

    // --- equation figure ----------------------------------------------------
    const eq = this.refs.eq;
    if (step.math) {
      eq.hidden = false;
      // <img> for the pre-rendered SVG + a <figcaption> for the plain gloss.
      eq.innerHTML =
        `<img src="${step.math.img}" alt="equation" />` +
        `<figcaption>${step.math.gloss}</figcaption>`;
    } else {
      eq.hidden = true;
      eq.innerHTML = "";
    }

    // --- reset live params to this step's scene defaults --------------------
    // (so dragging on step 3 doesn't leak into step 4).
    this.liveParams = { ...step.scene.params };

    // --- controls (sliders) -------------------------------------------------
    this._buildControls(step);

    // --- 3D scene -----------------------------------------------------------
    this._mountScene(step);
  }

  /**
   * Build the range sliders this step exposes. Each one reads its min/max/step
   * from math/curves.js RANGES, shows a live value badge (.v), and on input
   * (a) updates the value badge, (b) calls scene.update({key:value}).
   * @param {Step} step
   */
  _buildControls(step) {
    const host = this.refs.controls;
    host.innerHTML = "";
    if (!step.controls || step.controls.length === 0) return;

    for (const key of step.controls) {
      const range = RANGES[key];
      const meta = PARAM_META[key] || { label: key, symbol: key };
      const value = this.liveParams[key];

      // Markup mirrors design.css: .ctl-row > .ctl-label (label + .v) + input.
      const row = document.createElement("div");
      row.className = "ctl-row";

      const label = document.createElement("div");
      label.className = "ctl-label";
      const name = document.createElement("span");
      name.innerHTML = `${meta.symbol} <span style="color:var(--mute)">${meta.label}</span>`;
      const badge = document.createElement("span");
      badge.className = "v";
      badge.textContent = this._fmt(value, range.step);
      label.append(name, badge);

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(range.min);
      input.max = String(range.max);
      input.step = String(range.step);
      input.value = String(value);
      input.setAttribute("aria-label", meta.label);

      // Live drag: update badge + push the single changed param to the scene.
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        this.liveParams[key] = v;
        badge.textContent = this._fmt(v, range.step);
        if (this.scene) this.scene.update({ [key]: v });
      });

      row.append(label, input);
      host.append(row);
    }
  }

  /** Format a slider value with a sensible number of decimals from its step. */
  _fmt(v, step) {
    const decimals = step < 0.1 ? 2 : 1;
    return Number(v).toFixed(decimals);
  }

  /**
   * Mount or reconfigure the scene. First step creates it; later steps reuse
   * the same renderer via setConfig() so transitions can animate smoothly.
   * @param {Step} step
   */
  _mountScene(step) {
    const isEvent = step.scene && step.scene.type === "event";
    const kind = isEvent ? "event" : "viz";

    // Switching scene kind (3D ⇄ data plot): tear the old one down first so
    // the host element is clean and we don't leak a renderer or canvas.
    if (this.scene && this._sceneKind !== kind) {
      this.scene.dispose();
      this.scene = null;
    }
    this._sceneKind = kind;

    if (isEvent) {
      // Data-driven event plot. Self-running; no params/sliders to reconfigure,
      // so we just (re)create it if it isn't already mounted.
      if (!this.scene) {
        this.scene = createEventScene(this.refs.sceneHost, step.scene);
      }
      return;
    }

    // 3D scene: created once, reused via setConfig so transitions animate.
    const cfg = { ...step.scene, params: { ...this.liveParams } };
    if (!this.scene) {
      this.scene = createScene(this.refs.sceneHost, cfg);
    } else {
      this.scene.setConfig(cfg);
    }
  }

  /** Tear everything down (scene + listeners). Called on app teardown. */
  dispose() {
    window.removeEventListener("resize", this._onResize);
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
  }
}

export default StoryEngine;
