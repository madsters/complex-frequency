// main.js — interactive visualization on the built-in Canvas 2D API.
// No third-party packages: the 3D look comes from a small hand-written
// orthographic projection (yaw/pitch/zoom), so it runs the moment you serve
// the folder — nothing to install.
//
// Pipeline:  UI params -> curves.makeCurve -> sampled curve + frenet.apparatus
//            (T/N/B and rho/omega/xi at the moving point), redrawn each frame.

import * as frenet from "./frenet.js";
import { makeCurve, DEFAULTS, RANGES } from "./curves.js";

// palette (matches the manim theme)
const COL = {
  curve: "#8d99ae",
  voltage: "#ffd166", // tangent T
  normal: "#06d6a0",  // N
  binormal: "#ef476f", // B
  radial: "#4cc9f0",
  azimuth: "#06d6a0",
  torsion: "#ef476f",
  axis: "#39404d",
  axisText: "#5c677d",
};

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");

// ---- canvas sizing (devicePixelRatio aware) -------------------------------
let W = 0, H = 0;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = stage.clientWidth;
  H = stage.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);

// ---- camera (orbit) --------------------------------------------------------
let yaw = 0.9, pitch = 0.5, zoom = 78;   // zoom = pixels per world unit
let autoRotate = true;

// project a world point [x,y,z] to screen + depth (for ordering / fading)
function project(p) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = p[0] * cy + p[2] * sy;
  const z1 = -p[0] * sy + p[2] * cy;
  const y1 = p[1];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;     // depth (larger = nearer camera)
  return { x: W / 2 + x1 * zoom, y: H / 2 - y2 * zoom, depth: z2 };
}

// ---- mouse / touch orbit + zoom -------------------------------------------
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true; autoRotate = false;
  lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false; canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw += (e.clientX - lastX) * 0.008;
  pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - lastY) * 0.008));
  lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoom = Math.max(28, Math.min(180, zoom * (1 - Math.sign(e.deltaY) * 0.08)));
}, { passive: false });

// ---- drawing helpers -------------------------------------------------------
function line(a, b, color, width = 1.5, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function arrow(from3, to3, color, width = 3) {
  const a = project(from3), b = project(to3);
  line(a, b, color, width);
  // arrow head
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const s = 9;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - s * Math.cos(ang - 0.4), b.y - s * Math.sin(ang - 0.4));
  ctx.lineTo(b.x - s * Math.cos(ang + 0.4), b.y - s * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

function drawAxes() {
  const L = 3;
  const axes = [
    { a: [-L, 0, 0], b: [L, 0, 0], label: "x", at: [L + 0.25, 0, 0] },
    { a: [0, -L, 0], b: [0, L, 0], label: "y", at: [0, L + 0.25, 0] },
    { a: [0, 0, -L], b: [0, 0, L], label: "z", at: [0, 0, L + 0.25] },
  ];
  ctx.font = "13px 'Segoe UI', sans-serif";
  for (const ax of axes) {
    line(project(ax.a), project(ax.b), COL.axis, 1.2, 0.9);
    const t = project(ax.at);
    ctx.fillStyle = COL.axisText;
    ctx.fillText(ax.label, t.x - 4, t.y + 4);
  }
}

// ---- parameter state + curve sampling -------------------------------------
const params = { ...DEFAULTS };
const TMAX = 12, N_SAMPLES = 640;
let vFunc = makeCurve({ ...params, tCenter: TMAX / 2 });
let samples = [];

function rebuild() {
  vFunc = makeCurve({ ...params, tCenter: TMAX / 2 });
  samples = [];
  for (let i = 0; i <= N_SAMPLES; i++) {
    samples.push(vFunc((i / N_SAMPLES) * TMAX));
  }
}
rebuild();

function drawCurve() {
  // project all, find depth range for fog/fade
  let lo = Infinity, hi = -Infinity;
  const pr = samples.map((p) => {
    const q = project(p);
    if (q.depth < lo) lo = q.depth;
    if (q.depth > hi) hi = q.depth;
    return q;
  });
  const span = hi - lo || 1;
  for (let i = 1; i < pr.length; i++) {
    const d = (pr[i].depth - lo) / span;          // 0 far .. 1 near
    line(pr[i - 1], pr[i], COL.curve, 1 + 1.6 * d, 0.25 + 0.75 * d);
  }
}

// ---- UI wiring -------------------------------------------------------------
let showTriad = true;
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

const playBtn = document.getElementById("play");
let playing = true;
playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
});
document.getElementById("show-triad").addEventListener("change", (e) => {
  showTriad = e.target.checked;
});
document.getElementById("s-speed").addEventListener("input", (e) => {
  speed = parseFloat(e.target.value);
});

const rRho = document.getElementById("r-rho");
const rOm = document.getElementById("r-omega");
const rXi = document.getElementById("r-xi");
const bRho = document.getElementById("b-rho");
const bOm = document.getElementById("b-omega");
const bXi = document.getElementById("b-xi");
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

  if (autoRotate) yaw += dt * 0.25;
  if (playing) {
    t += dt * speed;
    const lo = TMAX / 2 - TMAX / 4, hi = TMAX / 2 + TMAX / 4;
    if (t > hi) t = lo;
  }

  const a = frenet.apparatus(vFunc, t);
  const p = a.v;

  // clear
  ctx.clearRect(0, 0, W, H);

  drawAxes();
  drawCurve();

  // voltage vector (origin -> point)
  arrow([0, 0, 0], p, COL.voltage, 3.5);

  // Frenet triad
  if (showTriad) {
    const L = 1.15;
    arrow(p, [p[0] + L * a.T[0], p[1] + L * a.T[1], p[2] + L * a.T[2]], COL.voltage, 2.5);
    arrow(p, [p[0] + L * a.N[0], p[1] + L * a.N[1], p[2] + L * a.N[2]], COL.normal, 2.5);
    arrow(p, [p[0] + L * a.B[0], p[1] + L * a.B[1], p[2] + L * a.B[2]], COL.binormal, 2.5);
  }

  // moving marker (glow)
  const m = project(p);
  ctx.save();
  ctx.shadowColor = COL.voltage;
  ctx.shadowBlur = 16;
  ctx.fillStyle = COL.voltage;
  ctx.beginPath();
  ctx.arc(m.x, m.y, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // readouts
  setReadout(rRho, bRho, a.rho, 1.0);
  setReadout(rOm, bOm, a.omega, 6.0);
  setReadout(rXi, bXi, a.xi, 6.0);

  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);
