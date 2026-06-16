// nav.js — navigation for the story: prev/next buttons, clickable progress
// dots, left/right arrow keys, the "01 / 06" counter, and URL hash routing
// (so #frenet, #radial, … deep-link to a step and the back button works).
//
// nav.js talks to the engine through exactly two channels:
//   - it calls  engine.goTo(i)            to move
//   - it sets   engine.onChange = fn      to be told when the step changed
//     (whether the change came from a button, a key, a dot, or the URL hash)
//
// Keeping it this thin means the engine doesn't know how navigation happens,
// and nav doesn't know what a "step" contains — clean separation.
//
// UI shape (built inside the ids index.html provides — we restructure their
// *contents*, the ids themselves stay intact):
//
//   #stepnav  ── a single glass pill ───────────────────────────────────────┐
//     #prev          round arrow button (disabled at the start)             │
//     #dots          progress track: a connecting line + N labelled dots,   │
//                    each dot a button with a hover tooltip of its title    │
//     ┌ a meta block we build here:                                         │
//     │  · the CURRENT step's title (live label, read from the engine)      │
//     │  · the "01 / 06" position counter (folded into the bar)             │
//     └                                                                     │
//     #next          round arrow button (disabled at the end)               │
//   ─────────────────────────────────────────────────────────────────────  ┘
//
// The standalone #counter that index.html parks at bottom-left used to
// overlap the dots; we hide it and surface the count inside the bar instead.

export class Nav {
  /**
   * @param {import('./engine.js').StoryEngine} engine
   * @param {object} refs
   * @param {HTMLButtonElement} refs.prev     #prev
   * @param {HTMLButtonElement} refs.next     #next
   * @param {HTMLElement} refs.dots           #dots
   * @param {HTMLElement} refs.counter        #counter
   * @param {{id:string,title?:string,kicker?:string}[]} steps  step list
   */
  constructor(engine, refs, steps) {
    this.engine = engine;
    this.refs = refs;
    this.steps = steps;

    this._buildMeta();
    this._buildDots();
    this._bindButtons();
    this._bindKeys();
    this._bindHash();

    // When the engine changes step (from ANY source) refresh our chrome.
    this.engine.onChange = (i) => this._sync(i);
  }

  /** total step count, read from the engine. */
  get count() { return this.engine.count; }

  /**
   * Pull the human label for a step. Prefer the explicit `title`, fall back to
   * the `kicker`, then the raw id — always read from the STEPS data the engine
   * was given, never hardcoded here.
   * @param {number} i
   */
  _labelFor(i) {
    const s = this.steps[i] || {};
    return s.title || s.kicker || s.id || `Step ${i + 1}`;
  }

  // --- in-bar meta: live title + "01 / 06" counter -------------------------
  // We fold the position counter into the bar (the fixed #counter is hidden)
  // and pair it with the current step's title so the bar always says where you
  // are without a separate, overlapping element.
  _buildMeta() {
    // Hide the original bottom-left counter; its text now lives in the bar.
    // (The id stays in the DOM and we keep updating it, so anything reading
    //  #counter.textContent still works — it's just visually removed.)
    this.refs.counter.classList.add("counter-folded");

    const meta = document.createElement("div");
    meta.className = "nav-meta";

    this._titleEl = document.createElement("span");
    this._titleEl.className = "nav-title";

    this._posEl = document.createElement("span");
    this._posEl.className = "nav-pos";

    meta.append(this._titleEl, this._posEl);
    this._metaEl = meta;

    // Place the meta block between the dots and the next button.
    this.refs.dots.insertAdjacentElement("afterend", meta);
  }

  // --- progress dots --------------------------------------------------------
  _buildDots() {
    this.refs.dots.innerHTML = "";

    // A thin progress line behind the dots: a track + a fill that grows toward
    // the active step. Purely decorative (aria-hidden); the dots carry the a11y.
    const track = document.createElement("span");
    track.className = "dot-line";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "dot-line-fill";
    track.append(fill);
    this.refs.dots.append(track);
    this._lineFill = fill;

    this._dotEls = this.steps.map((step, i) => {
      const dot = document.createElement("button");
      dot.className = "dot";
      dot.type = "button";
      const label = this._labelFor(i);
      dot.setAttribute("aria-label", `Go to step ${i + 1}: ${label}`);

      // A hover/focus tooltip naming the step (read from STEPS via engine).
      const tip = document.createElement("span");
      tip.className = "dot-tip";
      tip.textContent = `${String(i + 1).padStart(2, "0")} · ${label}`;
      dot.append(tip);

      // Clicking a dot jumps straight to that step.
      dot.addEventListener("click", () => this.engine.goTo(i));
      this.refs.dots.append(dot);
      return dot;
    });
  }

  // --- prev / next ----------------------------------------------------------
  _bindButtons() {
    this.refs.prev.addEventListener("click", () => this.engine.goTo(this.engine.index - 1));
    this.refs.next.addEventListener("click", () => this.engine.goTo(this.engine.index + 1));
  }

  // --- keyboard: ← / → ------------------------------------------------------
  _bindKeys() {
    this._onKey = (e) => {
      // Ignore when the user is dragging a slider / typing somewhere.
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight") { this.engine.goTo(this.engine.index + 1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { this.engine.goTo(this.engine.index - 1); e.preventDefault(); }
    };
    window.addEventListener("keydown", this._onKey);
  }

  // --- URL hash routing -----------------------------------------------------
  _bindHash() {
    // Browser back/forward (or someone editing the hash) → move to that step.
    this._onHash = () => {
      const i = this._indexFromHash();
      if (i !== -1 && i !== this.engine.index) this.engine.goTo(i);
    };
    window.addEventListener("hashchange", this._onHash);
  }

  /** Resolve the current location.hash to a step index, or -1 if none/invalid. */
  _indexFromHash() {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id) return -1;
    return this.steps.findIndex((s) => s.id === id);
  }

  /**
   * Public: pick the starting step. Honour a valid URL hash, else default to
   * step 0. Called once by app.js after wiring is complete.
   */
  start() {
    const fromHash = this._indexFromHash();
    this.engine.goTo(fromHash !== -1 ? fromHash : 0);
  }

  /**
   * Refresh all the navigation chrome for step `i`: active dot, disabled
   * end-buttons, the counter, and the URL hash. Called via engine.onChange.
   * @param {number} i
   */
  _sync(i) {
    // dots: mark the active one, and flag everything before it as "done" so
    // the connecting line + filled dots read as progress.
    this._dotEls.forEach((d, k) => {
      d.classList.toggle("active", k === i);
      d.classList.toggle("done", k < i);
      if (k === i) d.setAttribute("aria-current", "step");
      else d.removeAttribute("aria-current");
    });

    // grow the connecting fill line to the active dot's position. With N dots
    // evenly spread across the track, the active dot sits at i/(N-1) of it.
    if (this._lineFill) {
      const denom = Math.max(1, this.count - 1);
      this._lineFill.style.width = `${(i / denom) * 100}%`;
    }

    // disable prev at the start, next at the end
    this.refs.prev.disabled = i <= 0;
    this.refs.next.disabled = i >= this.count - 1;

    // counter "01 / 06" — fold into the bar AND keep the hidden #counter's
    // text current (so anything still reading that element keeps working).
    const pad = (n) => String(n).padStart(2, "0");
    const posText = `${pad(i + 1)} / ${pad(this.count)}`;
    this.refs.counter.textContent = posText;
    if (this._posEl) this._posEl.textContent = posText;
    if (this._titleEl) this._titleEl.textContent = this._labelFor(i);

    // keep the URL hash in sync WITHOUT adding a history entry per slide-drag.
    // (replaceState avoids polluting back-button history; we only push when the
    //  id actually differs from what's already there.)
    const id = this.steps[i].id;
    if (decodeURIComponent(window.location.hash.replace(/^#/, "")) !== id) {
      history.replaceState(null, "", `#${id}`);
    }
  }

  /** Remove global listeners (symmetry with engine.dispose). */
  dispose() {
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("hashchange", this._onHash);
  }
}

export default Nav;
