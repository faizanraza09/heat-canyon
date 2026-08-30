/* Wiring. */

import { load } from './data.js';
import { Scene } from './scene.js';
import { UI, boot, bootDone } from './ui.js';
import { Film } from './film.js';
import { Tour, mountTour } from './tour.js';

const $ = (id) => document.getElementById(id);

/* The query as the user arrived with it. `startPlain` rewrites the URL to
   intro=0 when the film cannot be built, and that must not be read back as
   "this visitor asked for no opening" — they asked for one and did not get it,
   which is exactly when the tour is worth the most. */
const ENTRY_SEARCH = location.search;

/** Bring the interface up. Idempotent: the film calls it on its closing beat
 *  and again when it tears itself down, and a skip can beat both to it. */
let revealed = false;
function revealApp() {
  if (revealed) return;
  revealed = true;
  document.body.classList.remove('film-running');
  const replay = $('film-replay');
  if (replay) replay.hidden = false;
}

async function start() {
  // The film owns the loading screen when it is playing: two progress bars for
  // one load is one too many, and its title card is a better thing to look at.
  const film = Film.wanted() ? new Film() : null;
  let phase = [0, 1];
  const setLoad = (p, label) => {
    const q = phase[0] + (phase[1] - phase[0]) * p;
    if (film) {
      $('film-prog').style.transform = `scaleX(${q.toFixed(3)})`;
      $('film-load').textContent = label.toUpperCase();
    } else {
      boot(q, label);
    }
  };

  if (film) {
    document.body.classList.add('film-running');
    $('film').hidden = false;
    $('boot').hidden = true;
    // The globe is small — a land mask, 160 cities and 146 years of anomalies —
    // so it is loaded first and left turning behind the title card while the
    // city, which is two orders of magnitude larger, comes down behind it.
    try {
      phase = [0, 0.18];
      await film.load(setLoad);
      film.build();
      film.startIdle();
    } catch (e) {
      console.warn('opening film unavailable, going straight to the map:', e);
      $('film').remove();
      revealApp();
      return startPlain();
    }
  }

  let data;
  try {
    phase = film ? [0.18, 0.82] : [0, 0.85];
    data = await load(setLoad);
  } catch (e) {
    setLoad(1, `failed: ${e.message}`);
    // Colour whichever label is actually on screen. Picking `#film-load` by
    // existence was wrong: the film's card is in the markup even when the film
    // is off, so with `?intro=0` the failure was reported in an element nobody
    // could see while the visible one stayed grey.
    for (const id of ['film-load', 'boot-msg']) {
      const n = $(id);
      if (n) n.style.color = 'var(--accent)';
    }
    return;
  }

  phase = film ? [0.82, 1] : [0.85, 1];
  // The building count belongs on the title card as soon as it is known: it is
  // the one figure that says what has actually been loaded.
  const count = `${data.meta.counts.buildings.toLocaleString('en-US')} BUILDINGS`;
  // Both entrances carry it: the film's card is in the DOM even when the film
  // is off, so picking one by existence would have silently fed the wrong one.
  for (const id of ['film-count', 'boot-count']) {
    const c = $(id);
    if (c) c.textContent = count;
  }
  setLoad(0.1, 'building geometry');
  await new Promise((r) => setTimeout(r, 30));

  const scene = new Scene($('gl'), data);

  // The satellite ground the opening descent lands on. Only fetched when the
  // film is going to play — three megabytes is the right price for a seamless
  // handover and the wrong one for a reload with `?intro=0`. Not awaited: the
  // planes appear when they arrive, and the film is a minute from needing them.
  // The film asks for the same two files, so each is fetched once.
  //
  // `prime` follows it and is the reason the handover is smooth. Nothing in
  // this scene renders while the film is up (see the `paused` flag below), so
  // without it every program compiles and every buffer uploads on the first
  // frame after the handoff — measured at 394 ms, a frozen third of a second
  // landing exactly where the camera is supposed to be falling fastest. Priming
  // moves that frame behind the loading screen. Not awaited either: it is an
  // optimisation, and the film must not wait on it.
  if (film) scene.loadBasemap().then(() => scene.prime());

  // ONE COLOUR SCALE FOR THE WHOLE YEAR, AND FOR EVERY YEAR.
  //
  // The scale used to be computed here, from the loaded data, and handed to the
  // scene. It is now a constant — TEMP_DOMAIN in colors.js — that the scene
  // holds from the moment it is constructed, so there is nothing to hand it and
  // nothing that can arrive too late.
  //
  // The requirement this file was always protecting is unchanged and now
  // stronger. The ramp has to mean the same thing at 03:00 as at 15:00, or
  // playing the day reads as the legend rescaling rather than the city changing.
  // Once the platform covered a year that requirement got stronger, not weaker:
  // scrubbing from July to January with a per-period scale showed an
  // identical-looking city in both, and the entire point is that they are 30 K
  // apart. The scale it computed here was per-period all the same, because
  // Scene.setPeriod recomputed it on every scrub; fixing the constant is what
  // finally makes the invariant hold across days as well as across hours.
  //
  // See colors.js for the bounds, the measurements behind them, and the
  // within-day contrast the fixed scale gives up in exchange.

  setLoad(0.9, 'ready');
  const ui = new UI(data, scene);

  scene.onPick = (hit) => {
    if (!hit) { ui.clearSelection(); return; }
    /* Clicking the selected building again lets it go.
     *
     * Clearing a selection had three routes and all three were awkward: Escape,
     * a CLOSE button folded into the card, and clicking empty space — which
     * sounds fine until you measure it. Once the camera has framed a building,
     * 96% of the view IS building, so "click away" means hunting the 4% of
     * pixels showing sky or street. There was no reliable place to click, and
     * the honest reading of that is that you could not put a building down.
     *
     * The subject is the one target always in frame and always on top, so it is
     * the one target this gesture can rely on. Clicking a DIFFERENT building
     * still selects it, which is what a click on a building has always meant;
     * only clicking the one already chosen is read as letting go of it. */
    if (scene.selected === hit.building) { ui.clearSelection(); return; }
    ui.showBuilding(hit.building);
  };

  // While the film has the screen, the city is a full-resolution render behind
  // an opaque overlay — pure waste, and on a weak GPU it is the difference
  // between the opening playing at speed and playing in slow motion. It stays
  // parked until the film hands over.
  let paused = !!film;
  const resume = () => { paused = false; };

  let last = performance.now();
  const loop = (t) => {
    // Keep navigation tied to elapsed time on a busy GPU. A 50 ms cap made
    // walking four to ten times slower whenever this dense scene dropped below
    // 20 fps; Scene sub-steps collision checks so a larger catch-up step is
    // still safe around buildings.
    const dt = Math.min(0.2, (t - last) / 1000);
    last = t;
    if (!paused) scene.tick(dt);
    // Parked for the render, not for the tileset. See Scene.warmPhotoreal.
    else scene.warmPhotoreal();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  /* Which build of the 3D scene is actually running.
   *
   * Derived from the presence of the features themselves rather than from a
   * version string, because a version string is the one thing that cannot go
   * stale in the same way the code does. It exists because a browser served a
   * cached `scene.js` alongside a fresh `index.html` for most of a debugging
   * session: the panel described gestures the renderer had never heard of, and
   * every screenshot of the result looked like a fresh bug. Any `false` here
   * means the page is running a renderer older than the interface around it.
   */
  const build = {
    sky: typeof scene._updateSky === 'function',
    compass: typeof scene.bearing === 'number',
    pickIndex: !!scene._pick,
  };
  if (Object.values(build).some((v) => !v)) {
    console.warn('HeatCanyon: the 3D scene is older than the interface around '
      + 'it — a cached scene.js. Reload with the cache cleared.', build);
  }

  // Debug handle. Exposed deliberately: this is a visualisation whose output is
  // geometry, and being able to poke at the scene graph from the console is how
  // you find out why something looks wrong.
  window.HC = { data, scene, ui, film };

  /* One command that says what the camera is actually doing.
   *
   * Every camera fault in this project has been reported as a picture — "I
   * clicked walk and got a wall" — and a picture cannot distinguish between an
   * eye in the wrong place, an eye in the right place pointing the wrong way,
   * and a frame that simply is not being drawn any more. This prints all
   * three, plus what the geometry says is in front of the camera, so the next
   * report is a diagnosis rather than a screenshot. */
  window.HC.diag = () => {
    const s = scene, d = data;
    const c = s.camera.position;
    const dir = new (c.constructor)();
    s.camera.getWorldDirection(dir);
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const bearing = ((Math.atan2(dir.x / hl, -dir.z / hl) * 180) / Math.PI + 360) % 360;
    const out = {
      transitioning: s.transitioning,
      descentStuck: !!s._descent,
      basemap: s._basemapK ?? 0,
      photoreal: s.photorealOn,
      camera: [+c.x.toFixed(1), +c.y.toFixed(2), +c.z.toFixed(1)],
      cameraBearingDeg: +bearing.toFixed(1),
      // How tall the surface model says the ground under the camera is: a large
      // number with the camera low is an eye inside a building.
      groundUnderCameraM: +d.heightAt(c.x, -c.z).toFixed(1),
      fov: s.camera.fov,
      viewport: [innerWidth, innerHeight, window.devicePixelRatio],
      hour: s.hour,
      layer: s.layer,
      build,
    };
    console.log(JSON.stringify(out, null, 1));
    return out;
  };

  bootDone();
  console.log('HeatCanyon ready', {
    build,
    buildings: data.buildings.n,
    panels: data.facades.n,
    quads: scene.nQuad,
    hoursPerPeriod: data.meta.hours.length,
    solvedPeriods: 1 + (data.year.periods.months || []).length,
    yearDays: data.days.length,
    yearWindow: data.year.window,
  });

  if (film) {
    setLoad(1, 'ready');
    await runFilm(film, data, scene, ui, resume);
  } else {
    revealApp();
  }

  // The film hands over to the tour: it has explained the city, the tour
  // explains the instrument. `mountTour` waits for the panels to finish coming
  // up (film.css animates them in over about 1.4 s) before drawing a spotlight
  // on a control that is still sliding, and only runs unasked the first time
  // this browser sees the application — after that the masthead chip is how you
  // ask for it. The wait is unnecessary without the film, hence the shorter
  // delay on that path.
  window.HC.tour = mountTour(ui, {
    auto: Tour.wanted(ENTRY_SEARCH),
    delay: film ? 1600 : 500,
  });

  const replay = $('film-replay');
  if (replay) {
    replay.addEventListener('click', () => {
      const q = new URLSearchParams(location.search);
      q.set('intro', '1');
      location.search = q.toString();
    });
  }
}

/** Hand the film its cues and wait for it to be done with the screen. */
function runFilm(film, data, scene, ui, resume) {
  return new Promise((resolve) => {
    const done = (why) => { resume(); revealApp(); resolve(why); };

    const begin = $('film-begin');
    const straight = $('film-straight');
    begin.disabled = false;
    // The runtime is on the button, so the choice to watch is an informed one.
    const runtime = (t) => {
      begin.innerHTML = `Watch the walkthrough&nbsp;&nbsp;·&nbsp;&nbsp;${t}`;
    };
    // ...and it is re-printed if it changes. It can change exactly once: the
    // film asks the server for its narration while this card is up, and a beat
    // whose recorded line is longer than its shot is stretched to fit it. A
    // button that promised two forty-two over a film that runs three fifty is
    // the sort of small lie that makes a viewer stop believing the rest.
    film.onRuntime = runtime;
    runtime(film.runtimeLabel(data));

    const play = () => {
      begin.removeEventListener('click', play);
      film.play(data, {
        // What the storyboard's beats drive from chapter three onward. The film
        // stops being a picture of the tool there and starts being the tool.
        ctx: { ui, scene, data },
        /* The film's descent drives this camera directly, in this scene's own
         * metres, so for the last seconds of the fall both canvases are drawing
         * the same viewpoint and the globe going is a photograph turning into
         * the model.
         *
         * This was briefly a dissolve between two independent pictures, which
         * is what the design prototype does and is the only thing that works if
         * the descent has to be six seconds long. The three-minute cut gives it
         * twelve, which is enough to travel the distance honestly — and the
         * walkthrough after the handoff needs the camera down over the city
         * regardless, so there is nothing left to save by cheating it. */
        onHandoff: () => { resume(); scene.beginDescent(); },
        onPose: (pose) => scene.setDescentPose(pose),
        // Whatever ends the descent — the beat finishing, or someone pressing
        // skip halfway down — the camera continues from exactly where it is
        // into the opening view rather than cutting to it. The photographic
        // ground is held for a moment first: chapter three is about to talk
        // about a building standing on it.
        onLanded: () => scene.endDescent(3.4, 2.0),
        onSkip: () => { resume(); scene.endDescent(1.1); scene._abortFly(); },
        onReveal: () => { resume(); revealApp(); },
      }).then(done);
    };

    begin.addEventListener('click', play);
    straight.addEventListener('click', () => { film.skip(); done('straight'); });
    // Everything else on the transport bar — skip, sound, chapter stepping,
    // play/pause and the segment scrubber — is wired by the film itself, which
    // is the only thing that knows where the beats are.
    film.bindTransport();
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') film.skip();
    });

    // The strap is not touched here. It used to be rewritten from the loaded
    // event metadata, which meant the title card said one thing on first paint
    // and a different thing a few seconds later — and the placeholder it
    // replaced advertised a single afternoon, which is the opposite of what
    // this is. The tagline in the markup describes the instrument, not the run,
    // so there is nothing to swap in. The dates and counts belong on the atlas,
    // where they are attached to the numbers they qualify.
  });
}

/** Fallback path: if the film cannot be built, run the application unadorned
 *  rather than leaving the user staring at a dead overlay. */
async function startPlain() {
  const url = new URL(location.href);
  url.searchParams.set('intro', '0');
  history.replaceState(null, '', url);
  $('boot').hidden = false;
  return start();
}

start();
