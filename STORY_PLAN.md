# Complex Frequency — Interactive Story: build plan

## Vision

A single-page web app you **click through like a story**. Each step pairs:
1. a short, plain-language idea (intuition first — math is optional/expandable),
2. an **interactive animation** tuned to that idea,
3. (optional) the formula, shown only when you ask for it ("show the maths").

The current sandbox becomes the final **Playground** step. Goal: by the end,
"complex frequency η = ρ + jω" feels obvious, and the viewer has *felt* each
piece by manipulating it.

Tech stance (fixed): **no-build, vanilla ES modules + Three.js + Canvas 2D**.
Rationale: frameworks (React/Vite/etc.) mean more package installs, which are
painful under the registry policy. The current stack already renders; we extend
it. Equations rendered as **pre-generated SVGs from the local LaTeX toolchain**
(MiKTeX is already installed) — crisp, no JS math-lib dependency.

---

## The narrative (clickable steps)

**Open with the geometry, not the textbook.** Step 1 is the Frenet frame — the
language everything else is built from. Frequencies are *introduced as* the
rotation rates of that frame.

| # | Step | Core idea (plain language) | Interactive |
|---|------|----------------------------|-------------|
| 1 | **The Frenet frame** | a moving point traces a curve; the frame T·N·B rides along. Curvature κ = how it bends, torsion τ = how it twists out of plane | orbit a curve; T/N/B triad moves; morph line → circle → helix to feel κ and τ |
| 2 | **Voltage is a moving vector** | a voltage vector's tip traces exactly such a curve | tip tracing a circle in 3D; the frame reappears on it |
| 3 | **Magnitude changes → ρ** | radial frequency = how fast \|v\| grows/decays (frame's outward rate) | σ slider → spiral; ρ readout |
| 4 | **Rotation in a plane → ω** | azimuthal frequency = how fast T spins (the *conventional* frequency); v̇ = ρv + ω×v | decomposition arrows |
| 5 | **Leaving the plane → ξ** | torsional frequency = how fast the plane (B) twists; 0 unless non-planar | pitch slider → helix; ξ appears |
| 6 | **Collapse to 2D → η = ρ + jω** | in a plane ξ=0 and the frame becomes a complex number | complex-plane view; η dot moves |
| 7 | **Voltage & flux** | v = −ψ̇; generalized frequency = v·v̇ / v² (ties to power systems) | flux curve → voltage as its tangent |
| 8 | **Why it matters (transients)** | real grids are non-stationary: κ/τ — and so ρ/ω/ξ — change as the trajectory deforms | transient preset; watch the trajectory bend/leave-plane and the ρ/ω/ξ readouts shift |
| 9 | **Playground** | explore freely | the full sandbox (today's app) |

(Trim to ~6 for a tighter first cut; steps 7–8 are the power-systems payoff.)
Note: the time-domain plot is intentionally **not** part of this — superseded.

---

## Architecture & the two contracts that enable delegation

Everything hinges on two declarative contracts. Once frozen, streams build
against them independently.

### A. `Step` (consumed by the story engine, authored by content)
```js
{
  id: "radial",
  title: "Magnitude can change",
  kicker: "Radial frequency ρ",
  prose: ["<p>…plain language…</p>"],
  math: { svg: "assets/equations/rho.svg", gloss: "rate of change of |v|" } | null,
  scene: SceneConfig,                  // the interactive (see B)
  controls: ["sigma"],                 // which sliders/toggles to expose this step
}
```

### B. `SceneConfig` (consumed by the viz engine)
```js
{
  preset: "spiral" | null,             // or explicit curve:
  curve:  { amp, omega, sigma, pitch },
  show:   { vector:true, triad:["T","N","B"], osculatingPlane:false,
            complexPlane:false, axes:true },
  camera: { theta, phi, radius, autoRotate:true },
  decomposition: false,                // draw v̇ = ρv + ω×v
  annotations: [ { at:[x,y,z], text:"…", color } ],
}
```
The engine exposes: `const s = createScene(container, sceneConfig); s.update(partial); s.dispose();`

---

## Work streams (parallel, delegatable)

> Phase 0 (I do first, ~1 sitting): freeze the two contracts above, scaffold the
> directory + stubs so each stream has a clean seam. Then streams run in parallel.

**S1 — App shell & story engine**
Stepper + prev/next + keyboard + progress rail + URL hash deep-links; two-pane
responsive layout (prose | stage); step transitions; mounts/unmounts a Scene per
step. *Owns the `Step` schema. Depends on: nothing.*

**S2 — Visualization engine**
Refactor today's `main.js` into a reusable `createScene(container, cfg)` driven by
`SceneConfig`: curve, vector, triad, osculating plane, complex-plane mode, time
plot, decomposition, annotations, orbit. *Owns `SceneConfig`. Depends on: math.*

**S3 — Math & presets**
Extend `frenet.js`/`curves.js`: transient/oscillatory curves (so step 9 shows
time-varying frequency), complex-plane mapping for step 7, named presets
("circle","spiral","helix","transient","flux"). Node test harness asserting parity
with the Python. *Depends on: nothing.*

**S4 — Content & per-step interactives**
For each of the ~10 steps: write the prose + the `SceneConfig`. Splittable across
several agents (e.g. one per 2–3 steps). *Depends on: S1+S2+S3 contracts (stubs ok).*

**S5 — Design system & equations**
Design tokens (type scale, spacing, color), components (nav, cards, sliders,
"show maths" disclosure), responsive polish. Equation pipeline:
`tools/render_eqs` runs MiKTeX → `assets/equations/*.svg` from a list of formulas.
*Depends on: formula list (provided here), design brief.*

### Dependency / phasing
```
Phase 0  contracts + scaffold (me)
Phase 1  ║ S1 shell  ║ S2 engine  ║ S3 math  ║ S5 tokens+eq-pipeline   (parallel)
Phase 2  ║ S4 content (split N ways) ║ S2 finish interactions ║ S5 polish (parallel)
Phase 3  integrate → headless-screenshot every step → fix → verify (me)
```

### Proposed structure
```
web/
  index.html
  src/
    app.js                 # bootstrap
    story/ engine.js  nav-ui.js  steps.js     # S1 (steps.js = S4)
    viz/   scene.js  orbit.js  presets.js     # S2
    math/  frenet.js  curves.js                # S3
    ui/    design.css                          # S5
  assets/equations/*.svg                       # S5
  tools/render_eqs.(py|sh)                      # S5 (uses MiKTeX)
```

### Verification
Per-step headless-Edge screenshots (technique already working), Node math tests
(S3), responsive checks. Each delegated stream ships with explicit acceptance
criteria + a screenshot or test as proof.

### Delegation model
Parallel subagents, one per stream (S4 further split per step-group). I freeze
the contracts, scaffold, then coordinate + integrate. Optionally a single
orchestrated workflow if you'd rather it run hands-off.
