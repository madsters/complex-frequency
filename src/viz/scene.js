// scene.js — the VIZ engine for the Complex Frequency story.
// =============================================================================
// This module owns everything that happens inside the #scene-host <div>: it
// creates a Three.js WebGLRenderer, a scene graph, lighting, the voltage curve,
// the moving marker, the voltage vector, the Frenet triad (T/N/B), optional
// decomposition arrows, an optional osculating plane, and an optional 2-D
// "complex plane" mode. It is driven entirely by a `SceneConfig` object
// (see CONTRACTS.md, "Contract B").
//
// It exports a single factory `createScene(container, cfg)` returning a small
// controller object: { update, setConfig, resize, dispose }.
//
// Design goals (this is a teaching codebase, so comments are generous):
//   - Look premium: antialiased, fat/extruded geometry, soft 3-point-ish
//     lighting, an emissive glowing marker + subtle UnrealBloom, tasteful depth.
//   - Feel alive: slow idle auto-rotate, drag-orbit + wheel-zoom (via orbit.js),
//     and *smooth eased* transitions whenever the config or curve changes.
//   - Be robust: no top-level work that can throw, defensive guards everywhere,
//     graceful fallback if post-processing fails to compose.
//
// All colors come strictly from the design.css palette (see PALETTE below).
// =============================================================================

import * as THREE from "three";

// Fat anti-aliased lines (screen-space width in px). These are the addons that
// give us crisp, thick curves/vectors instead of the 1px native gl.LINES.
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

// Post-processing for the soft glow ("bloom") on the marker. We import these
// lazily-ish (still at module top, but wrapped in try/catch at setup time) so
// that if a future Three version changes the API we degrade to plain emissive
// materials rather than crashing the whole scene.
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { Orbit } from "./orbit.js";
import { makeCurve } from "../math/curves.js";
import { apparatus } from "../math/frenet.js";

// `complexmap.js` is owned by the MATH stream and may not exist yet. The
// contract says: if absent, derive re/im from the vector + apparatus. We can't
// do a conditional static import in a plain ES module, so we always use the
// apparatus-based fallback below (see computeComplex()). When MATH ships
// complexmap.toComplex, STORY can pass values through `update()` if desired.

// -----------------------------------------------------------------------------
// PALETTE — must match :root in src/ui/design.css exactly.
// -----------------------------------------------------------------------------
const PALETTE = {
  bg:       0x0e1116,
  panel:    0x12171e,
  line:     0x232b36,
  text:     0xe9eef5,
  mute:     0x93a0b4,
  accent:   0xbdb2ff,
  radial:   0x4cc9f0, // ρ
  azimuth:  0x06d6a0, // ω, N
  torsion:  0xef476f, // ξ, B
  tangent:  0xffd166, // T, v
};

// -----------------------------------------------------------------------------
// Small math/utility helpers (kept local so the module is self-contained).
// -----------------------------------------------------------------------------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Convert a 0xRRGGBB palette int to a "#rrggbb" CSS string (for canvas text).
const hexToCss = (hex) => "#" + hex.toString(16).padStart(6, "0");

// Smootherstep easing (Ken Perlin): 0..1 -> 0..1 with zero 1st & 2nd
// derivatives at the ends. Used for all our config transitions so nothing
// "snaps".
const easeInOut = (t) => {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// Lerp a value, and a convenience for THREE.Color/Vector3 lerping.
const lerp = (a, b, t) => a + (b - a) * t;

// The math layer talks in plain [x,y,z] arrays; THREE wants Vector3. These
// adapters keep the boundary tidy.
const arrToVec = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// A default SceneConfig so the engine never crashes on a partial/missing cfg.
// STORY normally passes a complete config, but defensive defaults make live
// editing and isolated testing painless.
function normalizeConfig(cfg) {
  cfg = cfg || {};
  const p = cfg.params || {};
  const show = cfg.show || {};
  const cam = cfg.camera || {};
  return {
    params: {
      amp:   p.amp   ?? 2.0,
      omega: p.omega ?? 2.0,
      sigma: p.sigma ?? 0.0,
      pitch: p.pitch ?? 0.0,
      tCenter: p.tCenter ?? 0.0,
    },
    show: {
      vector:          show.vector          ?? true,
      // triad is a list of which frame vectors to draw, e.g. ["T","N","B"].
      triad:           Array.isArray(show.triad) ? show.triad.slice() : [],
      osculatingPlane: show.osculatingPlane ?? false,
      complexPlane:    show.complexPlane    ?? false,
      axes:            show.axes            ?? true,
      frameRibbon:     show.frameRibbon     ?? false,
    },
    camera: {
      theta:      cam.theta,
      phi:        cam.phi,
      radius:     cam.radius,
      autoRotate: cam.autoRotate ?? true,
    },
    decomposition: cfg.decomposition ?? false,
    morph: cfg.morph ?? null, // "line" | "circle" | "helix" | "complex" | null
  };
}

// =============================================================================
// createScene — the one exported entry point.
// =============================================================================
/**
 * @param {HTMLElement} container  the #scene-host element to mount into
 * @param {object} cfg             a SceneConfig (Contract B)
 * @returns {{update:Function, setConfig:Function, resize:Function, dispose:Function}}
 */
export function createScene(container, cfg) {
  // ---- 0. State -------------------------------------------------------------
  let config = normalizeConfig(cfg);

  // The "live" params we actually render with. update()/setConfig() retarget
  // these and we tween toward the targets each frame for buttery transitions.
  const liveParams = { ...config.params };
  const targetParams = { ...config.params };

  // Morph weight: 0 = follow real curve params, but we also blend geometry
  // toward special shapes (line/circle/helix) when `morph` is set. See
  // shapePoint() / curvePositions().
  let morphState = { from: config.morph, to: config.morph, t: 1 };

  // A normalized [0..1] transition clock for show-flag fades (vector, triad,
  // plane, etc). 1 = fully settled.
  let showFade = 1;
  // Per-feature visibility targets (1 = visible). We tween opacity/scale to
  // these so toggles fade rather than pop.
  const vis = {
    vector: config.show.vector ? 1 : 0,
    T: config.show.triad.includes("T") ? 1 : 0,
    N: config.show.triad.includes("N") ? 1 : 0,
    B: config.show.triad.includes("B") ? 1 : 0,
    plane: config.show.osculatingPlane ? 1 : 0,
    decomp: config.decomposition ? 1 : 0,
    complex: config.show.complexPlane ? 1 : 0,
    ribbon: config.show.frameRibbon ? 1 : 0,
    axes: config.show.axes ? 1 : 0,
  };
  const visTarget = { ...vis };

  // Animation time used to drive the marker around the curve.
  let clockT = 0;

  // The "t" along the curve where the marker currently sits. The curve is
  // sampled over a window [tMin, tMax]; the marker loops through it.
  const T_MIN = -Math.PI;
  const T_MAX = Math.PI;

  // ---- 1. Renderer ----------------------------------------------------------
  // antialias:true + a clamped device-pixel-ratio gives crisp edges without
  // melting low-end GPUs. alpha:true lets the CSS radial-gradient backdrop
  // (in design.css) show through, so the 3D blends into the page.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0); // transparent — CSS backdrop shows
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic = premium look
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // ---- 2. Scene + camera ----------------------------------------------------
  const scene = new THREE.Scene();
  // A faint fog tints distant geometry toward the bg color → depth cue.
  scene.fog = new THREE.Fog(PALETTE.bg, 16, 34);

  const camera = new THREE.PerspectiveCamera(
    42,                                   // fov — slightly long lens = elegant
    container.clientWidth / Math.max(1, container.clientHeight),
    0.1,
    100,
  );

  // Reuse the project's Orbit helper for drag/zoom/auto-rotate. We attach it to
  // the canvas (not the container) so pointer capture works cleanly.
  const orbit = new Orbit(camera, renderer.domElement, new THREE.Vector3(0, 0, 0));
  // Seed orbit from the config's camera, if provided.
  if (typeof config.camera.theta === "number") orbit.theta = config.camera.theta;
  if (typeof config.camera.phi === "number") orbit.phi = config.camera.phi;
  if (typeof config.camera.radius === "number") orbit.radius = config.camera.radius;
  orbit.autoRotate = config.camera.autoRotate;
  orbit.apply();

  // ---- 3. Lighting (soft hemisphere + key/fill directional = 3-point-ish) ---
  // Hemisphere gives an ambient sky/ground tint so nothing is pure black.
  const hemi = new THREE.HemisphereLight(0xbfd2ff, 0x0b0e13, 0.55);
  scene.add(hemi);

  // Key light — main shaping light, warm-ish, from upper right.
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(6, 9, 7);
  scene.add(key);

  // Fill light — cooler, opposite side, softer, kills harsh shadows.
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.45);
  fill.position.set(-7, 3, -4);
  scene.add(fill);

  // Rim/back light — accent-tinted, behind, to separate geometry from the bg.
  const rim = new THREE.DirectionalLight(PALETTE.accent, 0.5);
  rim.position.set(0, -4, -8);
  scene.add(rim);

  // ---- 4. Resolution holder for fat lines ----------------------------------
  // Line2 needs the renderer resolution in pixels to compute screen-space
  // widths. We keep one Vector2 and update it on resize.
  const resolution = new THREE.Vector2(1, 1);

  // Factory for a fat-line material in our palette. `linewidth` is in *pixels*.
  function fatLineMaterial(colorHex, linewidth, opacity = 1) {
    const m = new LineMaterial({
      color: colorHex,
      linewidth,
      transparent: true,
      opacity,
      dashed: false,
      alphaToCoverage: true, // smoother fat-line edges
    });
    m.resolution.copy(resolution);
    return m;
  }

  // ---- 5. Root groups -------------------------------------------------------
  // A single root we can gently scale/rotate for the intro, plus sub-groups so
  // dispose() and visibility tweens stay organized.
  const root = new THREE.Group();
  scene.add(root);

  const axesGroup = new THREE.Group();
  const curveGroup = new THREE.Group();
  const vectorGroup = new THREE.Group();
  const triadGroup = new THREE.Group();
  const planeGroup = new THREE.Group();
  const decompGroup = new THREE.Group();
  const complexGroup = new THREE.Group();
  const ribbonGroup = new THREE.Group();
  root.add(axesGroup, curveGroup, ribbonGroup, planeGroup,
           decompGroup, vectorGroup, triadGroup, complexGroup);

  // We track every disposable resource (geometry/material/texture) so dispose()
  // is exhaustive and leak-free.
  const disposables = new Set();
  const track = (obj) => { if (obj) disposables.add(obj); return obj; };

  // ---- Text-label sprites ---------------------------------------------------
  // Crisp world-space labels via Sprite + CanvasTexture (no font deps). The
  // sprite always faces the camera; `worldHeight` sets its on-screen size in
  // world units (width follows the glyph aspect so text never stretches).
  function makeLabel(text, colorHex, worldHeight = 0.42) {
    const { tex, aspect } = makeLabelTexture(text, hexToCss(colorHex));
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,   // labels float above geometry so they never clip
      depthWrite: false,
      opacity: 1,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(worldHeight * aspect, worldHeight, 1);
    sprite.renderOrder = 10; // draw last so labels sit on top
    track(tex); track(mat);
    return sprite;
  }

  // =============================================================================
  // GEOMETRY BUILDERS
  // =============================================================================

  // ---- 5a. Axes (subtle) ----------------------------------------------------
  // Three thin, low-opacity fat-lines through the origin + a faint grid disk so
  // the space reads as 3-D without shouting. Built once.
  (function buildAxes() {
    const L = 5.0;
    const axisDefs = [
      { dir: [L, 0, 0], color: PALETTE.line },
      { dir: [0, L, 0], color: PALETTE.line },
      { dir: [0, 0, L], color: PALETTE.line },
    ];
    for (const a of axisDefs) {
      const geo = new LineGeometry();
      geo.setPositions([-a.dir[0], -a.dir[1], -a.dir[2], a.dir[0], a.dir[1], a.dir[2]]);
      const mat = fatLineMaterial(a.color, 1.2, 0.5);
      track(geo); track(mat);
      axesGroup.add(new Line2(geo, mat));
    }
    // A soft polar grid in the XY plane (the plane the circle lives in).
    const grid = new THREE.PolarGridHelper(4.5, 8, 5, 64, PALETTE.line, PALETTE.line);
    grid.material.transparent = true;
    grid.material.opacity = 0.13;
    grid.material.depthWrite = false;
    grid.rotation.x = Math.PI / 2; // PolarGridHelper is XZ by default → make XY
    track(grid.geometry); track(grid.material);
    axesGroup.add(grid);
  })();

  // ---- 5b. Voltage curve (fat line) -----------------------------------------
  // We rebuild this whenever params/morph change. We keep references so we can
  // dispose old geometry. The curve color is the tangent/voltage hue.
  let curveLine = null;
  let curveMat = fatLineMaterial(PALETTE.tangent, 3.4, 0.96);
  track(curveMat);

  const CURVE_SAMPLES = 220; // smooth enough for a fat line at any zoom

  // Build the array of positions for the fat-line curve, applying the active
  // morph tween (morphState.from → morphState.to weighted by morphState.t).
  function curvePositions(params) {
    const pts = [];
    const fromShape = morphState.from;
    const toShape = morphState.to;
    const w = easeInOut(morphState.t); // 0..1 progress from→to

    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const t = lerp(T_MIN, T_MAX, i / CURVE_SAMPLES);
      const a = shapePoint(t, params, fromShape);
      const b = shapePoint(t, params, toShape);
      pts.push(lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w));
    }
    return pts;
  }

  // Canonical shape sampler used by both the curve and the marker so they agree.
  // When `shape` is null we just use the real param-driven curve.
  function shapePoint(t, params, shape) {
    if (!shape || shape === "complex") return makeCurve(params)(t);
    const amp = params.amp;
    const om = params.omega;
    if (shape === "line") {
      return [amp * (t / Math.PI) * 1.6, 0, 0];
    }
    if (shape === "circle") {
      return [amp * Math.cos(om * t), amp * Math.sin(om * t), 0];
    }
    if (shape === "helix") {
      return [amp * Math.cos(om * t), amp * Math.sin(om * t), 0.5 * om * t];
    }
    return makeCurve(params)(t);
  }

  // Marker position consistent with the displayed curve (including morph tween).
  function markerPoint(t, params) {
    const w = easeInOut(morphState.t);
    const a = shapePoint(t, params, morphState.from);
    const b = shapePoint(t, params, morphState.to);
    return [lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)];
  }

  function rebuildCurve() {
    const positions = curvePositions(liveParams);
    if (curveLine) {
      // Reuse: just push new positions into the existing geometry.
      const geo = new LineGeometry();
      geo.setPositions(positions);
      const old = curveLine.geometry;
      curveLine.geometry = geo;
      track(geo);
      disposeOne(old);
    } else {
      const geo = new LineGeometry();
      geo.setPositions(positions);
      track(geo);
      curveLine = new Line2(geo, curveMat);
      curveLine.computeLineDistances();
      curveGroup.add(curveLine);
    }
  }
  rebuildCurve();

  // ---- 5c. Glowing marker ---------------------------------------------------
  // An emissive sphere + a soft additive halo sprite. With bloom enabled the
  // emissive sphere blooms; without bloom the halo still reads as a glow.
  const markerGroup = new THREE.Group();
  root.add(markerGroup);

  const markerGeo = track(new THREE.SphereGeometry(0.13, 32, 32));
  const markerMat = track(new THREE.MeshStandardMaterial({
    color: PALETTE.text,
    emissive: new THREE.Color(PALETTE.tangent),
    emissiveIntensity: 1.25,
    roughness: 0.25,
    metalness: 0.0,
  }));
  const markerMesh = new THREE.Mesh(markerGeo, markerMat);
  markerGroup.add(markerMesh);

  // Soft halo via an additive sprite with a radial-gradient canvas texture.
  const haloTex = track(makeGlowTexture());
  const haloMat = track(new THREE.SpriteMaterial({
    map: haloTex,
    color: PALETTE.tangent,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(0.6, 0.6, 0.6);
  markerGroup.add(halo);

  // ---- 5d. Voltage vector (origin → marker) ---------------------------------
  // A fat line plus a cone head. We rebuild positions each frame (cheap).
  let vectorLine = null;
  const vectorMat = track(fatLineMaterial(PALETTE.tangent, 4.0, 1));
  const vectorHeadGeo = track(new THREE.ConeGeometry(0.11, 0.32, 24));
  const vectorHeadMat = track(new THREE.MeshStandardMaterial({
    color: PALETTE.tangent,
    emissive: new THREE.Color(PALETTE.tangent),
    emissiveIntensity: 0.6,
    roughness: 0.35,
    metalness: 0.1,
  }));
  const vectorHead = new THREE.Mesh(vectorHeadGeo, vectorHeadMat);
  {
    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 1, 0, 0]); // placeholder, updated per frame
    track(geo);
    vectorLine = new Line2(geo, vectorMat);
    vectorGroup.add(vectorLine);
  }
  vectorGroup.add(vectorHead);

  // ---- 5e. Frenet triad (T/N/B arrows) --------------------------------------
  // Each arrow is a fat line + cone. We build three and toggle/scale them via
  // the `vis` tween. Colors per palette: T=tangent, N=azimuth, B=torsion.
  function makeArrow(colorHex, linewidth = 3.4) {
    const g = new THREE.Group();
    const lgeo = new LineGeometry();
    lgeo.setPositions([0, 0, 0, 1, 0, 0]);
    const lmat = fatLineMaterial(colorHex, linewidth, 1);
    track(lgeo); track(lmat);
    const line = new Line2(lgeo, lmat);
    const headGeo = track(new THREE.ConeGeometry(0.085, 0.26, 20));
    const headMat = track(new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: new THREE.Color(colorHex),
      emissiveIntensity: 0.5,
      roughness: 0.4,
      metalness: 0.1,
    }));
    const head = new THREE.Mesh(headGeo, headMat);
    g.add(line, head);
    return { group: g, line, head, lmat, headMat };
  }
  const arrowT = makeArrow(PALETTE.tangent);
  const arrowN = makeArrow(PALETTE.azimuth);
  const arrowB = makeArrow(PALETTE.torsion);
  triadGroup.add(arrowT.group, arrowN.group, arrowB.group);

  // Orient + scale an arrow so it points from `origin` along `dir` with length
  // `len`. We update the line's positions and place the cone at the tip.
  const _tmpA = new THREE.Vector3();
  const _tmpB = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _q = new THREE.Quaternion();
  function orientArrow(arrow, originVec, dirVec, len, scaleVis) {
    if (scaleVis <= 0.001) { arrow.group.visible = false; return; }
    arrow.group.visible = true;
    const d = _tmpA.copy(dirVec).normalize();
    const tip = _tmpB.copy(originVec).addScaledVector(d, len * scaleVis);
    // line body
    const shaftEnd = tip.clone().addScaledVector(d, -0.22); // leave room for head
    arrow.line.geometry.setPositions([
      originVec.x, originVec.y, originVec.z,
      shaftEnd.x, shaftEnd.y, shaftEnd.z,
    ]);
    // cone head at tip, oriented along d (cone default points +Y)
    arrow.head.position.copy(tip).addScaledVector(d, -0.13);
    _q.setFromUnitVectors(_up, d);
    arrow.head.quaternion.copy(_q);
    // fade material opacity with vis
    arrow.lmat.opacity = scaleVis;
    arrow.headMat.opacity = scaleVis;
    arrow.headMat.transparent = true;
  }

  // Place a camera-facing label sprite at distance `dist` along `dir` from
  // `originVec`, fading it with `opacity`. Hidden when nearly invisible.
  const _tmpL = new THREE.Vector3();
  function placeLabel(sprite, originVec, dirVec, dist, opacity) {
    if (opacity <= 0.02) { sprite.visible = false; return; }
    sprite.visible = true;
    const d = _tmpL.copy(dirVec).normalize();
    sprite.position.copy(originVec).addScaledVector(d, dist);
    sprite.material.opacity = opacity;
  }

  // ---- 5f. Osculating plane -------------------------------------------------
  // A translucent quad spanning T and N at the marker (the plane the curve
  // momentarily lives in). Built once, oriented per frame.
  const planeGeo = track(new THREE.PlaneGeometry(2.6, 2.6));
  const planeMat = track(new THREE.MeshStandardMaterial({
    color: PALETTE.accent,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    depthWrite: false,
  }));
  const planeMesh = new THREE.Mesh(planeGeo, planeMat);
  planeGroup.add(planeMesh);

  // ---- 5g. Decomposition arrows: v' = ρv + ω×v ------------------------------
  // Three arrows from the marker: the radial component ρv (radial color),
  // the azimuthal component ω×v (azimuth color), and their sum v' (accent).
  const decRadial = makeArrow(PALETTE.radial, 3.4);
  const decAzim = makeArrow(PALETTE.azimuth, 3.4);
  const decSum = makeArrow(PALETTE.accent, 4.0);
  decompGroup.add(decRadial.group, decAzim.group, decSum.group);
  // Tiny floating labels at each arrow's tip: ρv, ω×v, v'.
  const decLabRadial = makeLabel("ρv", PALETTE.radial, 0.5);   // ρv
  const decLabAzim   = makeLabel("ω×v", PALETTE.azimuth, 0.5); // ω×v
  const decLabSum    = makeLabel("v′", PALETTE.accent, 0.55);  // v′
  decompGroup.add(decLabRadial, decLabAzim, decLabSum);

  // ---- 5h. Frame ribbon (optional swept N-strip showing the frame twisting) -
  // A thin ribbon mesh swept along the curve in the N direction. Subtle; only
  // when show.frameRibbon. Rebuilt with the curve.
  let ribbonMesh = null;
  const ribbonMat = track(new THREE.MeshStandardMaterial({
    color: PALETTE.azimuth,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    roughness: 0.7,
    metalness: 0.05,
    depthWrite: false,
  }));
  function rebuildRibbon() {
    if (ribbonMesh) { ribbonGroup.remove(ribbonMesh); disposeOne(ribbonMesh.geometry); }
    const segs = 80, half = 0.28;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = lerp(T_MIN, T_MAX, i / segs);
      const app = safeApparatus(liveParams, t);
      const p = arrToVec(markerPoint(t, liveParams));
      const n = arrToVec(app.N);
      const a = p.clone().addScaledVector(n, half);
      const b = p.clone().addScaledVector(n, -half);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < segs; i++) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    track(geo);
    ribbonMesh = new THREE.Mesh(geo, ribbonMat);
    ribbonGroup.add(ribbonMesh);
  }
  rebuildRibbon();

  // ---- 5i. Complex plane (2-D collapse: η = ρ + jω) -------------------------
  // A clean, labelled Argand diagram in the XY plane: a faint square grid, a
  // real axis Re = ρ (radial color, horizontal) and an imaginary axis Im = ω
  // (azimuth color, vertical), each with a text label, plus a glowing "η" dot
  // at (ρ·scale, ω·scale) with a vector from the origin and an "η" label.
  // Bloom is toned right down in this mode so the axes/grid/labels read.
  const CPLX_EXTENT = 3.2;            // half-extent of the axes/grid (world units)
  const CPLX_STEP = 0.8;              // grid spacing
  const CPLX_RE_SCALE = 2.2;          // ρ  -> x position
  const CPLX_IM_SCALE = 0.7;          // ω  -> y position

  // faint square gridlines (built once, very low opacity)
  const complexGridMat = track(fatLineMaterial(PALETTE.line, 1.0, 0.18));
  {
    for (let g = -CPLX_EXTENT; g <= CPLX_EXTENT + 1e-6; g += CPLX_STEP) {
      if (Math.abs(g) < 1e-6) continue; // the axes themselves cover g=0
      const vGeo = new LineGeometry(); vGeo.setPositions([g, -CPLX_EXTENT, 0, g, CPLX_EXTENT, 0]);
      const hGeo = new LineGeometry(); hGeo.setPositions([-CPLX_EXTENT, g, 0, CPLX_EXTENT, g, 0]);
      track(vGeo); track(hGeo);
      complexGroup.add(new Line2(vGeo, complexGridMat));
      complexGroup.add(new Line2(hGeo, complexGridMat));
    }
  }

  // axes (slightly inset from the grid edge, brighter than the grid)
  const complexAxisMatRe = track(fatLineMaterial(PALETTE.radial, 2.4, 0.95));   // Re axis ~ ρ
  const complexAxisMatIm = track(fatLineMaterial(PALETTE.azimuth, 2.4, 0.95));  // Im axis ~ ω
  {
    const reGeo = new LineGeometry(); reGeo.setPositions([-CPLX_EXTENT, 0, 0, CPLX_EXTENT, 0, 0]);
    const imGeo = new LineGeometry(); imGeo.setPositions([0, -CPLX_EXTENT, 0, 0, CPLX_EXTENT, 0]);
    track(reGeo); track(imGeo);
    complexGroup.add(new Line2(reGeo, complexAxisMatRe));
    complexGroup.add(new Line2(imGeo, complexAxisMatIm));
  }

  // axis labels: "Re = ρ" at the right end, "Im = ω" at the top
  const complexLabRe = makeLabel("Re = ρ", PALETTE.radial, 0.46);
  complexLabRe.position.set(CPLX_EXTENT - 0.55, -0.34, 0);
  const complexLabIm = makeLabel("Im = ω", PALETTE.azimuth, 0.46);
  complexLabIm.position.set(0.62, CPLX_EXTENT - 0.3, 0);
  complexGroup.add(complexLabRe, complexLabIm);

  // η dot — emissive, but kept modest so toned-down bloom doesn't wash it out
  const etaGeo = track(new THREE.SphereGeometry(0.13, 28, 28));
  const etaMat = track(new THREE.MeshStandardMaterial({
    color: PALETTE.text,
    emissive: new THREE.Color(PALETTE.accent),
    emissiveIntensity: 1.6,
    roughness: 0.25,
  }));
  const etaDot = new THREE.Mesh(etaGeo, etaMat);
  etaDot.renderOrder = 5;
  complexGroup.add(etaDot);
  // η vector (origin → dot)
  const etaVecMat = track(fatLineMaterial(PALETTE.accent, 3.6, 1));
  const etaVecGeo = new LineGeometry(); etaVecGeo.setPositions([0, 0, 0, 1, 1, 0]);
  track(etaVecGeo);
  const etaVec = new Line2(etaVecGeo, etaVecMat);
  complexGroup.add(etaVec);
  // η label that rides just past the dot
  const etaLabel = makeLabel("η", PALETTE.accent, 0.6);
  complexGroup.add(etaLabel);
  // η halo (subtle — bloom is toned down in complex mode)
  const etaHaloMat = track(new THREE.SpriteMaterial({
    map: haloTex, color: PALETTE.accent, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const etaHalo = new THREE.Sprite(etaHaloMat);
  etaHalo.scale.set(0.7, 0.7, 0.7);
  complexGroup.add(etaHalo);

  // =============================================================================
  // POST-PROCESSING (bloom) — optional, fails gracefully.
  // =============================================================================
  // Bloom tuning. The "complex" variants are used in step 6, where a strong
  // bloom would wash out the thin axes/grid/labels — so there we drop strength
  // near zero and raise the threshold so almost nothing blooms.
  const BLOOM_STRENGTH = 0.34;         // default soft glow (toned down)
  const BLOOM_THRESHOLD = 0.85;        // only bright emissive bits bloom
  const BLOOM_STRENGTH_COMPLEX = 0.12; // toned right down for the ℂ-plane
  const BLOOM_THRESHOLD_COMPLEX = 0.96;

  let composer = null;
  let bloomPass = null;
  let usePostFX = false;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      BLOOM_STRENGTH,   // strength — soft, not blown out
      0.6,              // radius
      BLOOM_THRESHOLD,  // threshold — only the bright emissive bits bloom
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass()); // handles tone mapping + sRGB at the end
    usePostFX = true;
  } catch (err) {
    // If anything in the post chain throws (e.g. addon API drift), drop back to
    // plain rendering. The emissive marker + halo sprite still look glowy.
    console.warn("[scene] post-processing unavailable, using plain render:", err);
    usePostFX = false;
    composer = null;
  }

  // =============================================================================
  // SIZING
  // =============================================================================
  function applySize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    resolution.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    // push the new resolution into every fat-line material
    scene.traverse((o) => {
      if (o.material && o.material.isLineMaterial) o.material.resolution.copy(resolution);
    });
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
  }
  applySize();

  // =============================================================================
  // FRAME UPDATE (the per-frame work)
  // =============================================================================

  // Cheap apparatus wrapper that swallows numeric edge-cases.
  function safeApparatus(params, t) {
    try {
      const vf = (tt) => markerPoint(tt, params);
      return apparatus(vf, t);
    } catch {
      return {
        v: [0, 0, 0], d1: [1, 0, 0], T: [1, 0, 0], N: [0, 1, 0], B: [0, 0, 1],
        rho: 0, omegaVec: [0, 0, 0], omega: 0, xi: 0, speed: 1,
      };
    }
  }

  // Compute complex collapse (re, im, rho, omega) using the apparatus fallback
  // described in CONTRACTS (complexmap.js may not exist). re/im come from the
  // in-plane voltage components; rho/omega are the geometric frequencies.
  function computeComplex(params, t) {
    const app = safeApparatus(params, t);
    return { re: app.v[0], im: app.v[1], rho: app.rho, omega: app.omega };
  }

  // Exponential smoothing toward a target — frame-rate-independent-ish.
  const approach = (cur, target, dt, rate = 6) =>
    cur + (target - cur) * (1 - Math.exp(-rate * dt));

  const _markerVec = new THREE.Vector3();
  const _o = new THREE.Vector3(0, 0, 0);

  function update(dt) {
    // 1) advance transition clocks
    if (morphState.t < 1) morphState.t = clamp(morphState.t + dt / 0.9, 0, 1);

    // 2) ease live params toward targets (slider/setConfig changes)
    let paramsMoved = false;
    for (const k of ["amp", "omega", "sigma", "pitch", "tCenter"]) {
      const next = approach(liveParams[k], targetParams[k], dt, 7);
      if (Math.abs(next - liveParams[k]) > 1e-5) paramsMoved = true;
      liveParams[k] = next;
    }

    // 3) ease visibility flags
    for (const k of Object.keys(vis)) {
      vis[k] = approach(vis[k], visTarget[k], dt, 8);
    }

    // 4) advance marker along curve (slow, premium pace)
    clockT += dt * 0.32;
    // marker parameter sweeps the window with a gentle ping-pong so it never
    // jumps at the seam of a non-periodic (spiral/helix) curve.
    const phase = (Math.sin(clockT) * 0.5 + 0.5); // 0..1 ping-pong
    const tMark = lerp(T_MIN * 0.92, T_MAX * 0.92, phase);

    // 5) rebuild the curve geometry if it's actively morphing or params moved.
    if (paramsMoved || morphState.t < 1) {
      rebuildCurve();
      if (visTarget.ribbon > 0.01 || vis.ribbon > 0.01) rebuildRibbon();
    }

    // 6) apparatus at the marker
    const app = safeApparatus(liveParams, tMark);
    const mp = markerPoint(tMark, liveParams);
    _markerVec.set(mp[0], mp[1], mp[2]);

    // ---- marker + halo ----
    markerGroup.position.copy(_markerVec);
    // gentle pulse on the emissive + halo for life
    const pulse = 1 + 0.12 * Math.sin(clockT * 4);
    markerMat.emissiveIntensity = 2.2 * pulse;
    halo.material.opacity = 0.85 * pulse;
    // when in complex mode, hide the 3-D marker (the η dot takes over)
    const m3d = 1 - vis.complex;
    markerGroup.visible = m3d > 0.02;
    markerMesh.scale.setScalar(m3d);

    // ---- voltage vector (origin → marker) ----
    if (vis.vector > 0.02) {
      vectorGroup.visible = true;
      const dir = _markerVec.clone();
      const len = dir.length();
      const u = len > 1e-6 ? dir.clone().multiplyScalar(1 / len) : new THREE.Vector3(1, 0, 0);
      const shaftEnd = u.clone().multiplyScalar(Math.max(0, len - 0.26));
      vectorLine.geometry.setPositions([0, 0, 0, shaftEnd.x, shaftEnd.y, shaftEnd.z]);
      vectorHead.position.copy(u).multiplyScalar(Math.max(0, len - 0.13));
      _q.setFromUnitVectors(_up, u);
      vectorHead.quaternion.copy(_q);
      vectorMat.opacity = vis.vector;
      vectorHeadMat.opacity = vis.vector;
      vectorHeadMat.transparent = true;
    } else {
      vectorGroup.visible = false;
    }

    // ---- Frenet triad ----
    const triadLen = 1.5;
    orientArrow(arrowT, _markerVec, arrToVec(app.T), triadLen, vis.T);
    orientArrow(arrowN, _markerVec, arrToVec(app.N), triadLen, vis.N);
    orientArrow(arrowB, _markerVec, arrToVec(app.B), triadLen, vis.B);

    // ---- osculating plane (spanned by T,N at marker) ----
    // The plane is suppressed whenever the decomposition is showing: in that
    // mode we want only the three labelled arrows, not a competing translucent
    // quad. (1 - vis.decomp) cross-fades it out as decomposition fades in.
    const planeVis = vis.plane * (1 - vis.decomp);
    if (planeVis > 0.02) {
      planeGroup.visible = true;
      planeMesh.position.copy(_markerVec);
      // Build a basis where plane normal = B. PlaneGeometry's normal is +Z, so
      // orient +Z → B.
      const B = arrToVec(app.B);
      _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), B.lengthSq() > 1e-9 ? B.normalize() : new THREE.Vector3(0, 0, 1));
      planeMesh.quaternion.copy(_q);
      planeMat.opacity = 0.14 * planeVis;
    } else {
      planeGroup.visible = false;
    }

    // ---- decomposition: v' = ρv + ω×v ----
    // In decomposition mode we want a CLEAN read: just the three labelled
    // arrows from the marker, with the osculating plane faded out (it only adds
    // clutter here). Each arrow gets a small text label parked just past its
    // tip so the picture is self-explaining.
    if (vis.decomp > 0.02) {
      decompGroup.visible = true;
      const v = arrToVec(app.v);
      const rhoV = v.clone().multiplyScalar(app.rho);          // ρ v
      const omxv = new THREE.Vector3().crossVectors(arrToVec(app.omegaVec), v); // ω × v
      const vp = arrToVec(app.d1);                              // v' (true derivative)
      // scale factor so arrows are readable (these rates can be small/large)
      const k = 0.6;
      const dirRadial = rhoV.lengthSq() > 1e-9 ? rhoV : new THREE.Vector3(1, 0, 0);
      const dirAzim   = omxv.lengthSq() > 1e-9 ? omxv : new THREE.Vector3(0, 1, 0);
      const dirSum    = vp.lengthSq()   > 1e-9 ? vp   : new THREE.Vector3(1, 0, 0);
      const lenRadial = rhoV.length() * k;
      const lenAzim   = omxv.length() * k;
      const lenSum    = vp.length()   * k;
      orientArrow(decRadial, _markerVec, dirRadial, lenRadial, vis.decomp);
      orientArrow(decAzim,   _markerVec, dirAzim,   lenAzim,   vis.decomp);
      orientArrow(decSum,    _markerVec, dirSum,    lenSum,    vis.decomp);
      // park labels a touch beyond each tip, facing the camera
      placeLabel(decLabRadial, _markerVec, dirRadial, lenRadial * vis.decomp + 0.28, vis.decomp);
      placeLabel(decLabAzim,   _markerVec, dirAzim,   lenAzim   * vis.decomp + 0.28, vis.decomp);
      placeLabel(decLabSum,    _markerVec, dirSum,    lenSum    * vis.decomp + 0.30, vis.decomp);
    } else {
      decompGroup.visible = false;
    }

    // ---- frame ribbon ----
    ribbonGroup.visible = vis.ribbon > 0.02;
    ribbonMat.opacity = 0.22 * vis.ribbon;

    // ---- axes fade ----
    axesGroup.visible = vis.axes > 0.02;
    axesGroup.traverse((o) => {
      if (o.material && o.material.isLineMaterial) o.material.opacity = (o.userData.baseOp ?? 0.5) * vis.axes;
    });

    // ---- complex plane (η = ρ + jω) ----
    if (vis.complex > 0.02) {
      complexGroup.visible = true;
      const cx = computeComplex(liveParams, tMark);
      // Map η = ρ + jω onto the plane. ρ -> x, ω -> y (scaled so the dot stays
      // in frame for typical sigma∈[-0.6,0.6], omega∈[0.2,6]). The dot visibly
      // moves as the σ (→ρ) and ω sliders change.
      const sx = clamp(cx.rho * CPLX_RE_SCALE, -CPLX_EXTENT + 0.2, CPLX_EXTENT - 0.2);
      const sy = clamp(cx.omega * CPLX_IM_SCALE, -CPLX_EXTENT + 0.2, CPLX_EXTENT - 0.2);
      etaDot.position.set(sx, sy, 0);
      etaHalo.position.set(sx, sy, 0);
      etaVec.geometry.setPositions([0, 0, 0, sx, sy, 0]);
      // label sits just beyond the dot, pushed radially outward from origin
      const r = Math.hypot(sx, sy) || 1;
      etaLabel.position.set(sx + (sx / r) * 0.4 + 0.18, sy + (sy / r) * 0.4 + 0.14, 0);
      const op = vis.complex;
      // gentle pulse, but kept low so the toned-down bloom doesn't wash it out
      etaMat.emissiveIntensity = 1.4 * (1 + 0.1 * Math.sin(clockT * 4));
      etaHaloMat.opacity = 0.55 * op;
      etaVecMat.opacity = op;
      etaLabel.material.opacity = op;
      complexAxisMatRe.opacity = 0.95 * op;
      complexAxisMatIm.opacity = 0.95 * op;
      complexGridMat.opacity = 0.18 * op;
      complexLabRe.material.opacity = op;
      complexLabIm.material.opacity = op;
    } else {
      complexGroup.visible = false;
    }

    // ---- bloom tone: dial it right down in complex mode so the axes, grid and
    // labels read clearly; restore the soft glow elsewhere. Cross-faded by
    // vis.complex so the transition is smooth.
    if (bloomPass) {
      bloomPass.strength = lerp(BLOOM_STRENGTH, BLOOM_STRENGTH_COMPLEX, vis.complex);
      bloomPass.threshold = lerp(BLOOM_THRESHOLD, BLOOM_THRESHOLD_COMPLEX, vis.complex);
    }

    // 7) camera
    orbit.tick(dt);

    // 8) render (post-fx if available, else direct)
    if (usePostFX && composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  // record axis base opacities once for the fade math above
  axesGroup.traverse((o) => {
    if (o.material && o.material.isLineMaterial) o.userData.baseOp = o.material.opacity;
  });

  // =============================================================================
  // ANIMATION LOOP
  // =============================================================================
  let rafId = 0;
  let lastT = performance.now();
  let running = true;
  function loop() {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000); // clamp big tab-switch gaps
    lastT = now;
    update(dt);
  }
  loop();

  // =============================================================================
  // RESIZE HANDLING
  // =============================================================================
  // Prefer ResizeObserver (tracks the container even when window doesn't change)
  // and also listen to window resize as a fallback.
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => applySize());
    ro.observe(container);
  }
  const onWinResize = () => applySize();
  window.addEventListener("resize", onWinResize);

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * update(partialParams) — live slider changes. Retargets curve params; the
   * frame loop eases liveParams → targetParams so sliders feel smooth.
   * Accepts any subset of {amp, omega, sigma, pitch, tCenter}.
   */
  function updateParams(partial) {
    if (!partial) return;
    for (const k of ["amp", "omega", "sigma", "pitch", "tCenter"]) {
      if (typeof partial[k] === "number" && isFinite(partial[k])) {
        targetParams[k] = partial[k];
      }
    }
  }

  /**
   * setConfig(newCfg) — full reconfigure on step change. Retargets params,
   * visibility flags, morph, and camera; everything tweens (no snapping).
   */
  function setConfig(newCfg) {
    const next = normalizeConfig(newCfg);
    config = next;

    // params → targets (eased)
    updateParams(next.params);
    targetParams.tCenter = next.params.tCenter;

    // morph: start a fresh tween from the current morph shape to the new one.
    const newMorph = next.morph;
    if (newMorph !== morphState.to) {
      morphState = { from: morphState.to, to: newMorph, t: 0 };
    }

    // visibility targets (eased fades)
    visTarget.vector  = next.show.vector ? 1 : 0;
    visTarget.T       = next.show.triad.includes("T") ? 1 : 0;
    visTarget.N       = next.show.triad.includes("N") ? 1 : 0;
    visTarget.B       = next.show.triad.includes("B") ? 1 : 0;
    visTarget.plane   = next.show.osculatingPlane ? 1 : 0;
    visTarget.decomp  = next.decomposition ? 1 : 0;
    visTarget.complex = (next.show.complexPlane || next.morph === "complex") ? 1 : 0;
    visTarget.ribbon  = next.show.frameRibbon ? 1 : 0;
    visTarget.axes    = next.show.axes ? 1 : 0;

    if (visTarget.ribbon > 0) rebuildRibbon();

    // camera: gently retarget (orbit.apply happens each tick). We don't hard-set
    // to avoid a jump; instead nudge toward provided values if present.
    if (typeof next.camera.theta === "number") orbit.theta = next.camera.theta;
    if (typeof next.camera.phi === "number") orbit.phi = next.camera.phi;
    if (typeof next.camera.radius === "number") orbit.radius = next.camera.radius;
    orbit.autoRotate = next.camera.autoRotate;
  }

  /** resize() — recompute renderer/camera/line-resolution from container size. */
  function resize() {
    applySize();
  }

  /** dispose() — tear everything down: loop, listeners, GPU resources, DOM. */
  function disposeOne(res) {
    if (!res) return;
    if (typeof res.dispose === "function") {
      try { res.dispose(); } catch { /* ignore */ }
    }
    disposables.delete(res);
  }

  function dispose() {
    running = false;
    cancelAnimationFrame(rafId);

    // listeners
    window.removeEventListener("resize", onWinResize);
    if (ro) { ro.disconnect(); ro = null; }

    // post-processing
    if (composer) {
      try {
        composer.passes.forEach((p) => { if (p.dispose) p.dispose(); });
        if (composer.renderTarget1) composer.renderTarget1.dispose();
        if (composer.renderTarget2) composer.renderTarget2.dispose();
      } catch { /* ignore */ }
      composer = null;
    }

    // all tracked geometries/materials/textures
    for (const res of Array.from(disposables)) disposeOne(res);
    disposables.clear();

    // walk the scene once more for anything we missed
    scene.traverse((o) => {
      if (o.geometry) { try { o.geometry.dispose(); } catch {} }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { try { m.dispose(); } catch {} });
      }
    });

    // renderer + canvas
    try { renderer.dispose(); } catch {}
    try { renderer.forceContextLoss?.(); } catch {}
    if (renderer.domElement && renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  // ---------------------------------------------------------------------------
  // Return the controller. Note `update` is the *public slider* API per
  // Contract B (not the per-frame internal update()).
  // ---------------------------------------------------------------------------
  return {
    update: updateParams,
    setConfig,
    resize,
    dispose,
  };
}

// =============================================================================
// HELPERS that build textures (kept at the bottom so the flow above reads top-
// down). makeGlowTexture paints a soft radial-gradient sprite used for the
// marker halo and the η dot halo.
// =============================================================================
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(0.6, "rgba(255,255,255,0.12)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// =============================================================================
// makeLabelTexture — crisp 3-D text label drawn on a transparent canvas, used
// by Sprite materials (no external font deps). We paint at high DPI, add a
// soft dark halo behind the glyphs so they stay legible against the bloom and
// bright geometry, and return both the texture and its pixel aspect so the
// sprite can be scaled without stretching.
// =============================================================================
function makeLabelTexture(text, cssColor) {
  const dpr = 3;                       // supersample for crispness
  const fontPx = 52;
  const padX = 18, padY = 12;
  const font = `700 ${fontPx}px "Segoe UI", system-ui, -apple-system, sans-serif`;

  // measure first on a scratch context
  const scratch = document.createElement("canvas").getContext("2d");
  scratch.font = font;
  const tw = Math.ceil(scratch.measureText(text).width);
  const w = tw + padX * 2;
  const h = fontPx + padY * 2;

  const canvas = document.createElement("canvas");
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // soft dark backing halo so the label reads over anything (incl. bloom)
  ctx.shadowColor = "rgba(8,11,16,0.95)";
  ctx.shadowBlur = 10;
  ctx.lineJoin = "round";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(8,11,16,0.9)";
  ctx.strokeText(text, w / 2, h / 2);
  ctx.shadowBlur = 0;

  // glyph fill in the requested palette color
  ctx.fillStyle = cssColor;
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, aspect: w / h };
}
