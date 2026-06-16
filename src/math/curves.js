// curves.js — the parametric voltage curve, driven by UI parameters.
//
// One flexible curve exposes all three frequencies at once, so each slider
// maps to one geometric effect:
//
//   r(t) = amp · e^{sigma·t}                 (sigma  -> RADIAL frequency rho)
//   x = r·cos(omega·t),  y = r·sin(omega·t)  (omega  -> AZIMUTHAL frequency)
//   z = pitch · (omega·t − omega·tCenter)    (pitch  -> TORSIONAL frequency xi)
//
// sigma = pitch = 0  -> a circle      (only omega)
// sigma > 0          -> a spiral      (rho appears)
// pitch > 0          -> a helix       (xi appears, curve leaves its plane)

export function makeCurve(params) {
  const { amp, omega, sigma, pitch, tCenter = 0 } = params;
  return (t) => {
    const r = amp * Math.exp(sigma * t);
    const th = omega * t;
    return [
      r * Math.cos(th),
      r * Math.sin(th),
      pitch * omega * (t - tCenter),
    ];
  };
}

// Sensible defaults + slider ranges (shared with the UI).
export const DEFAULTS = { amp: 2.0, omega: 2.0, sigma: 0.0, pitch: 0.0 };

export const RANGES = {
  amp:   { min: 0.5, max: 3.0,  step: 0.1 },
  omega: { min: 0.2, max: 6.0,  step: 0.1 },
  sigma: { min: -0.6, max: 0.6, step: 0.02 },
  pitch: { min: 0.0, max: 1.0,  step: 0.02 },
};
