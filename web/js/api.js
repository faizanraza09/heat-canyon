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
