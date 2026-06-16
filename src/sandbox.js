// main.js — Three.js renderer.
//
// Reuses the same sidebar UI and the same maths (frenet.js / curves.js) as
// the Canvas fallback; only the drawing is WebGL via three. Requires the
// `three` package (see README / index.html import map).
//
// Pipeline:  UI params -> curves.makeCurve -> sampled curve Line +
//            frenet.apparatus (T/N/B + rho/omega/xi at the moving marker).

import * as THREE from "three";
import { Orbit } from "./orbit.js";
import * as frenet from "./frenet.js";
import { makeCurve, DEFAULTS, RANGES } from "./curves.js";

const COL = {
  bg: 0x0e1116,
  curve: 0x8d99ae,
  voltage: 0xffd166, // tangent T
  normal: 0x06d6a0,  // N
  binormal: 0xef476f, // B
  axis: 0x39404d,
};

// ---- renderer / scene / camera --------------------------------------------
const canvas = document.getElementById("scene");
const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.bg);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
const controls = new Orbit(camera, canvas);

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

// ---- axes ------------------------------------------------------------------
function makeAxes(len = 3) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: COL.axis });
  const ends = [[len, 0, 0], [0, len, 0], [0, 0, len]];
  for (const e of ends) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-e[0], -e[1], -e[2]),
      new THREE.Vector3(e[0], e[1], e[2]),
    ]);
    g.add(new THREE.Line(geo, mat));
  }
  return g;
}
scene.add(makeAxes());

// ---- curve, marker, vectors ------------------------------------------------
const params = { ...DEFAULTS };
const TMAX = 12, N_SAMPLES = 640;
const T_LO = TMAX / 2 - TMAX / 4, T_HI = TMAX / 2 + TMAX / 4;   // marker loop window
let vFunc = makeCurve({ ...params, tCenter: TMAX / 2 });

const curveLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: COL.curve }),
);
scene.add(curveLine);

function rebuild() {
  vFunc = makeCurve({ ...params, tCenter: TMAX / 2 });
  const pts = [];
  for (let i = 0; i <= N_SAMPLES; i++) {
    pts.push(new THREE.Vector3(...vFunc((i / N_SAMPLES) * TMAX)));
  }
  curveLine.geometry.dispose();
  curveLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
}
rebuild();

const marker = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 20, 20),
  new THREE.MeshBasicMaterial({ color: COL.voltage }),
);
scene.add(marker);

const vVec = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: COL.voltage, linewidth: 2 }),
);
scene.add(vVec);

const mkArrow = (c) =>
  new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, c, 0.24, 0.14);
const arrowT = mkArrow(COL.voltage);
const arrowN = mkArrow(COL.normal);
const arrowB = mkArrow(COL.binormal);
const triad = new THREE.Group();
triad.add(arrowT, arrowN, arrowB);
scene.add(triad);

// ---- UI wiring (identical ids to the Canvas version) ----------------------
let speed = 1;
for (const key of ["amp", "omega", "sigma", "pitch"]) {
  const slider = document.getElementById(`s-${key}`);
  const out = document.getElementById(`v-${key}`);
  const rng = RANGES[key];
  slider.min = rng.min; slider.max = rng.max; slider.step = rng.step;
  slider.value = params[key];
  out.textContent = Number(params[key]).toFixed(2);
  slider.addEventListener("input", () => {
    params[key] = parseFloat(slider.value);
    out.textContent = params[key].toFixed(2);
    rebuild();
  });
}

let playing = true;
const playBtn = document.getElementById("play");
playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
});
document.getElementById("show-triad").addEventListener("change", (e) => {
  triad.visible = e.target.checked;
});
document.getElementById("s-speed").addEventListener("input", (e) => {
  speed = parseFloat(e.target.value);
});

const rRho = document.getElementById("r-rho"), bRho = document.getElementById("b-rho");
const rOm = document.getElementById("r-omega"), bOm = document.getElementById("b-omega");
const rXi = document.getElementById("r-xi"), bXi = document.getElementById("b-xi");
const setReadout = (numEl, barEl, val, maxAbs) => {
  numEl.textContent = val.toFixed(2);
  barEl.style.width = Math.min(100, (Math.abs(val) / maxAbs) * 100) + "%";
};

// ---- animation loop --------------------------------------------------------
let t = TMAX / 2;
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  controls.tick(dt);

  if (playing) {
    t += dt * speed;
    if (t > T_HI) t = T_LO;
  }

  const a = frenet.apparatus(vFunc, t);
  const p = new THREE.Vector3(...a.v);

  marker.position.copy(p);
  vVec.geometry.dispose();
  vVec.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), p]);

  const L = 1.15;
  for (const [arr, key] of [[arrowT, "T"], [arrowN, "N"], [arrowB, "B"]]) {
    arr.position.copy(p);
    arr.setDirection(new THREE.Vector3(...a[key]));
    arr.setLength(L, 0.24, 0.14);
  }

  setReadout(rRho, bRho, a.rho, 1.0);
  setReadout(rOm, bOm, a.omega, 6.0);
  setReadout(rXi, bXi, a.xi, 6.0);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);
