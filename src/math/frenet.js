// frenet.js — geometric-frequency apparatus for a voltage curve.
// Direct JS port of ../../src/frenet.py. Pure ES module, NO dependencies
// (works with plain [x, y, z] arrays so it stays decoupled from three.js).
//
// Convention: the traced curve is the locus of the voltage-vector tip,
// p(t) = vFunc(t). Everything is computed from v(t) and its time derivatives
// (central finite differences), so any curve given as a function just works.
//
// Returns (all rates in s^-1):
//   speed |v|;  T,N,B Frenet frame;  kappa curvature;  tau torsion;
//   rho  radial frequency   = (v·v̇)/v² = d/dt ln|v|
//   omegaVec azimuthal vector = (v×v̇)/v²,  omega = |omegaVec|
//   xi   torsional frequency = speed_along_curve · tau

const EPS = 1e-12;

// --- tiny 3-vector helpers (arrays of length 3) ---------------------------
export const sub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add   = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot   = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm  = (a) => Math.sqrt(dot(a, a));
export const unit  = (a) => {
  const n = norm(a);
  return n > EPS ? scale(a, 1 / n) : [0, 0, 0];
};

// Central finite differences of a vector-valued function vFunc(t) -> [x,y,z].
export function derivatives(vFunc, t, h = 1e-4) {
  const vp2 = vFunc(t + 2 * h);
  const vp1 = vFunc(t + h);
  const v   = vFunc(t);
  const vm1 = vFunc(t - h);
  const vm2 = vFunc(t - 2 * h);
  const d1 = scale(sub(vp1, vm1), 1 / (2 * h));
  const d2 = scale(add(sub(vp1, scale(v, 2)), vm1), 1 / (h * h));
  // 3rd derivative (central, 4-point)
  const d3 = scale(
    add(sub(vp2, scale(vp1, 2)), sub(scale(vm1, 2), vm2)),
    1 / (2 * h * h * h),
  );
  return { v, d1, d2, d3 };
}

export function apparatus(vFunc, t, h = 1e-4) {
  const { v, d1, d2, d3 } = derivatives(vFunc, t, h);
  const speed = norm(v);
  const v2 = speed * speed;

  // radial + azimuthal frequencies (defined on v as position)
  const rho = v2 > EPS ? dot(v, d1) / v2 : 0;
  const omegaVec = v2 > EPS ? scale(cross(v, d1), 1 / v2) : [0, 0, 0];
  const omega = norm(omegaVec);

  // Frenet frame / curvature / torsion of the v-curve (uses v', v'', v''')
  const sp = norm(d1);                       // speed along the v-curve
  const c12 = cross(d1, d2);
  const kappa = sp > EPS ? norm(c12) / (sp * sp * sp) : 0;
  const denom = dot(c12, c12);
  const tau = denom > EPS ? dot(d1, cross(d2, d3)) / denom : 0;

  const T = unit(d1);
  const B = unit(c12);
  const N = cross(B, T);

  const xi = sp * tau;                       // torsional frequency

  return { v, d1, d2, d3, speed, T, N, B, kappa, tau, rho, omegaVec, omega, xi };
}
