// orbit.js — minimal orbit camera (drag to rotate, wheel to zoom, slow
// auto-rotate when idle). Dependency-light on purpose: good to see how an
// orbit camera works before reaching for the three/addons OrbitControls.

import * as THREE from "three";

export class Orbit {
  constructor(camera, el, target = new THREE.Vector3(0, 0, 0)) {
    this.camera = camera;
    this.el = el;
    this.target = target;

    this.radius = 9;
    this.theta = 0.9;             // azimuth
    this.phi = 1.1;               // polar from +Y
    this.minPhi = 0.05;
    this.maxPhi = Math.PI - 0.05;
    this.minRadius = 3.5;
    this.maxRadius = 26;

    this.autoRotate = true;
    this.autoSpeed = 0.25;        // rad/s

    this._drag = false;
    this._lx = 0;
    this._ly = 0;
    this._bind();
    this.apply();
  }

  apply() {
    const r = this.radius, sp = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + r * sp * Math.sin(this.theta),
      this.target.y + r * Math.cos(this.phi),
      this.target.z + r * sp * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
  }

  // called every frame
  tick(dt) {
    if (this.autoRotate && !this._drag) this.theta += dt * this.autoSpeed;
    this.apply();
  }

  _bind() {
    const el = this.el;
    el.addEventListener("pointerdown", (e) => {
      this._drag = true;
      this.autoRotate = false;
      this._lx = e.clientX; this._ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointerup", (e) => {
      this._drag = false;
      el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this._drag) return;
      this.theta -= (e.clientX - this._lx) * 0.006;
      this.phi = Math.min(this.maxPhi, Math.max(this.minPhi, this.phi - (e.clientY - this._ly) * 0.006));
      this._lx = e.clientX; this._ly = e.clientY;
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.radius = Math.min(this.maxRadius, Math.max(this.minRadius,
        this.radius * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
  }
}
