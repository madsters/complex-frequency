// presets.js — named parameter + camera presets used by the story steps.
//
// Each preset bundles the curve parameters (fed to math/curves.makeCurve and
// the sliders) together with a camera pose that frames that curve nicely.
// The story/viz streams import these so every step starts from a known,
// good-looking configuration.
//
// Curve recap (see curves.js):
//   sigma -> RADIAL frequency rho   (sigma=0 keeps |v| constant)
//   omega -> AZIMUTHAL frequency    (rotation in the plane)
//   pitch -> TORSIONAL frequency xi (pitch=0 keeps the curve planar)
//
//   circle: sigma=0, pitch=0  -> flat ring (only omega)
//   spiral: sigma>0, pitch=0  -> in-plane growing spiral (rho appears)
//   helix : pitch>0, sigma=0  -> rises out of the plane (xi appears)
//
// Camera angles use spherical coordinates:
//   theta = azimuth around the vertical (z) axis, radians
//   phi   = polar/elevation angle from the +z axis, radians
//          (phi ~ pi/2 looks edge-on; smaller phi looks down from above)
//   radius = distance from the target (scene units)
//   autoRotate = slow idle spin when the user isn't dragging

// Shared base parameters. amp/omega are the same across presets so that
// switching presets only changes the *shape-defining* knobs (sigma, pitch).
const BASE = { amp: 2.0, omega: 2.0 };

export const PRESETS = {
  // Flat circle in the xy-plane. Look almost straight down so the ring reads
  // as a clean circle, with a small tilt to keep a sense of depth.
  circle: {
    params: { ...BASE, sigma: 0.0, pitch: 0.0 },
    camera: { theta: 0.0, phi: 0.45, radius: 7.0, autoRotate: true },
  },

  // In-plane spiral; sigma>0 so |v| grows and rho ~ sigma. Same top-ish view
  // as the circle so the outward growth of the spiral is obvious.
  spiral: {
    params: { ...BASE, sigma: 0.18, pitch: 0.0 },
    camera: { theta: 0.0, phi: 0.5, radius: 8.0, autoRotate: true },
  },

  // Helix climbing out of the plane; pitch>0 so xi != 0. View from nearer the
  // equator (larger phi) so the vertical rise and the twist are both visible.
  helix: {
    params: { ...BASE, sigma: 0.0, pitch: 0.6, tCenter: 1.4 },
    camera: { theta: 0.6, phi: 1.15, radius: 9.0, autoRotate: true },
  },
};

// Convenience named exports so callers can do either
//   import { circle } from "./presets.js"     or
//   import { PRESETS } from "./presets.js"
export const circle = PRESETS.circle;
export const spiral = PRESETS.spiral;
export const helix = PRESETS.helix;

export default PRESETS;
