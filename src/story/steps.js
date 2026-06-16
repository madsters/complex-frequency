// steps.js — the SIX STEPS of the Complex Frequency story (Contract A).
//
// This file is PURE DATA: an array of `Step` objects. The engine (engine.js)
// reads each Step and (a) fills the narrative panel, (b) hands the `scene`
// config to VIZ's createScene(), and (c) builds the listed `controls` as
// sliders. Nothing here touches the DOM or Three.js directly — keeping the
// content separate from the machinery makes the prose easy to edit later.
//
// Prose philosophy (the owner asked for this): INTUITION FIRST. Each step
// opens with the picture/idea in plain words; the formula is shown afterwards
// as a "now here's the symbol for that" payoff, with a friendly `gloss`.
//
// ---------------------------------------------------------------------------
// Contract A — Step:
//   id       string                       // matches the equation SVG + URL hash
//   kicker   string                       // small colored eyebrow ("Step 3 · Radial")
//   title    string
//   prose    string[]                     // 1–3 short HTML paragraphs
//   math     {img, gloss} | null          // img = assets/equations/<id>.svg
//   scene    SceneConfig                  // handed verbatim to createScene()
//   controls string[]                     // subset of ["amp","omega","sigma","pitch"]
//
// Contract B — SceneConfig (what each `scene` below must look like):
//   params  {amp, omega, sigma, pitch}    // curve params (see math/curves.js)
//   show    {vector, triad[], osculatingPlane, complexPlane, axes, frameRibbon}
//   camera  {theta, phi, radius, autoRotate}
//   decomposition boolean                 // draw  v' = ρv + ω×v
//   morph?  "line" | "circle" | "helix" | "complex"
// ---------------------------------------------------------------------------

/**
 * A small helper so every scene gets the SAME shape (all `show` flags present,
 * a sensible camera) and each step only has to override what differs. This
 * keeps the data below short and guarantees VIZ never sees a missing field.
 *
 * @param {object} opts
 * @returns {import('./engine.js').SceneConfig}
 */
function scene(opts) {
  const {
    // curve params — default to a plain circle (only ω is "on")
    amp = 2.0, omega = 2.0, sigma = 0.0, pitch = 0.0,
    // visibility flags — everything off unless a step asks for it
    vector = false,
    triad = [],                 // which frame arrows to draw, e.g. ["T","N","B"]
    osculatingPlane = false,
    complexPlane = false,
    axes = true,                // faint world axes are almost always helpful
    frameRibbon = false,
    // camera framing
    theta = 0.9, phi = 1.05, radius = 9, autoRotate = true,
    // extras
    decomposition = false,
    morph = undefined,
  } = opts;

  return {
    params: { amp, omega, sigma, pitch },
    show: { vector, triad, osculatingPlane, complexPlane, axes, frameRibbon },
    camera: { theta, phi, radius, autoRotate },
    decomposition,
    ...(morph ? { morph } : {}),
  };
}

/** @type {import('./engine.js').Step[]} */
export const STEPS = [
  // ── 1 · FRENET ──────────────────────────────────────────────────────────
  // Goal: introduce the moving frame before any electrical meaning. A point
  // glides along a curve; three little arrows ride with it.
  {
    id: "frenet",
    kicker: "Step 1 · The frame",
    title: "A frame that rides the curve",
    prose: [
      "A dot glides along a path, and three arrows ride with it: <b>T</b> points the way it's going, <b>N</b> leans into the bend, <b>B</b> stands square to both.",
      "That travelling tripod is the <b>Frenet frame</b>. Just two motions describe it — how the path <i>bends</i> and how it <i>twists</i> out of plane. The rest of this story is simply naming those two.",
    ],
    math: {
      img: "assets/equations/frenet.svg",
      gloss: "Each arrow rotates into its neighbour: ω turns T toward N (bending), ξ turns N toward B (twisting out of plane).",
    },
    scene: scene({
      morph: "helix",                 // intro morph: line → circle → helix
      triad: ["T", "N", "B"],
      frameRibbon: true,
      autoRotate: true,
      radius: 10,
    }),
    controls: [],                     // step 1 is a guided animation, no sliders
  },

  // ── 2 · VOLTAGE CURVE ────────────────────────────────────────────────────
  // Goal: give the curve its electrical meaning. The voltage vector IS the
  // tangent to the flux curve.
  {
    id: "voltage-curve",
    kicker: "Step 2 · Voltage",
    title: "Voltage is a moving vector",
    prose: [
      "Read the picture electrically now. The <b>voltage</b> is just how fast the flux is changing — the arrow riding tangent to the curve.",
      "So voltage isn't a number wiggling up and down: it's a vector whose tip sweeps its own path. How <i>fast</i> that tip moves is the size of the voltage.",
    ],
    math: {
      img: "assets/equations/voltage-curve.svg",
      gloss: "v is the rate of change of the flux φ — tangent to the curve. Its length s′ = |v| is the voltage magnitude.",
    },
    scene: scene({
      omega: 2.0, sigma: 0.0, pitch: 0.0,   // a clean circle
      vector: true,
      triad: ["T", "N"],
      osculatingPlane: true,
      autoRotate: true,
    }),
    controls: [],
  },

  // ── 3 · RADIAL → ρ ───────────────────────────────────────────────────────
  // Goal: magnitude changing in time. Spiral outward/inward; ρ is the rate.
  {
    id: "radial",
    kicker: "Step 3 · Radial",
    title: "Growing or shrinking → ρ",
    prose: [
      "Drag <b>σ</b> and the circle unwinds into a spiral. As the vector turns it also grows <i>longer</i> (or shorter) — its magnitude is now on the move.",
      "That growth rate is the <b>radial frequency ρ</b>: positive ρ swells the signal, negative ρ decays it. On a plain circle the length never changes, so ρ = 0.",
    ],
    math: {
      img: "assets/equations/rho.svg",
      gloss: "ρ = v′ / v — the fractional rate the vector's length grows. The grow-or-decay knob.",
    },
    scene: scene({
      omega: 2.0, sigma: 0.22, pitch: 0.0,  // a spiral (ρ visible)
      vector: true,
      triad: ["T", "N"],
      osculatingPlane: true,
      autoRotate: true,
    }),
    controls: ["sigma"],
  },

  // ── 4 · AZIMUTHAL → ω ─────────────────────────────────────────────────────
  // Goal: rotation in the plane. The familiar frequency. Show v' = ρv + ω×v.
  {
    id: "azimuthal",
    kicker: "Step 4 · Azimuthal",
    title: "Turning in a plane → ω",
    prose: [
      "Drag <b>ω</b> to spin the vector around the circle faster or slower. This is the everyday frequency — how quickly the phase goes round.",
      "Now the change splits cleanly into two arrows: one that <i>stretches</i> the vector along itself (<b>ρv</b>) and one that <i>turns</i> it sideways (<b>ω×v</b>). Add them and you get the full change <b>v′</b>.",
    ],
    math: {
      img: "assets/equations/azimuthal.svg",
      gloss: "ω = (v × v′) / v² is the turning rate. The change v′ = ρv + ω×v — stretch plus turn.",
    },
    scene: scene({
      omega: 2.4, sigma: 0.0, pitch: 0.0,   // clean circle, focus on rotation
      vector: true,
      triad: ["T", "N"],
      osculatingPlane: true,
      decomposition: true,                  // draw the ρv + ω×v split
      autoRotate: true,
    }),
    controls: ["omega"],
  },

  // ── 5 · TORSIONAL → ξ ─────────────────────────────────────────────────────
  // Goal: leaving the plane. Helix; binormal emphasised.
  {
    id: "torsional",
    kicker: "Step 5 · Torsional",
    title: "Lifting out of the plane → ξ",
    prose: [
      "Drag <b>pitch</b> and the circle lifts into a <b>helix</b> — the path stops being flat and starts to climb. Watch the pink <b>B</b> arrow tilt as the curve corkscrews.",
      "That out-of-plane twist is the <b>torsional frequency ξ</b>. It's exactly zero for anything confined to one plane, and only wakes up when the motion truly leaves it.",
    ],
    math: {
      img: "assets/equations/torsional.svg",
      gloss: "ξ = v·τ — speed times the curve's torsion. Non-zero only when the path twists out of plane.",
    },
    scene: scene({
      omega: 2.0, sigma: 0.0, pitch: 0.55,  // a helix (ξ visible)
      vector: true,
      triad: ["T", "N", "B"],
      frameRibbon: true,
      autoRotate: true,
      radius: 11,
      phi: 1.2,
    }),
    controls: ["pitch"],
  },

  // ── 6 · COMPLEX → η = ρ + jω ──────────────────────────────────────────────
  // Goal: collapse to 2-D. In a plane the frame becomes a complex number.
  {
    id: "complex",
    kicker: "Step 6 · Complex",
    title: "Collapse to a complex number",
    prose: [
      "Kill the twist (ξ = 0) and everything flattens into one plane. The two motions left standing — <i>stretch</i> and <i>turn</i> — collapse into a single point on the complex plane.",
      "That point is <b>η = ρ + jω</b>: real part the growth ρ, imaginary part the rotation ω. Drag the sliders and watch the dot move — one number, the <b>complex frequency</b>, holding the whole signal.",
    ],
    math: {
      img: "assets/equations/complex.svg",
      gloss: "η = ρ + jω = v·v̇ / v². Real part = grow/decay, imaginary part = spin — both in one number.",
    },
    scene: scene({
      omega: 2.0, sigma: 0.18, pitch: 0.0,  // planar spiral → maps to ℂ
      vector: true,
      complexPlane: true,
      axes: false,                          // the ℂ-plane is the reference now
      autoRotate: false,                    // hold still so the η dot reads clearly
      theta: 0.0, phi: 0.001, radius: 8,    // look straight down the plane
    }),
    controls: ["sigma", "omega"],
  },

  // ── 7 · IN THE WILD ───────────────────────────────────────────────────────
  // Goal: complex frequency on a REAL disturbance. Data-driven event scene
  // (engine mounts createEventScene instead of the 3D createScene for type:"event").
  {
    id: "real-event",
    kicker: "Step 7 · In the wild",
    title: "A real grid event",
    prose: [
      "Everything so far was geometry. Here's that same <b>η = ρ + jω</b> measured on a real power system — the Australian 14-generator model, the instant a large unit (<b>BPS</b>) loses <b>17% of its mechanical power</b>.",
      "Each dot is one of five areas tracing its complex frequency as the event unfolds. They dive down the imaginary (<b>ω</b>) axis — the frequency dip — bottoming out at slightly <i>different</i> times as the disturbance ripples across the network, then settle low. The real part <b>ρ</b> barely moves: losing mechanical power is an <i>active-power</i> event, so it lives almost entirely in ω. Watch <b>Area 2</b> for the one real ρ excursion.",
    ],
    math: {
      img: "assets/equations/complex.svg",
      gloss: "The same η = ρ + jω — now measured. Vertical motion is ω (frequency); the near-flat ρ axis confirms an active-power event.",
    },
    scene: { type: "event", data: "assets/cf_fig3_data.csv" },
    controls: [],
  },
];

export default STEPS;
