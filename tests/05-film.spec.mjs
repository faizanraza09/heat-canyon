/* The opening film.
 *
 * Three things are worth defending with tests here, and one of them is a bug
 * that actually shipped into a working build.
 *
 * The camera is held on the equatorial plane from the moment the globe locks
 * onto New York, because the framing offset is supposed to come from rotating
 * the planet (`aim`), not from moving the eye (`tilt`). The first version kept a
 * two-hundredths-of-a-radian camera tilt through the descent. At four hundred
 * units out that is invisible; at three units above the surface it is about a
 * hundred and thirty kilometres, so the dive bottomed out over Connecticut with
 * New York a thousand pixels below the frame — and it looked fine the whole way
 * down, because the globe is round and any patch of it reads as "somewhere".
 * `lands on New York` pins that: at the bottom of the dive the study area must
 * project to the centre of the screen.
 *
 * The other two are contractual. `?intro=0` has to suppress the film completely,
 * because every other spec in this suite depends on it. And the skip control has
 * to produce a usable application, because it is the escape hatch.
 *
 * Seeking is done by moving the film's own clock origin. That is reaching into
 * the implementation, but this suite already drives the scene graph through
 * `window.HC` by design, and the alternative is a test that sits through a
 * hundred seconds of narration.
 */

import { test, expect } from '@playwright/test';

/** Load the page with the film enabled and wait until it offers to start. */
async function openFilm(page, query = '') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`/?intro=1${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => { const b = document.getElementById('film-begin'); return b && !b.disabled; },
    null, { timeout: 150_000 }
  );
  return { errors };
}

/** Move the film to `t` seconds and let a couple of frames land. */
async function seek(page, t) {
  await page.evaluate((tt) => { window.HC.film.t0 = performance.now() - tt * 1000; }, t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Seek and stop the clock there.
 *
 *  `seek` alone is not enough for anything that reads the storyboard back: two
 *  frames under software GL can be half a second of film, which on a descent
 *  that covers two orders of magnitude in five seconds is a completely
 *  different altitude from the one that was asked for. */
async function hold(page, t) {
  await page.evaluate((tt) => {
    const f = window.HC.film;
    f._setPaused(false);
    f._seek(tt);
    f._setPaused(true);
  }, t);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('?intro=0 suppresses the film entirely', async ({ page }) => {
  await page.goto('/?intro=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.HC?.scene, null, { timeout: 150_000 });
  // The overlay may still be in the markup, but it must never be shown, and the
  // application's own panels must not be held back waiting for it.
  await expect(page.locator('#film')).toBeHidden();
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
  expect(await page.evaluate(() => !!window.HC.film)).toBe(false);
});

test('the title card offers to start, and says the same thing throughout', async ({ page }) => {
  const { errors } = await openFilm(page);
  await expect(page.locator('#film')).toBeVisible();
  await expect(page.locator('#film-title h1')).toHaveText('The Urban Canyon');
  // The strap used to be rebuilt from meta.json once the arrays landed, which
  // meant the card said one thing on first paint and another a few seconds
  // later — and the markup it replaced advertised a single afternoon, which is
  // the opposite of what this is. It is now a fixed claim about the instrument.
  // What this guards is that property: nothing writes to it, so it reads the
  // same before and after the load, and it carries no figures from the run.
  const strap = (await page.locator('#film-title-strap').textContent()).trim();
  const meta = await page.evaluate(() => window.HC.data.meta);
  expect(strap.length).toBeGreaterThan(40);
  expect(strap).not.toContain(meta.event.label);
  expect(strap).not.toMatch(/\d{4}/);
  expect(strap).not.toMatch(/afternoon|snapshot|one day/i);
  // Re-read after a further second: the loaded application must not rewrite it.
  await page.waitForTimeout(1000);
  expect((await page.locator('#film-title-strap').textContent()).trim()).toBe(strap);
  // The interface waits behind the film.
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(true);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

/* The design's own timing, which is what `?voice=0` runs.
 *
 * This used to be asserted of the film full stop, on the rule that the runtime
 * must not depend on the sound setting — the title card promises a length and
 * the transport bar sizes its segments, and neither should vary by machine.
 *
 * The recorded narration changed that, and deliberately: a beat whose ElevenLabs
 * line is longer than its shot is stretched to fit, because twenty-two of the
 * twenty-seven spoken beats were otherwise being cut mid-sentence. So there are
 * now two cuts of this film, and both are pinned — the design's, here, and the
 * voiced one in the test below. What has NOT changed is the property the old
 * rule was protecting: neither length varies by machine, because the recordings
 * are committed and every viewer stretches the beats by the same amount.
 */
test('the film is the length it promises, in the chapters it says', async ({ page }) => {
  await openFilm(page, '&voice=0');
  await page.click('#film-begin');
  const shape = await page.evaluate(() => {
    const f = window.HC.film;
    return {
      total: f.total,
      chapters: f.chapters.map((c) => ({ n: c.n, title: c.title, dur: c.dur })),
      beats: f.story.beats.length,
      // Nothing may depend on the sound setting: the runtime on the title card
      // and the four segment widths on the transport bar are drawn from these.
      stated: f.story.beats.every((b) => typeof b.seconds === 'number'),
    };
  });
  // Thirty seconds is the design's length, and it is a ceiling rather than a
  // target: it is how long someone will sit still before they have been shown
  // anything. Assert the ceiling as well as the figure, so a beat lengthened by
  // half a second at a time cannot walk the film back to forty.
  /* Under three minutes, and the ceiling is what actually guards that.
   *
   * The figure has moved twice. Up, when the layer beat was given room to name
   * its four layers one at a time instead of naming four and showing one; and
   * then down by nine, taken entirely out of the three beats with NO WORDS IN
   * THEM — the hold before the first sentence, the fall into New York, and the
   * silent close. Not one spoken line lost a frame. That is the rule the
   * ceiling is here to keep: length comes off silence first, and if a cut ever
   * has to come out of a sentence it should be an argued change to the script
   * rather than a number quietly shaved here.
   */
  /* Three minutes is now a HARD limit, not a preference: it is the longest
   * film the submission accepts, so the ceiling below is the requirement and
   * the figure is wherever the script currently lands under it.
   *
   * The rule the old comment set — length comes off silence first, and a cut
   * from a sentence should be an argued change to the script rather than a
   * number quietly shaved here — held through the rewrite that produced this
   * figure. Every line was rewritten against a measured per-beat budget, and
   * the beats were then restated at the length the read actually needs, which
   * is why the voiced and unvoiced cuts are now the same length.
   */
  /* 177.3 to 179.38, and the rule above deserves an answer rather than a new
   * number.
   *
   * Nothing was shaved off a sentence. What moved is that the film gained a
   * line — the close now says what the analyst's refusal is worth instead of
   * ending on the word "no" — and the read itself got longer: the opening two
   * beats were re-bought when the lines around them changed, and ElevenLabs
   * returned slower takes of the same sentences (beat 2 went 9.82 s to 12.57 s
   * for one added word). The cache is keyed by content, so there is no asking
   * for a brisker read of a line that is already bought.
   *
   * The time came out of SHOT SLACK, not silence and not script: beats stated
   * longer than their recording needed are now stated at what it needs, so the
   * two silent beats are untouched and every sentence is intact. The cost is
   * real and is recorded here rather than hidden — the whole film now reads at
   * 1.12x to 1.15x, which is the hurry ceiling in voice.js. There is no slack
   * left. The next line added to this script cannot be paid for from timing;
   * it has to be paid for by cutting another one.
   *
   * The last 0.32 s did come off silence, as the rule asks: beats 7 and 13 have
   * to be stated from the server's frame count rather than the browser's decode
   * of the same file — the two disagree by a quarter of a second and `_retime`
   * believes the server — and the opening hold paid for it, 1.4 s to 1.2 s. It
   * is the beat with no words in it and no picture yet to speak of.
   */
  expect(shape.total).toBeCloseTo(167.65, 1);
  expect(shape.total).toBeLessThan(180);
  expect(shape.beats).toBe(31);
  expect(shape.stated).toBe(true);
  expect(shape.chapters.map((c) => c.n)).toEqual(['I', 'II', 'III', 'IV', 'V']);
  expect(shape.chapters.map((c) => c.title)).toEqual(
    ['A year over Manhattan', 'Going in', 'One building', 'All of them', 'Ask it']);
  // Turn, talk, fall. The middle chapter is more than half the film because it
  // is the only one with words in it: everything the film has to say is said
  // over one held shot of the city, and the descent that follows is silent.
  // Four fifths of it is the tool. Getting there — a globe, a year, and a fall
  // into Midtown — is twenty-eight seconds, and everything after that is the
  // application being driven: one building taken apart, then the instrument
  // around it, then the analyst. A walkthrough that spends a third of itself
  // arriving is a trailer, and this one has to be a demo.
  /* Chapter I is four seconds longer than it was and not one word longer. Its
   * first two lines were re-bought when the sentence after them gained the word
   * "degrees", and the same two sentences came back read more slowly — beat 2
   * by two and three quarter seconds. Nothing here chose that; a recording is
   * keyed by its text, so the only way to decline a slow take is to rewrite the
   * line and buy it again. The ratio below is the guard that matters, and at
   * 19% it is still well inside the quarter that would make this a trailer.
   */
  expect(shape.chapters.map((c) => Math.round(c.dur))).toEqual([18, 10, 73, 46, 21]);
  const arrival = shape.chapters.slice(0, 2).reduce((a, c) => a + c.dur, 0);
  expect(arrival / shape.total).toBeLessThan(0.25);
});

test('the voiced cut gives every line a shot long enough to say it in', async ({ page }) => {
  const { errors } = await openFilm(page);
  // Wait for the film's own promise, not for a timeout and not for the narrator
  // merely reporting itself enabled. The script is asked for twice — once
  // immediately, and once when floors.json and prescriptions.json land and five
  // of the sentences change — and the first pass is what flips `enabled`. Read
  // the state after the second, or this measures a film mid-correction.
  const voiced = await page
    .waitForFunction(() => window.HC?.film?.narration !== undefined, null, { timeout: 60_000 })
    .then(() => page.evaluate(async () => {
      await window.HC.film.narration;
      return window.HC.film.narrator?.enabled === true;
    }))
    .catch(() => false);
  test.skip(!voiced, 'no cached narration in web/data/vo — the film reads itself');

  /* And then wait for the clips to stop arriving.
   *
   * `await film.narration` resolves on the FIRST script, which is the one built
   * while the title card is up, before floors.json and prescriptions.json land.
   * The second script replaces five sentences and fetches five more recordings,
   * and this test counts recordings — so reading straight after the promise
   * counted a film mid-correction and reported sixteen lines missing that were
   * on disk the whole time. The comment above always said to read after the
   * second pass; the promise it waits on is not that pass.
   *
   * Two equal readings a second apart is the cheapest honest signal that the
   * fetching has finished, and it cannot mask a genuinely missing line: a line
   * that is never fetched keeps the count stable at the wrong number, and the
   * assertion below still fails with the list of which beats.
   */
  await page.waitForFunction(() => {
    const n = window.HC?.film?.narrator;
    if (!n) return false;
    const c = n.clips.filter(Boolean).length;
    const settled = window.__hcClipCount === c && c > 0;
    window.__hcClipCount = c;
    return settled;
  }, null, { timeout: 60_000, polling: 1000 }).catch(() => {});

  const shape = await page.evaluate(() => {
    const f = window.HC.film;
    const n = f.narrator;
    const cut = [];
    const stale = [];
    f.story.beats.forEach((b, i) => {
      const d = n.duration(i);
      if (!d) return;
      // The same arithmetic voice.js plays by: a line may be hurried to fit,
      // but only so far, and it must land before the cut rather than into it.
      if (d / Math.max(0.5, b.dur - 0.25) > 1.151) cut.push(i);
      if (!n.has(i, b.say || b.text)) stale.push(i);
    });
    return {
      cut, stale,
      total: f.total,
      spoken: f.story.beats.filter((b) => b.text).length,
      recorded: n.clips.filter(Boolean).length,
      button: document.getElementById('film-begin').textContent.trim(),
      credit: document.getElementById('film-credit').textContent,
      // Every recording is served from the committed cache under /data/vo. A
      // relative URL is the whole point: the page must never hold a key, and a
      // film that reaches api.elevenlabs.io while it plays is one that spends.
      urls: n.clips.filter(Boolean).map((el) => new URL(el.src).pathname),
    };
  });

  // Not one line is cut. This is the assertion the whole retiming exists for.
  expect(shape.cut, `beats whose line will not fit: ${shape.cut}`).toEqual([]);
  // And not one is a recording of a sentence the beat no longer says — the five
  // beats written against floors.json and prescriptions.json change wording when
  // those land, and a stale recording under a current caption is worse than none.
  expect(shape.stale, `beats reading an outdated line: ${shape.stale}`).toEqual([]);
  // Every spoken beat has a recording. This is the assertion that goes red when
  // someone edits a line in story.js, or re-runs the pipeline so a figure moves,
  // and does not re-bake: the cache is keyed by the exact sentence, so a changed
  // sentence has no recording and that beat drops to the browser voice. The fix
  // is one command, and the dry run that tells you what it will cost is free.
  expect(shape.recorded,
    `${shape.spoken - shape.recorded} of ${shape.spoken} spoken beats have no recording. `
    + 'The script has changed since the narration was baked — run '
    + '`node scripts/prewarm_voice.mjs --dry` to see which lines, then drop --dry to buy them.')
    .toBe(shape.spoken);
  expect(shape.urls.every((u) => u.startsWith('/data/vo/'))).toBe(true);
  // The button says the length the film will actually run, not the length it
  // would have run unvoiced.
  const mm = Math.floor(shape.total / 60);
  const ss = String(Math.round(shape.total) % 60).padStart(2, '0');
  expect(shape.button).toContain(`${mm}:${ss}`);
  // Credited on screen, because it is being used.
  expect(shape.credit).toContain('ELEVENLABS');
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('every figure in the narration comes from the loaded data', async ({ page }) => {
  await openFilm(page);
  await page.click('#film-begin');
  const facts = await page.evaluate(async () => {
    const { film, data } = window.HC;
    const { words, ordinal, HERO_BUILDING } = await import('/js/story.js');
    const beats = film.story.beats;
    const text = beats.map((b) => b.text || '').join(' ');
    const spoken = beats.map((b) => b.say || b.text || '').join(' ');
    const m = data.meta;
    // Imported, never restated. This was a literal, and when the film changed
    // which building it takes as its example the test carried on checking the
    // old one's temperatures against the new one's script — a failure that
    // pointed at the narration when the narration was right.
    const HERO = HERO_BUILDING;
    const hero = data.ranked.items.find((it) => String(it.bin) === HERO);
    const fl = data.decision?.floors?.items?.[HERO];
    const worst = fl && (fl.floors || []).find((r) => r.f === fl.worst_floor);
    const rx = (data.decision?.prescriptions?.items?.[HERO] || [])[0];
    /* The PANEL's programme, not the stored allocation — the same source the
     * script reads.
     *
     * These two disagree by design. `portfolio.json.allocation` is solved at a
     * $2 M budget and treats 20 buildings; the panel the film is showing while
     * it speaks re-solves at the budget it opens on and treats 91. The film
     * quotes the panel, because the panel is the picture — quoting the stored
     * figure had the narration saying "20 buildings" over a rail reading 91,
     * which is the exact defect story.js documents at `programme()`.
     *
     * This test then asserted the stored numbers, so it was checking the film
     * against a source the film deliberately does not use, and would have gone
     * on failing for as long as the film stayed right. It now derives the
     * figures the way `programme()` does, off the same module. */
    const { defaultBudget, figuresOf, totalOf } = await import('/js/programme.js');
    const pf = data.decision?.portfolio;
    const alloc = pf?.candidates?.length
      ? figuresOf(pf, 'person_hours', defaultBudget({ ...pf, total: pf.total || totalOf(pf) }))
      : data.decision?.portfolio?.allocation;
    return {
      text, spoken,
      year: String(new Date(`${m.event.date}T12:00:00Z`).getUTCFullYear()),
      hours: (m.year.hours).toLocaleString('en-US'),
      daysOver: words(m.year.annual.days_above_35),
      tropical: words(m.year.annual.tropical_nights),
      panels: m.counts.facade_panels.toLocaleString('en-US'),
      buildings: m.counts.buildings.toLocaleString('en-US'),
      heroAddr: hero.addr,
      heroFloors: String(hero.floors),
      heroUnits: String(hero.units),
      worstFloor: String(fl.worst_floor),
      worstOrdinal: ordinal(fl.worst_floor),
      worstHrs: worst.hrs.toLocaleString('en-US'),
      rxFloors: `${rx.floors[0]} to ${rx.floors[1]}`,
      projection: rx.geometry.projection_uncapped_m.toFixed(1),
      overlap: words(data.ranked.orderings.agreement.top50_overlap),
      allocBuildings: String(alloc.buildings),
      personHours: Math.round(alloc.person_hours_avoided).toLocaleString('en-US'),
      // Split by chapter, because the rule is not the same either side of the
      // handover — see the assertions.
      openingDigits: beats.filter((b) => b.chapter === 'I' || b.chapter === 'II')
        .map((b) => b.text || '').join(' ').match(/\d[\d,]*/g) || [],
      spokenDigits: spoken.match(/\d[\d,]*/g) || [],
      unspoken: beats.filter((b) => b.chapter !== 'I' && b.chapter !== 'II')
        .filter((b) => /\d/.test(b.text || '') && !b.say)
        .map((b) => b.text),
    };
  });

  /* The study year, and what it did.
   *
   * Tropical nights are not in here, and the reason is worth writing down: they
   * never were. `words(4)` is "four", and this assertion passed for months on
   * the word "four" in "an overhang would need four metres" — a different four,
   * in a different chapter, about a sunshade. A rewrite that dropped those
   * three words failed it, which is the only reason anyone found out.
   *
   * The film quotes the hours and the days over threshold. It does not quote
   * the tropical-night count, and asserting a bare numeral is in the script
   * somewhere cannot tell the difference between quoting a figure and
   * coincidence. The ticker still carries it, where it is checked by label.
   */
  expect(facts.text).toContain(facts.hours);
  expect(facts.text).toContain(facts.daysOver);

  // What the model is of.
  expect(facts.text).toContain(facts.panels);
  expect(facts.text).toContain(facts.buildings);

  // The building chapter three is about, and the floor it settles on. None of
  // this is typed: change the hero building or rerun the pipeline and the
  // captions follow.
  expect(facts.text).toContain(facts.heroAddr);
  expect(facts.text).toContain(facts.heroFloors);
  expect(facts.text).toContain(facts.heroUnits);
  /* The worst floor, in either grammar.
   *
   * This demanded the ordinal — "the fifteenth floor" — because that is how the
   * script phrased it at the time. The property worth protecting is that the
   * number comes from `worst_floor` rather than from someone's memory of it;
   * whether the sentence reaches it as "the fifteenth floor" or "floor fifteen"
   * is a question for the prose, and pinning it here means a rewrite of the
   * line fails a test about provenance. Both forms are spelled by the same
   * helpers off the same field.
   */
  expect(facts.text).toMatch(
    new RegExp(`(${facts.worstOrdinal}|[Ff]loor ${facts.worstFloor})\\b`));
  expect(facts.text).toContain(facts.worstHrs);

  // Why shading fails on it, and what it gets instead — both read out of the
  // prescription's own geometry rather than asserted by the script.
  expect(facts.text).toContain(facts.projection);
  expect(facts.text).toContain(facts.rxFloors);

  // The two rankings, and the programme.
  /* Case-insensitively, for the same reason the worst floor is matched in
   * either grammar. `words()` returns "twelve" and the sentence that quotes it
   * opens with it, so the script correctly capitalises it — and a substring
   * check against the lower-case form then fails a film that is doing exactly
   * what this test is for. What is under test is that the figure is read out of
   * `agreement.top50_overlap` rather than typed, not which end of a sentence it
   * happens to fall at. */
  expect(facts.text.toLowerCase()).toContain(facts.overlap.toLowerCase());
  expect(facts.text).toContain(facts.allocBuildings);
  expect(facts.text).toContain(facts.personHours);

  /* Figures are spelled while the film is narration, and printed once it is a
   * tool.
   *
   * Chapters one and two are a voice over a globe: a caption there is prose, and
   * prose says "thirty-five degrees". From chapter three the caption sits over
   * the application's own panels, where every number on screen is a numeral, and
   * spelling them out would make the film read as a different document from the
   * thing it is describing. Some of them cannot be spelled anyway — twenty-nine
   * thousand four hundred and fifteen is not a caption.
   *
   * What does not change is the mouth. Every beat that prints a figure carries a
   * `say` that spells it, because a synthesiser handed "55 °C" says "fifty-five
   * degree see".
   */
  expect(facts.unspoken, 'these captions print a figure with nothing to say it')
    .toEqual([]);
  // In the opening, a printed figure is one that cannot be spelled. Everything
  // under a thousand is words there; 8,760 hours, 29,415 walls and 5,329
  // buildings are not sentences and are left as themselves.
  for (const d of facts.openingDigits) {
    expect(Number(d.replace(/,/g, '')), `"${d}" is small enough to spell`)
      .toBeGreaterThanOrEqual(1000);
  }
  expect(facts.spokenDigits).toEqual([]);
});

test('the narration quotes the model, not a rounded memory of it', async ({ page }) => {
  await openFilm(page);
  await page.click('#film-begin');
  const facts = await page.evaluate(() => {
    const { film, data } = window.HC;
    const items = data.ranked.items;
    const max = (pick) => Math.max(...items.map(pick));
    return {
      text: film.story.beats.map((b) => b.text).join(' '),
      peakAir: Math.round(max((i) => i.measured.peak_air_c)),
      peakMrt: Math.round(max((i) => i.modelled.mrt_peak_c)),
      warmest: film.assets.temp.warmest[0],
      since: film.assets.temp.warmest10_since,
    };
  });
  // The design's script dropped the warmest-year and warmest-decade claims from
  // the captions; chapter one's ticker carries them instead, with the GISTEMP
  // sparkline filling in underneath as the sentence is read. So they must be on
  // screen, and they must still come from the series rather than the script.
  const ticker = await page.evaluate(() => {
    const r = window.HC.film.story.readouts;
    return {
      first: r[0],
      count: Object.keys(r).length,
      // The one costed line in the film. Capex bands, tariffs and occupancy are
      // stated assumptions no measurement in this study constrains, so the
      // label has to say so — see docs/DECISIONS.md. A dollar figure is the
      // easiest number in the system to over-trust and the film is where it is
      // seen by someone who will never open the panels.
      costed: Object.values(r).find((x) => /\$|PERSON-HOUR|PRESCRIBED/.test(x.value || '')),
    };
  });
  expect(ticker.count).toBe(6);              // at least one per chapter
  expect(ticker.first.kind).toBe('anomaly'); // the sparkline chapter
  /* The costed readout names its source, as every other readout does.
   *
   * This asserted the label contained ASSUMED. In the PANELS that rule stands
   * and is tested elsewhere — a costed figure without its mark is a bug, since
   * capex bands, tariffs and occupancy are stated assumptions no measurement
   * here constrains. In the walkthrough it made the one line of on-screen text
   * accompanying the film's best number a disclaimer, while every other readout
   * named a source and a qualifier: GISTEMP and a mean anomaly, ERA5 and a bias
   * correction. It now does the same. The disclosure lives in the brief's fifth
   * section and on every costed figure in the panels.
   */
  expect(ticker.costed?.label).toContain('DECISION LAYER');
  expect(facts.warmest).toBeGreaterThan(1990);
  expect(facts.since).toBeGreaterThan(1990);
  expect(facts.peakAir).toBeGreaterThan(30);
  expect(facts.peakMrt).toBeGreaterThan(facts.peakAir);
});

test('the walkthrough drives the real application, and covers what it claims', async ({ page }) => {
  await openFilm(page);
  await page.click('#film-begin');
  const shape = await page.evaluate(() => {
    const beats = window.HC.film.story.beats;
    const tool = beats.filter((b) => ['III', 'IV', 'V'].includes(b.chapter));
    return {
      // The opening frame carries no line: a title card that starts talking
      // before it has finished animating reads as a page still loading.
      openingSilent: !beats[0].text,
      // The fall does carry one, and the count is the assertion. Chapter two
      // used to be silent throughout, on the argument that a voice competes
      // with the only thing on screen anyone wants to look at. That holds for a
      // title sequence and not for a demo: three silent seconds after "everyone
      // plans with it", with a planet getting closer and nobody saying why, is
      // the longest hole in the film and the place a viewer decides whether to
      // keep watching. One line, not two — the descent is still mostly picture.
      descentLines: beats.filter((b) => b.chapter === 'II' && b.text).length,
      toolBeats: tool.length,
      acts: tool.filter((b) => b.act).length,
      // Nothing before the handover touches the application; nothing after it
      // is allowed to be a drawing.
      earlyActs: beats.filter((b) => ['I', 'II'].includes(b.chapter) && b.act).length,
      cityPhase: beats.filter((b) => b.phase === 'city').length,
      text: tool.map((b) => b.text || '').join(' ').toLowerCase(),
    };
  });

  expect(shape.openingSilent).toBe(true);
  expect(shape.descentLines).toBe(2);
  expect(shape.earlyActs).toBe(0);

  // Two thirds of the film is the tool, and it is the tool: every beat from the
  // handover on runs in the city phase, and a third of them move a real control.
  expect(shape.toolBeats).toBe(25);
  expect(shape.cityPhase).toBe(25);
  expect(shape.acts).toBeGreaterThanOrEqual(10);

  /* And it says the things a demo of this has to say. Each of these is a part of
   * the application that exists and would otherwise go unmentioned — the list is
   * here so that dropping one from the script is a failing test rather than a
   * thing nobody notices until someone watches the submission.
   */
  /* Matched loosely enough to survive a rewrite of the prose and tightly
   * enough to fail when a FEATURE leaves the script, which is the distinction
   * this list is for. The first version was exact phrases from one draft, so a
   * plain-language pass over the narration failed nine of eleven while the film
   * still covered every one of them — and buried in that noise were two it was
   * right about: the word "layers" had gone, and so had the month and season
   * aggregations, whose tabs are on screen while that very line is read.
   */
  expect(shape.text).toContain('face');                    // per-face resolution
  expect(shape.text).toContain('floor by floor');          // the storey schedule
  expect(shape.text).toMatch(/sun, the (surroundings|neighbours)/); // the attribution
  expect(shape.text).toMatch(/shading[^.]*(will not work|fails)/);  // why not the obvious fix
  expect(shape.text).toContain('layers');                  // the measure layers
  expect(shape.text).toMatch(/month, a season/);           // the clock's aggregations
  expect(shape.text).toMatch(/ranking (moves|shifts)/);    // wave vs year
  expect(shape.text).toMatch(/solves again|re-runs the physics/); // what-if
  expect(shape.text).toContain('budget');                  // the portfolio
  expect(shape.text).toMatch(/\bask\b/);                   // the analyst

  /* `range` is deliberately not in this list any more.
   *
   * It asserted that the walkthrough says every cost carries a range, which it
   * did, over a shot of the brief's assumptions table. Both are gone on
   * purpose: a two-minute demo is not where a caveats appendix earns its place,
   * and the sentence about money now plays over the price rather than over the
   * methodology. The labelling itself is unchanged in the panels and in the
   * brief, and is tested where it belongs rather than here.
   */
});

test('the earth turns one way and arrives on New York', async ({ page }) => {
  await openFilm(page);
  await page.click('#film-begin');
  const plan = await page.evaluate(() =>
    window.HC.film.story.beats.map((b) => ({ t0: b.t0, dur: b.dur })));

  /* The x coordinate of the study area in world space.
   *
   * The opening move is a yaw about the polar axis and a pitch about the screen
   * horizontal, and the pitch cannot touch x — so this is the yaw alone, and it
   * runs from negative (the city round the left limb) to zero (the city on the
   * camera axis) if and only if the planet turns one way the whole time.
   *
   * This is the regression. The lock used to be a slerp from a free-running
   * spin toward a fixed "New York faces the camera" quaternion, and slerp takes
   * the short way round — which, from wherever an accumulated spin happened to
   * have reached, was as often backwards as forwards. The globe turned steadily
   * one way, stopped, and swung back.
   */
  const siteX = () => page.evaluate(() => {
    const f = window.HC.film;
    return f._nycLocal.clone().applyMatrix4(f.earthGroup.matrixWorld).x;
  });

  const end = plan[3].t0 + plan[3].dur - 0.05;   // the turn completes on beat 4
  const xs = [];
  for (let k = 0; k <= 14; k++) { await hold(page, (end * k) / 14); xs.push(await siteX()); }

  expect(xs[0]).toBeLessThan(-10);               // it starts round the limb
  // Never backwards. Compared with a tolerance rather than strictly, because the
  // last sample lands on the camera axis where x is zero to within floating
  // point, and two consecutive readings of the same zero differ by about 4e-15
  // in whichever direction the rounding fell. That is not the planet reversing.
  for (let k = 1; k < xs.length; k++) expect(xs[k]).toBeGreaterThan(xs[k - 1] - 1e-9);
  expect(Math.abs(xs.at(-1))).toBeLessThan(0.2); // and arrives on the axis
});

test('the dive is one continuous fall onto New York', async ({ page }) => {
  const { errors } = await openFilm(page);
  await page.click('#film-begin');

  const plan = await page.evaluate(() =>
    window.HC.film.story.beats.map((b) => ({ t0: b.t0, dur: b.dur, phase: b.phase || '' })));
  const handoff = plan.findIndex((b) => b.phase === 'handoff');
  expect(handoff).toBeGreaterThan(0);

  /** Where the study area projects to, in normalised device coordinates. */
  const nyc = () => page.evaluate(() => {
    const f = window.HC.film;
    const p = f._nycLocal.clone().applyMatrix4(f.earthGroup.matrixWorld).project(f.camera);
    return { x: p.x, y: p.y, alt: f.stage.alt, tilt: f.stage.tilt, lock: f.stage.lock };
  });

  // Once locked, New York is dead centre and stays there. The old cut framed it
  // high and then had to swing it back for the dive; the descent is a zoom, and
  // a zoom that has to re-centre what it is zooming into is a zoom you can see.
  await hold(page, plan[handoff - 1].t0 + plan[handoff - 1].dur - 0.2);
  const locked = await nyc();
  expect(locked.lock).toBeCloseTo(1, 2);
  expect(Math.abs(locked.x)).toBeLessThan(0.02);
  expect(Math.abs(locked.y)).toBeLessThan(0.03);

  // Still dead centre on the last frame the globe is drawn on, and still on the
  // axis it was aiming along — the dissolve happens under a camera that never
  // has to re-frame, which is the half of the old continuous descent that
  // survived it.
  await hold(page, plan[handoff].t0 + plan[handoff].dur - 0.05);
  const bottom = await nyc();
  expect(Math.abs(bottom.x)).toBeLessThan(0.01);
  expect(Math.abs(bottom.y)).toBeLessThan(0.03);
  expect(Math.abs(bottom.tilt)).toBeLessThan(0.002);
  // And it arrives: three kilometres up, on scene.js's own opening pose, which
  // is where the walkthrough needs the camera because everything after this
  // happens down there.
  expect(bottom.alt).toBeLessThan(4);

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

// Asserted on the unvoiced cut, because this is a claim about the shape of a
// camera move: chapter two holds two beats, one silent and one spoken, and
// stretching only the spoken one to fit its line changes the ratio between them
// — which is a change in the descent's profile rather than in its design. The
// storyboard is what is under test here, so it is measured on the storyboard's
// own lengths.
test('the descent accelerates out of the hold and never slows or stalls', async ({ page }) => {
  await openFilm(page, '&voice=0');
  await page.click('#film-begin');
  // The fall is chapter two and nothing else. Chapter one drifts down while it
  // talks, which is a held shot, and everything after chapter two happens on
  // the ground.
  const span = await page.evaluate(() => {
    const c = window.HC.film.chapters.find((x) => x.n === 'II');
    return { t0: c.t0, t1: c.t0 + c.dur - 0.05 };
  });
  const { t0, t1 } = span;
  const alts = [];
  for (let k = 0; k <= 16; k++) {
    await hold(page, t0 + ((t1 - t0) * k) / 16);
    alts.push(await page.evaluate(() => window.HC.film.stage.alt));
  }

  // Monotonic: no beat boundary bounces the camera back up, and none of them
  // holds it still either.
  for (let k = 1; k < alts.length; k++) expect(alts[k]).toBeLessThan(alts[k - 1]);

  /* And the shape of it is a rate that only ever goes up.
   *
   * This used to assert the opposite — one constant speed all the way down,
   * with the ends excluded — because the descent used to travel the whole way
   * and arrive, and a fall that arrives has to settle. It does not arrive any
   * more: it stops at three hundred kilometres in the middle of a dissolve, and
   * a globe that slows on its way out reads as having got somewhere. So the
   * claim is now the other one. It comes out of the hold gently, because
   * cutting from a drifting camera to a falling one is a jolt, and it is still
   * gaining speed on the last frame it is drawn.
   *
   * Measured in the log domain, where equal ratios per second are what the eye
   * reads as equal speed.
   */
  const steps = alts.slice(1).map((a, k) => Math.log(alts[k] / a));
  const third = Math.floor(steps.length / 3);
  const early = steps.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const late = steps.slice(-third).reduce((a, b) => a + b, 0) / third;
  expect(late).toBeGreaterThan(early);

  // The slowest thing in the film is the first step, at the bottom of the
  // ease-in where the camera is still travelling at the hold's speed. What it
  // must not be is nothing: an ease-in that starts at zero is a stall with a
  // curve drawn on it.
  expect(Math.min(...steps)).toBeGreaterThan(0.002);

  /* And past the ease-in the acceleration is a lean, not a lurch — no step is
   * twice the one before it, beat boundary included.
   *
   * The boundary is the reason this is asserted at all. `in` is u squared, so a
   * beat that eases in leaves at twice its own average rate, and the first cut
   * of this chapter had the first beat exiting faster than the second beat ran:
   * the camera decelerated by nearly half exactly where the dissolve begins,
   * which is the one place a moving frame cannot afford to look like it has
   * arrived. The altitudes are chosen so that cannot happen, and this is what
   * would catch it coming back.
   */
  const ratios = steps.slice(3).map((v, k) => v / steps[k + 2]);
  expect(Math.max(...ratios)).toBeLessThan(2);
});

test('the film hands the application its own camera, not a cut', async ({ page }) => {
  await openFilm(page);
  await page.click('#film-begin');
  const plan = await page.evaluate(() =>
    window.HC.film.story.beats.map((b) => ({ t0: b.t0, dur: b.dur, phase: b.phase || '' })));
  const handoff = plan.findIndex((b) => b.phase === 'handoff');

  /* Mid-descent, both renderers are drawing the same viewpoint: the film's
   * altitude and stand-off, expressed in the scene's own metres, are where the
   * scene's camera is. That is the whole of the transition — if these two ever
   * disagree, the dissolve is a cut.
   *
   * The sixty-second cut could not afford this and dissolved between two
   * independent pictures instead, because one camera has to travel the whole ten
   * halvings from orbit to Midtown and six seconds could not. Twelve can. The
   * walkthrough also needs the camera genuinely over the city at the end of it,
   * since every beat after this drives the real thing.
   */
  await hold(page, plan[handoff].t0 + plan[handoff].dur * 0.5);
  const mid = await page.evaluate(() => {
    const f = window.HC.film, s = window.HC.scene, st = f.stage;
    const h = st.alt * 1000;
    const lat = h * Math.tan(st.phi);
    return {
      descent: !!s._descent,
      want: [Math.sin(st.az) * lat, h, -Math.cos(st.az) * lat],
      got: s.camera.position.toArray(),
      fov: [st.fov, s.camera.fov],
      basemap: s._basemapK,
    };
  });
  expect(mid.descent).toBe(true);
  expect(mid.basemap).toBe(1);              // the photographic ground is up
  expect(mid.fov[1]).toBeCloseTo(mid.fov[0], 3);
  for (let i = 0; i < 3; i++) expect(mid.got[i]).toBeCloseTo(mid.want[i], 1);

  // The globe is still opaque at that point: the dissolve is late, so what it
  // dissolves off is a moving frame, not an arrival.
  const canvas = await page.evaluate(() =>
    Number(document.getElementById('film-gl').style.opacity || 1));
  expect(canvas).toBeGreaterThan(0.9);
});

test('the handoff starts the city descent and the film clears itself away', async ({ page }) => {
  const { errors } = await openFilm(page);
  await page.click('#film-begin');
  const plan = await page.evaluate(() =>
    window.HC.film.story.beats.map((b) => ({ t0: b.t0, dur: b.dur, phase: b.phase || '' })));
  const handoff = plan.findIndex((b) => b.phase === 'handoff');

  // Landing inside the handoff beat has to put the city camera in the air and
  // under the film's control.
  await seek(page, plan[handoff].t0 + 0.3);
  await page.waitForFunction(() => !!window.HC.scene._descent, null, { timeout: 20_000 });
  const flight = await page.evaluate(() => ({
    y: window.HC.scene.camera.position.y,
    fogFar: window.HC.scene.scene.fog.far,
  }));
  expect(flight.y).toBeGreaterThan(1500);
  // Fog has to open up with the altitude, or a camera tens of kilometres up
  // renders the whole city as one flat wash of fog colour.
  expect(flight.fogFar).toBeGreaterThan(6000);

  // Run out the closing captions.
  await seek(page, plan.at(-1).t0 + plan.at(-1).dur - 0.2);
  await page.waitForFunction(() => !document.getElementById('film'), null, { timeout: 30_000 });
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
  await expect(page.locator('#left')).toBeVisible();
  await expect(page.locator('#time')).toBeVisible();

  // And the descent must have finished rather than leaving the camera adrift.
  await page.waitForFunction(() => !window.HC.scene._fly, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.HC.scene.controls.enabled)).toBe(true);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('skipping goes straight to a usable map', async ({ page }) => {
  const { errors } = await openFilm(page);
  await page.click('#film-straight');
  await page.waitForFunction(() => !document.getElementById('film'), null, { timeout: 20_000 });
  expect(await page.evaluate(() => document.body.classList.contains('film-running'))).toBe(false);
  await expect(page.locator('#left')).toBeVisible();
  // The replay control appears once the film is out of the way.
  await expect(page.locator('#film-replay')).toBeVisible();
  // The scene is at its default framing, not stranded mid-flight.
  expect(await page.evaluate(() => !!window.HC.scene._fly)).toBe(false);
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
});
