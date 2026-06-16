// event_scene.js — "Real grid event" scene for the Complex Frequency story.
// =============================================================================
// This is the FINALE scene of the story, and it is fully 3-D + orbitable so it
// matches the look/feel of the Frenet scene (src/viz/scene.js). It plots a
// MEASURED complex-frequency disturbance on the Australian 14-generator test
// system: a 17% mechanical-power loss at the BPS generator. For each of 5 areas
// we have a measured time series of the complex frequency
//
//      η(t) = ρ(t) + j·ω(t)
//
//   ρ (s^-1, real part)  = how fast the voltage magnitude is changing,
//   ω (rad/s, imag part) = the conventional angular frequency deviation,
//   df  (Hz)             = ω / 2π  (used only for the live Δf readout).
//
// THE 3-D MAPPING (this is the teaching idea):
//   x  =  ρ   (Re, s^-1)      ← horizontal, colored as the radial token
//   y  =  ω   (Im, rad/s)     ← vertical,   colored as the azimuthal token
//   z  =  time (s)            ← depth,      muted
//
// So each area's η(t) becomes a 3-D SPACE CURVE sweeping along the time axis.
//
// HONEST EQUAL SCALE on ρ and ω: we use the SAME world-units-per-data-unit on
// BOTH the x (ρ) and y (ω) axes (`UNITS_PER_DATA` below). Because ρ stays tiny
// (~±0.15 s^-1) while ω dives to ~ -1 rad/s, the curves stay razor-thin in the
// ρ direction and plunge along ω — that's the whole point: a mechanical/active-
// power loss is almost entirely an ω event. The z/time axis gets its own,
// separate scale (chosen so the swept curve reads nicely in depth).
//
// Rendering matches scene.js: antialiased WebGL, soft 3-point-ish lighting,
// fat anti-aliased lines (Line2/LineMaterial), emissive glowing marker dots with
// tasteful UnrealBloom (graceful fallback if post-FX fails), eased motion, and a
// reusable Orbit camera (drag-rotate + wheel-zoom + idle auto-rotate). A DOM
// transport bar (play/pause + scrub + live Δf readout), styled with the design
// tokens, is overlaid on the canvas exactly like the previous version.
//
// Public API (unchanged — Contract from engine.js):
//   createEventScene(container, cfg) -> { resize(), dispose() }
//   cfg = { data: "assets/cf_fig3_data.csv" }   // path relative to site root
//
// Owner is learning Three.js, so the code is commented generously.
// =============================================================================

import * as THREE from "three";

// Fat anti-aliased lines (screen-space width in px) — the same addons scene.js
// uses, so our curves/axes look identically crisp instead of 1px gl.LINES.
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

// Post-processing for the soft glow ("bloom") on the marker dots. Wrapped in a
// try/catch at setup time so that if the addon API drifts we degrade to plain
// emissive materials rather than crashing the whole scene (same as scene.js).
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Reuse the project's Orbit helper for drag/zoom/auto-rotate — same as the
// other steps, so the camera "feel" is consistent across the whole story.
import { Orbit } from "./orbit.js";

// -----------------------------------------------------------------------------
// PALETTE — must match :root in src/ui/design.css exactly (mirrored as ints for
// THREE.Color and as CSS strings for the DOM transport + canvas-texture labels).
// -----------------------------------------------------------------------------
const PALETTE = {
  bg:      0x0e1116,
  panel:   0x12171e,
  line:    0x232b36,
  text:    0xe9eef5,
  mute:    0x93a0b4,
  accent:  0xbdb2ff,
  radial:  0x4cc9f0, // ρ — the Re axis
  azimuth: 0x06d6a0, // ω — the Im axis
  torsion: 0xef476f,
  tangent: 0xffd166,
};

// CSS-string versions for the DOM transport bar.
const CSS = {
  bg:     "#0e1116",
  panel:  "#12171e",
  line:   "#232b36",
  text:   "#e9eef5",
  mute:   "#93a0b4",
  accent: "#bdb2ff",
};

// Categorical colors for the 5 areas (per spec), drawn from the palette tokens.
const AREA_COLORS = [0xffd166, 0x4cc9f0, 0x06d6a0, 0xef476f, 0xbdb2ff];

// -----------------------------------------------------------------------------
// Small helpers (kept local so the module is self-contained, mirroring scene.js).
// -----------------------------------------------------------------------------
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const hexToCss = (hex) => "#" + hex.toString(16).padStart(6, "0");

// =============================================================================
// createEventScene — the only export.
// =============================================================================
/**
 * @param {HTMLElement} container the #scene-host element to mount into
 * @param {{data?:string}} cfg    scene config; cfg.data = CSV path (site-root-relative)
 * @returns {{resize:Function, dispose:Function}}
 */
export function createEventScene(container, cfg) {
  // -- guard the inputs so a bad call never throws --------------------------
  if (!container) return { resize() {}, dispose() {} };
  const dataPath = (cfg && cfg.data) || "assets/cf_fig3_data.csv";

  // ---- 0. Per-instance state -----------------------------------------------
  let disposed = false;     // becomes true after dispose(); blocks late callbacks
  let rafId = 0;            // requestAnimationFrame handle (for cancellation)
  let running = true;

  // Parsed dataset, filled after fetch resolves:
  //   data = { t:Float64[], areas:[{rho,omega,df}], dt, n, tMin, tMax, omegaMax, rhoMax }
  let data = null;

  // Playback state.
  let playing = true;       // start playing per spec
  let playhead = 0;         // fractional sample index (smooth between rows)
  const PLAYBACK_RATE = 1.4;// data-seconds per wall-second (a touch faster than real time)

  // The five 3-D trajectories + their moving dots, created once data arrives.
  let curves = [];          // [{ line:Line2, mat:LineMaterial }]
  let dots = [];            // [{ group, mesh, halo, mat, haloMat }]
  let curvesBuilt = false;

  // ---- 1. Renderer (identical setup to scene.js) ---------------------------
  // antialias + clamped DPR = crisp without melting low-end GPUs. alpha:true so
  // the CSS radial-gradient backdrop shows through and the 3-D blends into the
  // page. ACES tone mapping + sRGB output = the premium filmic look.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";

  // ---- DOM scaffold: a wrapper holding the canvas + the transport overlay --
  // We inject ONE wrapper into the container so dispose() can remove the whole
  // subtree (canvas + transport) in a single shot.
  const rootEl = document.createElement("div");
  rootEl.style.cssText = [
    "position:relative",
    "width:100%",
    "height:100%",
    "min-height:320px",
    "overflow:hidden",
    `font-family:"Segoe UI", system-ui, -apple-system, Roboto, sans-serif`,
    `color:${CSS.text}`,
    // a subtle radial backdrop echoing #scene-host in design.css
    `background:radial-gradient(1100px 760px at 55% 40%, #161d27 0%, ${CSS.bg} 62%), ${CSS.bg}`,
  ].join(";");
  rootEl.appendChild(renderer.domElement);
  container.appendChild(rootEl);

  // ---- 2. Scene + camera ---------------------------------------------------
  const scene = new THREE.Scene();
  // A faint fog tints distant geometry toward bg → depth cue (longer range than
  // scene.js because our scene is bigger along the time/z axis).
  scene.fog = new THREE.Fog(PALETTE.bg, 22, 60);

  const camera = new THREE.PerspectiveCamera(
    42,                                       // slightly long lens = elegant
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
    0.1,
    200,
  );

  // ---- 3. WORLD MAPPING constants (the heart of the scene) -----------------
  // EQUAL SCALE on ρ (x) and ω (y): one shared world-units-per-data-unit.
  // ω dives to ~ -1 rad/s, so we pick the scale so |ω|≈1 spans ~6 world units of
  // height — readable but not huge. ρ then uses the SAME factor and stays tiny.
  const UNITS_PER_DATA = 6.0;   // world units per (s^-1) for ρ AND per (rad/s) for ω

  // The z/time axis gets its OWN, independent scale (this is allowed — only ρ/ω
  // must share). We map the full t-range [0.8 .. 12.0] s onto a fixed depth so
  // the swept curve reads well regardless of how many samples there are.
  const TIME_DEPTH = 22.0;      // total world length of the time axis

  // Helpers turning data values into world coordinates. tMin/tMax come from data.
  const rhoToX = (rho) => rho * UNITS_PER_DATA;
  const omegaToY = (om) => om * UNITS_PER_DATA;
  let timeToZ = (t) => t;       // replaced once data (tMin/tMax) is known

  // Where the swept "now" plane / dots currently sit along z.
  let curZ = 0;

  // ---- Orbit camera (reused helper) ----------------------------------------
  // We orbit around the MIDDLE of the time axis (z = TIME_DEPTH/2) so the whole
  // swept ribbon stays framed. Seed a pleasant 3/4 view and a radius that fits
  // the long z-extent, then let it idle-auto-rotate like the other steps.
  const orbitTarget = new THREE.Vector3(0, 0, TIME_DEPTH * 0.5);
  const orbit = new Orbit(camera, renderer.domElement, orbitTarget);
  orbit.radius = 30;
  orbit.maxRadius = 70;
  orbit.minRadius = 8;
  orbit.theta = 0.78;
  orbit.phi = 1.18;
  orbit.autoRotate = true;
  orbit.autoSpeed = 0.16; // gentle
  orbit.apply();

  // ---- 4. Lighting (soft hemisphere + key/fill/rim = 3-point-ish) ----------
  // Same recipe as scene.js so the materials shade identically.
  const hemi = new THREE.HemisphereLight(0xbfd2ff, 0x0b0e13, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(6, 9, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.45);
  fill.position.set(-7, 3, -4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(PALETTE.accent, 0.5);
  rim.position.set(0, -4, -8);
  scene.add(rim);

  // ---- 5. Fat-line plumbing ------------------------------------------------
  // Line2 needs the renderer resolution in pixels to size screen-space widths.
  const resolution = new THREE.Vector2(1, 1);
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

  // ---- Disposable tracking (exhaustive, leak-free dispose like scene.js) ---
  const disposables = new Set();
  const track = (obj) => { if (obj) disposables.add(obj); return obj; };

  // ---- Root group so everything tears down / transforms together ----------
  const root = new THREE.Group();
  scene.add(root);

  const frameGroup = new THREE.Group();   // axes + grid + labels + sweep plane
  const curvesGroup = new THREE.Group();  // the 5 trajectories
  const dotsGroup = new THREE.Group();    // the 5 moving markers (bloom targets)
  root.add(frameGroup, curvesGroup, dotsGroup);

  // ---- Camera-facing text labels via Sprite + CanvasTexture (no font deps) -
  // Identical technique to scene.js: paint at high DPI with a dark backing halo
  // so labels read over bright geometry and bloom.
  function makeLabel(text, colorHex, worldHeight = 0.9) {
    const { tex, aspect } = makeLabelTexture(text, hexToCss(colorHex));
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,  // labels float above geometry so they never clip
      depthWrite: false,
      opacity: 1,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(worldHeight * aspect, worldHeight, 1);
    sprite.renderOrder = 10;
    track(tex); track(mat);
    return sprite;
  }

  // A soft radial-gradient sprite texture, shared by every dot halo.
  const haloTex = track(makeGlowTexture());

  // =============================================================================
  // 6) THE 3-D FRAME: axes, ρ–ω reference grid, sweeping "now" plane, labels.
  //    Built once data dimensions are known (we need tMin/tMax to size z).
  // =============================================================================
  let sweepPlane = null;       // translucent ρ–ω quad that rides along z at "now"
  let sweepGridLines = [];     // the faint grid drawn ON the sweep plane

  function buildFrame() {
    // ρ/ω half-extents in WORLD units. We give ω plenty of room (it's the big
    // mover, diving to ~ -1) and ρ a smaller, honest box. Because both use the
    // SAME UNITS_PER_DATA, the ρ box being narrower simply reflects that ρ data
    // is tiny — that's the honest point, not a scale cheat.
    const omegaHalf = 1.15 * UNITS_PER_DATA; // ω in roughly [-1.15 .. +1.15] rad/s
    const rhoHalf = 0.32 * UNITS_PER_DATA;   // ρ in roughly [-0.32 .. +0.32] s^-1
    const z0 = timeToZ(data.tMin);
    const z1 = timeToZ(data.tMax);

    // ---- (a) The three primary axis lines (fat, low opacity) --------------
    // ρ (x) axis — radial color; ω (y) axis — azimuth color; time (z) — muted.
    const axisDefs = [
      // along x at the origin (ρ axis): from -rhoHalf..+rhoHalf
      { from: [-rhoHalf, 0, z0], to: [rhoHalf, 0, z0], color: PALETTE.radial, op: 0.8 },
      // along y at the origin (ω axis)
      { from: [0, -omegaHalf, z0], to: [0, omegaHalf, z0], color: PALETTE.azimuth, op: 0.8 },
      // along z (time axis), drawn at the origin of the ρ–ω plane
      { from: [0, 0, z0], to: [0, 0, z1], color: PALETTE.mute, op: 0.6 },
    ];
    for (const a of axisDefs) {
      const geo = track(new LineGeometry());
      geo.setPositions([...a.from, ...a.to]);
      const mat = track(fatLineMaterial(a.color, 2.0, a.op));
      frameGroup.add(new Line2(geo, mat));
    }

    // ---- (b) Faint ρ–ω reference grid at the BACK (t = tMin) plane --------
    // A static grid at the start-of-event plane gives the eye a reference for
    // the ρ–ω box without cluttering the whole volume.
    const gridMat = track(fatLineMaterial(PALETTE.line, 1.0, 0.35));
    const rhoStep = 0.1 * UNITS_PER_DATA;   // gridline every 0.1 s^-1 in ρ
    const omStep = 0.25 * UNITS_PER_DATA;   // gridline every 0.25 rad/s in ω
    // vertical lines (constant ρ)
    for (let x = -rhoHalf; x <= rhoHalf + 1e-6; x += rhoStep) {
      if (Math.abs(x) < 1e-6) continue; // the colored axis covers ρ=0
      const g = track(new LineGeometry());
      g.setPositions([x, -omegaHalf, z0, x, omegaHalf, z0]);
      frameGroup.add(new Line2(g, gridMat));
    }
    // horizontal lines (constant ω)
    for (let y = -omegaHalf; y <= omegaHalf + 1e-6; y += omStep) {
      if (Math.abs(y) < 1e-6) continue;
      const g = track(new LineGeometry());
      g.setPositions([-rhoHalf, y, z0, rhoHalf, y, z0]);
      frameGroup.add(new Line2(g, gridMat));
    }

    // ---- (c) Time tick marks + labels along the z axis --------------------
    // A small tick + a numeric label every ~2 seconds so the depth axis is
    // legible (otherwise z is just an unlabeled void).
    const tickMat = track(fatLineMaterial(PALETTE.mute, 1.2, 0.5));
    for (let tSec = Math.ceil(data.tMin); tSec <= data.tMax + 1e-6; tSec += 2) {
      const z = timeToZ(tSec);
      const g = track(new LineGeometry());
      g.setPositions([0, 0, z, 0, -0.35 * UNITS_PER_DATA, z]); // tick hangs below
      frameGroup.add(new Line2(g, tickMat));
      const lab = makeLabel(tSec.toFixed(0) + "s", PALETTE.mute, 0.7);
      lab.position.set(0, -0.45 * UNITS_PER_DATA, z);
      frameGroup.add(lab);
    }

    // ---- (d) Axis title labels --------------------------------------------
    const labRe = makeLabel("Re = ρ", PALETTE.radial, 1.0);
    labRe.position.set(rhoHalf + 0.9, 0, z0);
    frameGroup.add(labRe);

    const labIm = makeLabel("Im = ω", PALETTE.azimuth, 1.0);
    labIm.position.set(0, omegaHalf + 0.9, z0);
    frameGroup.add(labIm);

    const labTime = makeLabel("time", PALETTE.mute, 1.0);
    labTime.position.set(0, 0, z1 + 1.2);
    frameGroup.add(labTime);

    // ---- (e) The translucent "now" plane that sweeps along z --------------
    // A double-sided ρ–ω quad spanning the box; we move its z each frame to the
    // current time so it reads as the moment being measured. It carries a faint
    // grid of its own so it looks like a real slice, not just a sheet.
    const planeW = 2 * rhoHalf;
    const planeH = 2 * omegaHalf;
    const planeGeo = track(new THREE.PlaneGeometry(planeW, planeH));
    const planeMat = track(new THREE.MeshStandardMaterial({
      color: PALETTE.accent,
      transparent: true,
      opacity: 0.06,        // very faint — it's a hint, not a wall
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.0,
      depthWrite: false,    // so curves behind it still show
    }));
    sweepPlane = new THREE.Mesh(planeGeo, planeMat);
    frameGroup.add(sweepPlane);

    // A faint outline + cross on the sweep plane (drawn as its own fat lines,
    // parented to the plane so they ride along with it).
    sweepGridLines = [];
    const outlineMat = track(fatLineMaterial(PALETTE.accent, 1.4, 0.4));
    const outlineGeo = track(new LineGeometry());
    outlineGeo.setPositions([
      -rhoHalf, -omegaHalf, 0,  rhoHalf, -omegaHalf, 0,
       rhoHalf,  omegaHalf, 0, -rhoHalf,  omegaHalf, 0,
      -rhoHalf, -omegaHalf, 0,
    ]);
    const outline = new Line2(outlineGeo, outlineMat);
    sweepPlane.add(outline);
    sweepGridLines.push({ mat: outlineMat });
  }

  // =============================================================================
  // 7) THE TRAJECTORIES + MOVING DOTS, built once data arrives.
  // =============================================================================
  function buildCurves() {
    for (let a = 0; a < 5; a++) {
      const area = data.areas[a];
      const colorHex = AREA_COLORS[a];

      // -- the fat 3-D space curve (full trajectory, drawn at modest opacity so
      //    the bright moving dot reads clearly against it) -------------------
      const positions = [];
      for (let i = 0; i < data.n; i++) {
        positions.push(rhoToX(area.rho[i]), omegaToY(area.omega[i]), timeToZ(data.t[i]));
      }
      const geo = track(new LineGeometry());
      geo.setPositions(positions);
      const mat = track(fatLineMaterial(colorHex, 3.0, 0.92));
      const line = new Line2(geo, mat);
      line.computeLineDistances();
      curvesGroup.add(line);
      curves.push({ line, mat });

      // -- the moving dot: emissive sphere (bloom target) + additive halo ----
      const g = new THREE.Group();
      const meshGeo = track(new THREE.SphereGeometry(0.16, 28, 28));
      const meshMat = track(new THREE.MeshStandardMaterial({
        color: PALETTE.text,
        emissive: new THREE.Color(colorHex),
        emissiveIntensity: 1.5,
        roughness: 0.25,
        metalness: 0.0,
      }));
      const mesh = new THREE.Mesh(meshGeo, meshMat);
      g.add(mesh);

      const haloMat = track(new THREE.SpriteMaterial({
        map: haloTex,
        color: colorHex,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      const halo = new THREE.Sprite(haloMat);
      halo.scale.set(0.9, 0.9, 0.9);
      g.add(halo);

      dotsGroup.add(g);
      dots.push({ group: g, mesh, halo, mat: meshMat, haloMat });
    }
    curvesBuilt = true;
  }

  // =============================================================================
  // 8) POST-PROCESSING (bloom) — optional, fails gracefully (mirrors scene.js).
  // =============================================================================
  const BLOOM_STRENGTH = 0.42;  // soft glow on the bright dots
  const BLOOM_RADIUS = 0.62;
  const BLOOM_THRESHOLD = 0.82; // only the bright emissive dots bloom

  let composer = null;
  let bloomPass = null;
  let usePostFX = false;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass()); // tone mapping + sRGB at the end
    usePostFX = true;
  } catch (err) {
    // Drop back to plain rendering; emissive dots + halos still read as glow.
    console.warn("[event_scene] post-processing unavailable, using plain render:", err);
    usePostFX = false;
    composer = null;
  }

  // =============================================================================
  // 9) SIZING (renderer + camera + fat-line resolution + composer).
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

  // =============================================================================
  // 10) THE DOM TRANSPORT BAR (play/pause + scrub + readouts), palette-styled.
  // =============================================================================
  let transport = null, playBtn = null, slider = null, timeReadout = null, freqReadout = null;
  let styleEl = null;

  // Track every listener so dispose() can detach them all.
  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  };

  function buildTransport() {
    transport = document.createElement("div");
    transport.style.cssText = [
      "position:absolute",
      "left:50%",
      "bottom:18px",
      "transform:translateX(-50%)",
      "display:flex",
      "align-items:center",
      "gap:14px",
      "padding:10px 16px",
      "max-width:calc(100% - 32px)",
      "box-sizing:border-box",
      "z-index:2",
      // glassy pill, matching #stepnav in design.css
      `background:${CSS.panel}cc`,
      `border:1px solid ${CSS.line}`,
      "border-radius:999px",
      "box-shadow:0 8px 24px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.05)",
      "backdrop-filter:blur(14px) saturate(130%)",
      "-webkit-backdrop-filter:blur(14px) saturate(130%)",
      "font-size:13px",
    ].join(";");

    // play / pause button
    playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.setAttribute("aria-label", "Play or pause");
    playBtn.style.cssText = [
      "flex:none", "width:36px", "height:36px", "border-radius:50%",
      "display:inline-flex", "align-items:center", "justify-content:center",
      "background:rgba(255,255,255,.04)", `color:${CSS.text}`,
      `border:1px solid ${CSS.line}`, "font-size:14px", "line-height:1", "cursor:pointer",
    ].join(";");
    syncPlayButton();
    on(playBtn, "click", () => setPlaying(!playing));

    // scrubber (range over time)
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1000"; // mapped 0..1000 -> 0..(n-1) for fine resolution
    slider.value = "0";
    slider.step = "1";
    slider.setAttribute("aria-label", "Scrub through time");
    slider.style.cssText = [
      "flex:1 1 220px", "min-width:140px", "height:6px",
      "-webkit-appearance:none", "appearance:none", "border-radius:3px",
      "background:#1c2430", `border:1px solid ${CSS.line}`, "outline:none", "cursor:pointer",
    ].join(";");
    on(slider, "input", () => {
      if (!data) return;
      const frac = Number(slider.value) / 1000;
      playhead = frac * (data.n - 1);
      setPlaying(false); // pause while scrubbing for a predictable feel
    });

    // time readout
    timeReadout = document.createElement("span");
    timeReadout.style.cssText = [
      "flex:none", "font-variant-numeric:tabular-nums", `color:${CSS.text}`,
      "min-width:64px", "text-align:right", "font-weight:600",
    ].join(";");
    timeReadout.textContent = "t = —";

    // live Δf readout (min Δf nadir + spread across the 5 areas)
    freqReadout = document.createElement("span");
    freqReadout.style.cssText = [
      "flex:none", "font-variant-numeric:tabular-nums", `color:${CSS.mute}`,
      "min-width:170px", "white-space:nowrap",
    ].join(";");
    freqReadout.textContent = "Δf —";

    transport.append(playBtn, slider, timeReadout, freqReadout);
    injectSliderThumbStyle();
    rootEl.appendChild(transport);
  }

  // The range thumb can't be styled inline, so add a small scoped <style>.
  function injectSliderThumbStyle() {
    const cls = "cf-event-scrub";
    slider.classList.add(cls);
    styleEl = document.createElement("style");
    styleEl.textContent = `
      .${cls}::-webkit-slider-thumb{
        -webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;
        background:${CSS.accent};border:2px solid ${CSS.bg};
        box-shadow:0 0 0 1px ${CSS.accent},0 0 12px rgba(189,178,255,.5);cursor:pointer;
      }
      .${cls}::-moz-range-thumb{
        width:16px;height:16px;border-radius:50%;background:${CSS.accent};
        border:2px solid ${CSS.bg};cursor:pointer;
        box-shadow:0 0 0 1px ${CSS.accent},0 0 12px rgba(189,178,255,.5);
      }
      .${cls}:focus-visible{border-color:${CSS.accent};}
    `;
    document.head.appendChild(styleEl);
  }

  function syncPlayButton() {
    if (!playBtn) return;
    playBtn.textContent = playing ? "❚❚" : "▶";
    playBtn.title = playing ? "Pause" : "Play";
  }
  function setPlaying(next) {
    playing = next;
    syncPlayButton();
  }

  // =============================================================================
  // 11) THE DOM LEGEND (Area 1..5 swatches), styled to the palette.
  // =============================================================================
  let legendEl = null;
  function buildLegend() {
    legendEl = document.createElement("div");
    legendEl.style.cssText = [
      "position:absolute", "left:16px", "top:14px", "z-index:2",
      "display:flex", "flex-direction:column", "gap:6px",
      "padding:10px 12px",
      `background:${CSS.panel}b3`, `border:1px solid ${CSS.line}`, "border-radius:10px",
      "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
      "font-size:12px", `color:${CSS.text}`, "pointer-events:none",
    ].join(";");
    for (let a = 0; a < 5; a++) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px";
      const sw = document.createElement("span");
      sw.style.cssText =
        `width:11px;height:11px;border-radius:50%;flex:none;background:${hexToCss(AREA_COLORS[a])};` +
        `box-shadow:0 0 8px ${hexToCss(AREA_COLORS[a])}99`;
      const txt = document.createElement("span");
      txt.textContent = "Area " + (a + 1);
      row.append(sw, txt);
      legendEl.appendChild(row);
    }
    rootEl.appendChild(legendEl);
  }

  // A small status/error message overlay (loading + fetch failure handling).
  let msgEl = null;
  function showMessage(msg) {
    if (!msgEl) {
      msgEl = document.createElement("div");
      msgEl.style.cssText = [
        "position:absolute", "left:50%", "top:50%", "transform:translate(-50%,-50%)",
        "z-index:3", `color:${CSS.mute}`, "font-size:15px", "text-align:center",
        "max-width:80%", "pointer-events:none",
      ].join(";");
      rootEl.appendChild(msgEl);
    }
    msgEl.textContent = msg;
    msgEl.style.display = "block";
  }
  function hideMessage() { if (msgEl) msgEl.style.display = "none"; }

  // =============================================================================
  // 12) FETCH + PARSE THE CSV.
  // =============================================================================
  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error("CSV has no data rows");
    const header = lines[0].split(",").map((s) => s.trim());
    const col = {};
    header.forEach((name, i) => { col[name] = i; });

    // Confirm the columns we need exist.
    const need = ["time_s"];
    for (let a = 1; a <= 5; a++) {
      need.push(`rho_Area${a}_per_s`, `omega_Area${a}_rad_per_s`, `df_Area${a}_Hz`);
    }
    for (const name of need) {
      if (!(name in col)) throw new Error("CSV missing column: " + name);
    }

    const n = lines.length - 1;
    const t = new Float64Array(n);
    const areas = [];
    for (let a = 0; a < 5; a++) {
      areas.push({ rho: new Float64Array(n), omega: new Float64Array(n), df: new Float64Array(n) });
    }
    for (let r = 0; r < n; r++) {
      const cells = lines[r + 1].split(",");
      t[r] = Number(cells[col["time_s"]]);
      for (let a = 0; a < 5; a++) {
        areas[a].rho[r] = Number(cells[col[`rho_Area${a + 1}_per_s`]]);
        areas[a].omega[r] = Number(cells[col[`omega_Area${a + 1}_rad_per_s`]]);
        areas[a].df[r] = Number(cells[col[`df_Area${a + 1}_Hz`]]);
      }
    }
    const dt = n > 1 ? t[1] - t[0] : 0.01;

    // Global extents (drive frame sizing). |ρ|, |ω| maxima across all areas.
    let rhoMax = 0, omegaMax = 0;
    for (let a = 0; a < 5; a++) {
      for (let r = 0; r < n; r++) {
        rhoMax = Math.max(rhoMax, Math.abs(areas[a].rho[r]));
        omegaMax = Math.max(omegaMax, Math.abs(areas[a].omega[r]));
      }
    }
    return { t, areas, dt, n, tMin: t[0], tMax: t[n - 1], rhoMax, omegaMax };
  }

  function loadData() {
    showMessage("Loading grid-event data…");
    fetch(dataPath)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + dataPath);
        return res.text();
      })
      .then((text) => {
        if (disposed) return; // disposed while fetching
        data = parseCsv(text);

        // Now that tMin/tMax are known, define the time→z mapping and re-centre
        // the orbit target on the middle of the (now correctly-sized) z axis.
        const span = Math.max(1e-6, data.tMax - data.tMin);
        timeToZ = (tt) => ((tt - data.tMin) / span) * TIME_DEPTH;
        orbitTarget.set(0, 0, TIME_DEPTH * 0.5);

        buildFrame();
        buildCurves();
        hideMessage();
        applySize(); // make sure fat-line resolution is set on the new geometry
      })
      .catch((err) => {
        if (disposed) return;
        showMessage("Could not load data: " + (err && err.message ? err.message : err));
      });
  }

  // =============================================================================
  // 13) PER-FRAME UPDATE.
  // =============================================================================
  const _tmp = new THREE.Vector3();

  function update(dt) {
    // -- advance playhead (looping) when playing --------------------------
    if (playing && data) {
      const advanceSamples = (dt * PLAYBACK_RATE) / data.dt;
      playhead += advanceSamples;
      if (playhead >= data.n - 1) playhead = 0; // loop
    }

    // -- move the dots + sweep plane + readouts if data is ready ----------
    if (curvesBuilt && data) {
      const headIndex = clamp(Math.floor(playhead), 0, data.n - 1);
      const next = Math.min(data.n - 1, headIndex + 1);
      const frac = playhead - headIndex; // 0..1 within the current step

      // current time + its z so the sweep plane and dots agree
      const tNow = lerp(data.t[headIndex], data.t[next], frac);
      curZ = timeToZ(tNow);

      // gentle shared pulse for life on the emissive dots
      const pulse = 1 + 0.12 * Math.sin(performance.now() * 0.004);

      for (let a = 0; a < 5; a++) {
        const area = data.areas[a];
        const rho = lerp(area.rho[headIndex], area.rho[next], frac);
        const om = lerp(area.omega[headIndex], area.omega[next], frac);
        const d = dots[a];
        d.group.position.set(rhoToX(rho), omegaToY(om), curZ);
        d.mat.emissiveIntensity = 1.7 * pulse;
        d.haloMat.opacity = 0.6 * pulse;
        // keep the halo facing the camera at a steady on-screen size
        d.halo.scale.setScalar(0.95);
      }

      // sweep plane rides to the current z
      if (sweepPlane) {
        sweepPlane.position.set(0, 0, curZ);
        // faint breathing on its opacity so it feels alive but stays subtle
        sweepPlane.material.opacity = 0.05 + 0.02 * (0.5 + 0.5 * Math.sin(performance.now() * 0.0016));
      }

      updateTransport(headIndex, tNow);
    }

    // -- camera (idle auto-rotate + user drag/zoom handled inside) ---------
    orbit.target.copy(orbitTarget);
    orbit.tick(dt);

    // -- render (post-fx if available, else direct) -----------------------
    if (usePostFX && composer) composer.render();
    else renderer.render(scene, camera);
  }

  // Update the transport readouts + slider from the current playhead.
  function updateTransport(headIndex, tNow) {
    if (!data) return;
    if (timeReadout) timeReadout.textContent = "t = " + tNow.toFixed(2) + " s";

    // Live Δf: deepest nadir right now + the spread across the 5 areas.
    let minDf = Infinity, maxDf = -Infinity;
    for (let a = 0; a < 5; a++) {
      const v = data.areas[a].df[headIndex];
      if (v < minDf) minDf = v;
      if (v > maxDf) maxDf = v;
    }
    if (freqReadout) {
      const sgnMin = minDf >= 0 ? " " : "";
      freqReadout.textContent =
        "Δf min " + sgnMin + minDf.toFixed(3) + " Hz · spread " + (maxDf - minDf).toFixed(3) + " Hz";
    }
    // Sync slider position (setting .value doesn't fire input, so no feedback loop).
    if (slider) slider.value = String(Math.round((headIndex / (data.n - 1)) * 1000));
  }

  // =============================================================================
  // 14) ANIMATION LOOP (RAF with clamped dt, exactly like scene.js).
  // =============================================================================
  let lastT = performance.now();
  function loop() {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000); // clamp big tab-switch gaps
    lastT = now;
    update(dt);
  }

  // =============================================================================
  // 15) RESIZE HANDLING (ResizeObserver + window resize fallback).
  // =============================================================================
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => { if (!disposed) applySize(); });
    ro.observe(container);
  }
  on(window, "resize", () => { if (!disposed) applySize(); });

  // =============================================================================
  // 16) BOOTSTRAP.
  // =============================================================================
  buildLegend();
  buildTransport();
  applySize();
  loadData();
  loop();

  // =============================================================================
  // 17) PUBLIC API.
  // =============================================================================
  function disposeOne(res) {
    if (!res) return;
    if (typeof res.dispose === "function") {
      try { res.dispose(); } catch { /* ignore */ }
    }
    disposables.delete(res);
  }

  return {
    /** resize() — recompute renderer/camera/line-resolution from container size. */
    resize() {
      if (!disposed) applySize();
    },

    /** dispose() — cancel RAF, remove DOM + listeners, free GPU resources. */
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(rafId);

      // listeners (window + DOM transport)
      for (const { target, type, fn, opts } of listeners) {
        try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ }
      }
      listeners.length = 0;
      if (ro) { ro.disconnect(); ro = null; }

      // post-processing render targets/passes
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

      // remove the injected slider <style>
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;

      // renderer + canvas
      try { renderer.dispose(); } catch {}
      try { renderer.forceContextLoss?.(); } catch {}

      // remove the whole DOM subtree we created (canvas + transport + legend)
      if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);

      // null out big references to help GC
      curves = [];
      dots = [];
      data = null;
    },
  };
}

// =============================================================================
// TEXTURE/LABEL HELPERS (kept at the bottom so the flow above reads top-down).
// Identical techniques to scene.js so the look matches exactly.
// =============================================================================

// A soft radial-gradient sprite texture, used for the glowing dot halos.
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

// Crisp 3-D text label on a transparent canvas, used by Sprite materials (no
// external font deps). High-DPI with a dark backing halo so labels read over
// bright geometry + bloom. Returns the texture and its pixel aspect ratio.
function makeLabelTexture(text, cssColor) {
  const dpr = 3;
  const fontPx = 52;
  const padX = 18, padY = 12;
  const font = `700 ${fontPx}px "Segoe UI", system-ui, -apple-system, sans-serif`;

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
