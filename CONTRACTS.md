# Build contracts — Complex Frequency story (freeze; build against these)

No-build vanilla ES modules + Three.js (installed at `node_modules/three`).
Entry: `index.html` → `src/app.js`. Design system: `src/ui/design.css` (authored;
**match it — visual quality is the top priority**). Equations: pre-rendered SVGs
in `assets/equations/` (rendered from `../frenet_milano/freqfrenet.tex`).

## Directory ownership (avoid collisions)
```
src/math/   frenet.js, curves.js  + NEW: complexmap.js, presets.js   ← Stream MATH
src/viz/    orbit.js              + NEW: scene.js                     ← Stream VIZ
src/story/  engine.js, nav.js, steps.js                              ← Stream STORY
src/app.js  bootstrap (STORY owns)
src/ui/     design.css (authored), components.css (STORY may add)
assets/equations/*.svg                                               ← host (me)
```
`index.html` and `src/ui/design.css` are authored by host — agents must not edit them.

## Contract A — `Step` (src/story/steps.js exports `STEPS: Step[]`)
```js
/** @typedef {Object} Step
 *  @property {string} id
 *  @property {string} kicker     // small colored eyebrow, e.g. "Step 1"
 *  @property {string} title
 *  @property {string[]} prose    // 1–3 short paragraphs (HTML allowed)
 *  @property {{img:string, gloss:string}|null} math  // img = assets/equations/<id>.svg
 *  @property {SceneConfig} scene
 *  @property {string[]} controls // slider keys to expose: subset of ["amp","omega","sigma","pitch"]
 */
```

## Contract B — `SceneConfig` + `createScene` (src/viz/scene.js)
```js
/** @typedef {Object} SceneConfig
 *  @property {{amp,omega,sigma,pitch}} params      // curve params (see math/curves.js)
 *  @property {{vector:boolean, triad:string[], osculatingPlane:boolean,
 *              complexPlane:boolean, axes:boolean, frameRibbon:boolean}} show
 *  @property {{theta,phi,radius,autoRotate:boolean}} camera
 *  @property {boolean} decomposition                // draw v' = ρv + ω×v
 *  @property {"line"|"circle"|"helix"|"complex"} [morph]  // optional intro morph
 */

// VIZ exports:
export function createScene(container /*HTMLElement*/, cfg /*SceneConfig*/) {
  // returns:
  return {
    update(partialParams) {},   // live slider changes {omega, sigma, ...}
    setConfig(cfg) {},          // full reconfigure on step change (animate transition)
    resize() {},
    dispose() {},               // remove renderer + listeners (called on step exit)
  };
}
```
VIZ must look polished: antialiased, crisp fat lines for vectors/axes, soft
lighting + subtle bloom/glow on the marker, smooth eased transitions between
configs, slow idle auto-rotate, drag-orbit + wheel-zoom (reuse `orbit.js`).
Colors from the palette below. All ρ/ω/ξ values come from `math/frenet.js`.

## Contract C — math API (src/math/, pure, no three)
Existing (keep): `frenet.apparatus(vFunc, t)` → {v,d1,T,N,B,kappa,tau,rho,omegaVec,omega,xi};
`curves.makeCurve({amp,omega,sigma,pitch,tCenter})`, `DEFAULTS`, `RANGES`.
ADD:
- `presets.js`: named SceneConfig param sets used by steps — `circle, spiral, helix`.
- `complexmap.js`: `toComplex(vFunc,t)` → {re, im, rho, omega} for the 2-D collapse (step 6).
- A Node test (`tools/math.test.mjs`) asserting parity with Python values
  (circle ρ≈0, ω≈ω₀, ξ≈0; helix ξ≠0). Run: `node tools/math.test.mjs`.

## The six steps (exact, from freqfrenet.tex)

1. **frenet** — *The Frenet frame.* A moving point traces a curve; T/N/B ride
   along; κ = how it bends, τ = how it twists out of plane.
   Scene: morph line→circle→helix, triad shown, autoRotate.
   Eq: `T'=ωN, N'=−ωT+ξB, B'=−ξN` (frenet.svg).
2. **voltage-curve** — *Voltage is a moving vector.* Its tip traces such a curve;
   v = −φ̇ (tangent to the flux curve). Scene: circle, vector shown, triad on.
   Eq: `v = −φ' = x'`,  `s' = |v| = v`.
3. **radial** — *Magnitude changes → ρ.* ρ = v′/v = rate of change of |v|.
   Scene: spiral (sigma>0), vector + ρ readout. controls:["sigma"].
   Eq: `ρ = v'/v` (rho.svg).
4. **azimuthal** — *Rotation in a plane → ω.* the conventional frequency;
   v′ = ρv + 𝛚×v. Scene: circle, decomposition:true. controls:["omega"].
   Eq: `𝛚 = (v×v')/v²,  v' = ρv + 𝛚×v` (azimuthal.svg).
5. **torsional** — *Leaving the plane → ξ.* ξ = vτ; zero unless non-planar.
   Scene: helix (pitch>0), triad + binormal emphasis. controls:["pitch"].
   Eq: `ξ = vτ` (torsional.svg).
6. **complex** — *Collapse to 2-D: η = ρ + jω.* in a plane ξ=0 and the frame is
   a complex number (e₁→1, e₂→j). Scene: complexPlane:true, η dot on ℂ-plane.
   Eq: `η = ρ + jω = v·v̇ / v²` (complex.svg).

## Palette / design tokens (also in design.css :root)
bg `#0e1116` · panel `#12171e` · line `#232b36` · text `#e6edf3` · mute `#8d99ae`
accent `#bdb2ff` · radial(ρ) `#4cc9f0` · azimuthal(ω/N) `#06d6a0` ·
torsional(ξ/B) `#ef476f` · tangent(T/v) `#ffd166`. Font: Segoe UI / system.

## Acceptance per stream
- MATH: `node tools/math.test.mjs` passes; complexmap returns sane values.
- VIZ: `createScene` mounts, looks polished, transitions smoothly, disposes cleanly.
- STORY: 6 steps click through (prev/next + keyboard + progress), each mounts its
  scene, math/prose/equation laid out per design.css; verified by headless screenshot.
