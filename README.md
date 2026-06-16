# Complex Frequency — interactive (Three.js)

Drag the sliders and watch the **radial (ρ)**, **azimuthal (ω)**, and
**torsional (ξ)** frequencies update live as the voltage curve changes shape.
Same maths as the video (`src/frenet.js` mirrors `../src/frenet.py`).

## Run

```pwsh
cd web
python -m http.server 8000     # ES modules won't load from file://
```
Open <http://localhost:8000>. The import map resolves `three` to
`node_modules/three/build/three.module.js`.

## Files

| File | Role |
|---|---|
| `index.html` | sidebar controls + canvas + the `three` import map |
| `src/main.js` | **Three.js** renderer: scene, camera, curve, triad, loop, UI wiring |
| `src/orbit.js` | small hand-written orbit camera (drag/zoom/auto-rotate) |
| `src/curves.js` | parametric voltage curve; params map to ρ / ω / ξ |
| `src/frenet.js` | pure-maths port of the Python apparatus (T,N,B,κ,τ,ρ,ω,ξ) |
| `src/renderer_canvas2d.js` | **fallback** Canvas-2D renderer (no deps) — see below |

## If `npm install` is blocked: zero-dependency fallback

A complete Canvas-2D renderer is kept in `src/renderer_canvas2d.js`. To use it
without installing anything, point the page at it: in `index.html` change the
module script to
```html
<script type="module" src="./src/renderer_canvas2d.js"></script>
```
(the import map is then ignored). Serve and open as above.
