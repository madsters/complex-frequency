// app.js — bootstrap for the Complex Frequency story.
//
// This is the entry point referenced by index.html (<script type="module">).
// Its whole job is to wire the pieces together:
//   STEPS (data)  →  StoryEngine (mounts scene + paints panel + sliders)
//                 →  Nav (buttons / keys / dots / counter / hash)
//   then start at step 0 (or whatever the URL hash points to).
//
// Each module is deliberately dumb on its own; app.js is where they meet.

import { STEPS } from "./story/steps.js";
import { StoryEngine } from "./story/engine.js";
import { Nav } from "./story/nav.js";

// Tiny DOM helper — fail loudly if the shell markup is missing an id, since
// every other module assumes these elements exist.
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`app.js: missing #${id} in index.html`);
  return el;
}

function boot() {
  // Grab the shell DOM authored in index.html / design.css.
  const refs = {
    sceneHost: $("scene-host"),
    content:   $("narrative-content"),
    kicker:    $("st-kicker"),
    title:     $("st-title"),
    prose:     $("st-prose"),
    eq:        $("st-eq"),
    controls:  $("st-controls"),
  };

  // Build the engine (owns the scene + narrative) ...
  const engine = new StoryEngine(refs, STEPS);

  // ... and the navigation (owns buttons / keys / dots / counter / hash).
  const nav = new Nav(engine, {
    prev:    $("prev"),
    next:    $("next"),
    dots:    $("dots"),
    counter: $("counter"),
  }, STEPS);

  // Kick things off at the right step.
  nav.start();

  // Clean up on page unload (dispose the renderer + listeners).
  window.addEventListener("pagehide", () => {
    nav.dispose();
    engine.dispose();
  }, { once: true });
}

// Wait for the DOM if the script somehow runs early; type=module already
// defers, so this is just belt-and-braces.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
