/* Where the API lives, which is not always where the page lives.
 *
 * Run locally, `heatcanyon serve` is one process: it hands out index.html, the
 * solved fields under /data, and answers /api/* — all the same origin, and every
 * fetch in this application could be a root-relative path with no ceremony.
 *
 * Deployed, it is two. The interface and the 189 MB of solved fields are static
 * files and belong on a CDN, where they cost nothing to serve and arrive from
 * the nearest city. The API is a Python process that re-solves the energy
 * balance and drives the analyst, and it belongs on something with memory and a
 * CPU. Splitting them is not an optimisation — a container that also serves
 * 189 MB of binaries pays egress on every visit for bytes that never change.
 *
 * So /data stays relative (it sits beside the page, wherever the page is) and
 * /api gets an explicit origin. The origin is injected into index.html at
 * deploy time as `window.__API_BASE__`; with nothing injected this returns the
 * empty string and every path stays root-relative, which is exactly the
 * single-origin behaviour a laptop wants. Local development is unaffected and
 * needs no configuration to stay that way.
 *
 * The server sets CORS to allow any origin, so the cross-origin case needs
 * nothing else — with one exception worth knowing: EventSource cannot carry
 * credentials cross-origin, and the analyst's transcript stream relies on that
 * being fine, because the run id in the URL is the only thing it needs.
 */

const RAW = (typeof window !== 'undefined' && window.__API_BASE__) || '';

/** No trailing slash, so `API + '/api/health'` never doubles up. */
export const API = String(RAW).replace(/\/+$/, '');

/**
 * Resolve an API path against the configured origin.
 *
 * Accepts the root-relative form used everywhere in this codebase
 * (`/api/health`) and the occasional page-relative one (`./api/config`), and
 * normalises both, so a call site does not have to know which it wrote.
 */
export function api(path) {
  const p = String(path).replace(/^\.\//, '/');
  return API + (p.startsWith('/') ? p : `/${p}`);
}

/* WHO IS ASKING, for the analyst's endpoints only.
 *
 * The server scopes a transcript to the console that started it, so that two
 * strangers with this demo open do not read each other's questions — people put
 * their own building into that box. It needs an id to scope by, and there are no
 * accounts here, so the console makes one and keeps it.
 *
 * Not a credential and not pretending to be: anyone can send anyone's id. What
 * it removes is the default in which every visitor saw every question ever asked
 * of this server. Real identity needs an identity provider; see
 * heatcanyon/agent/gate.py, which says the same from the other side.
 *
 * localStorage so that a reload keeps your own history, in a try/catch because a
 * private window throws on access rather than returning null.
 */
const CLIENT_KEY = 'hc.agent.client';

export const clientId = (() => {
  const make = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) { id = make(); localStorage.setItem(CLIENT_KEY, id); }
    return id;
  } catch {
    return make();      // a fresh id per load, which still scopes within the load
  }
})();

/** The token a private deployment injects beside `__API_BASE__`. Absent on a
 *  public build, where the rate limiter is what does the work. */
const TOKEN = (typeof window !== 'undefined' && window.__AGENT_TOKEN__) || '';

/** Headers every analyst request carries. Spread into a fetch init. */
export function agentHeaders(extra) {
  const h = { 'X-HC-Client': clientId, ...(extra || {}) };
  if (TOKEN) h['X-HC-Token'] = TOKEN;
  return h;
}

/** The same, as query parameters, for EventSource — which cannot send headers
 *  at all, so the transcript stream has nowhere else to put them. */
export function agentUrl(path) {
  const u = api(path);
  const q = new URLSearchParams({ client: clientId });
  if (TOKEN) q.set('token', TOKEN);
  return `${u}${u.includes('?') ? '&' : '?'}${q}`;
}
