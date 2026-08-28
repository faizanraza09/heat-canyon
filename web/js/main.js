/* Wiring. */

import { load, domain } from './data.js';
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
      $('film-prog').style.width = `${Math.round(q * 100)}%`;
      $('film-load').textContent = label;
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
    ($('film-load') || $('boot-msg')).style.color = '#e8674f';
    return;
  }

  phase = film ? [0.82, 1] : [0.85, 1];
  setLoad(0.1, 'building geometry');
  await new Promise((r) => setTimeout(r, 30));

  const scene = new Scene($('gl'), data);

  // One colour scale for the whole day, so the ramp means the same thing at
  // 03:00 as at 15:00 and playing the day reads as the city changing rather
  // than the legend rescaling underneath it.
  //
  // The percentiles are wide on purpose. A 1-99 window came out at 28-45 degC,
  // but peak-hour surfaces sit at 40-45, which crushed the entire hour of
  // interest into the top third of the ramp and clipped the hottest 3% to flat
  // white — the sunlit walls that are the whole point. Going out to 99.8
  // captures the real daily range (about 28-50 degC) and puts mid-afternoon in
  // the middle of the ramp, where there is contrast to spend.
  scene.setDomains({
    surface: domain(data.thermal, 0.5, 99.8),
    air: domain(data.air, 0.5, 99.5),
  });

  setLoad(0.9, 'ready');
  const ui = new UI(data, scene);

  scene.onPick = (hit) => {
    if (!hit) { ui.showList(); return; }
    const a = data.buildings.attrs[hit.building];
    const idx = data.ranked.items.findIndex((it) => String(it.bin) === String(a?.bin));
    if (idx >= 0) ui.showDetail(idx);
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
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Debug handle. Exposed deliberately: this is a visualisation whose output is
  // geometry, and being able to poke at the scene graph from the console is how
  // you find out why something looks wrong.
  window.HC = { data, scene, ui, film };

  bootDone();
  console.log('HeatCanyon ready', {
    buildings: data.buildings.n,
    panels: data.facades.n,
    quads: scene.nQuad,
    hours: data.meta.hours.length,
  });

  if (film) {
    setLoad(1, 'ready');
    await runFilm(film, data, scene, resume);
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
function runFilm(film, data, scene, resume) {
  return new Promise((resolve) => {
    const done = (why) => { resume(); revealApp(); resolve(why); };

    const begin = $('film-begin');
    const straight = $('film-straight');
    begin.disabled = false;
    begin.textContent = 'Begin';

    const play = () => {
      begin.removeEventListener('click', play);
      film.play(data, {
        // The city starts falling while the globe is still on screen, so the
        // cross-fade lands on a moving frame. It keeps flying for a few seconds
        // past the fade, under the first caption, and settles into the default
        // view on its own.
        onHandoff: (dur) => { resume(); scene.flyIn({ seconds: Math.max(7, dur + 5) }); },
        onSkip: () => { resume(); scene._abortFly(); },
        onReveal: () => { resume(); revealApp(); },
      }).then(done);
    };

    begin.addEventListener('click', play);
    straight.addEventListener('click', () => { film.skip(); done('straight'); });
    $('film-skip').addEventListener('click', () => film.skip());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') film.skip();
    });

    const soundBtn = $('film-sound');
    soundBtn.setAttribute('aria-pressed', String(film.sound));
    soundBtn.addEventListener('click', () => {
      film.setSound(!film.sound);
      soundBtn.setAttribute('aria-pressed', String(film.sound));
    });

    // The strap under the title comes from the same event metadata the model
    // ran on, so the card names the actual heat wave rather than a slogan.
    $('film-title-strap').textContent =
      `${data.meta.event.label}. A street-level account of one afternoon in ${data.meta.aoi.label}.`;
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
