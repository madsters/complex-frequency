// math.test.mjs — zero-dependency Node test for the math stream.
//
// Asserts parity with the Python apparatus (src/frenet.py) for the three
// canonical curves, plus a sanity check on the complex collapse:
//   circle (sigma=pitch=0): rho ~ 0, omega ~ omega_param, xi ~ 0
//   spiral (sigma > 0)     : rho ~ sigma
//   helix  (pitch > 0)     : xi clearly != 0
//
// Run:  node tools/math.test.mjs
// Exits nonzero if any check fails.

import { makeCurve } from "../src/math/curves.js";
import { apparatus } from "../src/math/frenet.js";
import { PRESETS } from "../src/math/presets.js";
import { toComplex } from "../src/math/complexmap.js";

// --- tiny test harness ----------------------------------------------------
let failures = 0;

/** Assert that `actual` is within `tol` of `expected`. */
function near(label, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  report(label, ok, `got ${fmt(actual)}, expected ${fmt(expected)} ±${tol}`);
}

/** Assert that |actual| is at least `min` (clearly nonzero / large enough). */
function atLeast(label, actual, min) {
  const ok = Math.abs(actual) >= min;
  report(label, ok, `got |${fmt(actual)}|, expected >= ${min}`);
}

function report(label, ok, detail) {
  if (ok) {
    console.log(`PASS  ${label}  (${detail})`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}  (${detail})`);
  }
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

// --- the curves under test (parameters come from the shared presets) ------
const t = 1.0; // generic evaluation time for circle/spiral

// circle: only azimuthal rotation
{
  const p = PRESETS.circle.params;
  const a = apparatus(makeCurve(p), t);
  near("circle rho ~ 0", a.rho, 0, 1e-3);
  near("circle omega ~ omega_param", a.omega, p.omega, 1e-3);
  near("circle xi ~ 0", a.xi, 0, 1e-3);
}

// spiral: magnitude grows, so rho should equal sigma
{
  const p = PRESETS.spiral.params;
  const a = apparatus(makeCurve(p), t);
  near("spiral rho ~ sigma", a.rho, p.sigma, 1e-3);
  // still planar -> torsional frequency stays ~ 0
  near("spiral xi ~ 0", a.xi, 0, 1e-3);
}

// helix: non-planar, so torsional frequency xi is clearly nonzero.
// Evaluate at tCenter so z ~ 0 there and rho/omega stay clean too.
{
  const p = PRESETS.helix.params;
  const tc = p.tCenter ?? 0;
  const a = apparatus(makeCurve(p), tc);
  atLeast("helix xi != 0", a.xi, 0.1);
  near("helix rho ~ 0", a.rho, 0, 1e-3);
}

// complexmap: η = ρ + jω, and (re, im) match the planar tip of v.
{
  const p = PRESETS.spiral.params;
  const vFunc = makeCurve(p);
  const c = toComplex(vFunc, t);
  const v = vFunc(t);
  const a = apparatus(vFunc, t);
  near("complexmap re == v.x", c.re, v[0], 1e-9);
  near("complexmap im == v.y", c.im, v[1], 1e-9);
  near("complexmap rho == apparatus.rho", c.rho, a.rho, 1e-9);
  near("complexmap omega == apparatus.omega", c.omega, a.omega, 1e-9);
}

// --- summary --------------------------------------------------------------
if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks PASSED");
}
