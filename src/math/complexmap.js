// complexmap.js — the "collapse to 2-D" used by step 6 (η = ρ + jω).
//
// When the voltage curve lies in a plane (torsion / xi = 0), the Frenet frame
// stops being a 3-D triad and behaves like a single complex number:
//   e1 -> 1   (real axis),   e2 -> j   (imaginary axis).
// The geometric frequency then collapses to one complex number
//   η = ρ + jω
// where ρ is the radial (growth) frequency and ω the azimuthal (rotation)
// frequency. This module exposes both:
//   - the planar position of the voltage tip (re, im) = (x, y) of v(t), and
//   - the matching (rho, omega) from the Frenet apparatus,
// so the viz can draw the tip on the plane *and* the η dot on the ℂ-plane.
//
// Pure ES module — only depends on the validated apparatus in frenet.js.

import { apparatus } from "./frenet.js";

/**
 * Map the voltage curve at time t onto the complex picture.
 *
 * @param {(t:number)=>[number,number,number]} vFunc  curve from makeCurve()
 * @param {number} t                                  time to evaluate at
 * @returns {{re:number, im:number, rho:number, omega:number}}
 *   re, im : planar coordinates (x, y) of the voltage tip v(t)
 *   rho    : radial frequency   = (v·v̇)/v²   (real part of η)
 *   omega  : azimuthal frequency = |(v×v̇)/v²| (imaginary part of η)
 */
export function toComplex(vFunc, t) {
  const a = apparatus(vFunc, t);

  // The planar tip position: x -> real axis, y -> imaginary axis.
  // (a.v is the 3-vector [x, y, z]; in a planar scene z ~ 0.)
  const re = a.v[0];
  const im = a.v[1];

  // η = ρ + jω comes straight from the apparatus.
  return { re, im, rho: a.rho, omega: a.omega };
}

export default toComplex;
