/* Where a highlight goes, given the things it is meant to be around.
 *
 * Two callers want the same answer and got it from one implementation that
 * lived inside the tour: the onboarding tour, which points at a control and
 * explains it, and the opening film, whose walkthrough names a panel every few
 * seconds and needs the viewer to know which one. Neither can do its job with a
 * caption alone — "the floor schedule" is only a phrase until the floor
 * schedule is the lit thing on a dimmed screen.
 *
 * The interesting part is not the union of the boxes, it is the clip. A control
 * near the foot of the left rail's scrolling body, or a section four thousand
 * pixels down the building brief, has a bounding box that is perfectly real and
 * mostly outside the pane it lives in. Highlighting that box draws a rectangle
 * hanging off the bottom of the panel around nothing at all. So the union is
 * clipped to the nearest scrolling ancestor, and the highlight stops at the
 * panel edge the way a reader's eye does.
 *
 * If the clip leaves nothing — the target is scrolled clean out of view and a
 * smooth scroll has not arrived yet — the unclipped box stands and the next
 * frame corrects it. That is deliberate: a highlight that vanishes for three
 * frames mid-glide reads as a bug, and one that is briefly in the wrong place
 * reads as motion.
 */

/** The nearest ancestor that scrolls, or null. */
function clipRect(node) {
  for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n);
    if (/(auto|scroll|hidden)/.test(o.overflowY + o.overflowX)) {
      return n.getBoundingClientRect();
    }
  }
  return null;
}

/** Resolve a target spec to the nodes that are actually on screen.
 *
 *  A spec is a selector, a function returning a node, or an array of either.
 *  Anything hidden, inside something hidden, or collapsed to nothing is dropped
 *  rather than highlighted — a step whose control is not in this build should
 *  light nothing instead of lighting the top-left corner.
 */
export function targetsOf(spec) {
  if (!spec) return [];
  const one = (t) => {
    const n = typeof t === 'function' ? t() : document.querySelector(t);
    if (!n) return null;
    if (n.hidden || n.closest('[hidden]')) return null;
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return n;
  };
  return (Array.isArray(spec) ? spec : [spec]).map(one).filter(Boolean);
}

/** The box to light, in viewport coordinates, padded and clipped. Null if the
 *  spec resolves to nothing. */
export function boxOf(spec, pad = 8) {
  const ns = targetsOf(spec);
  if (!ns.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const n of ns) {
    const q = n.getBoundingClientRect();
    l = Math.min(l, q.left); t = Math.min(t, q.top);
    r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  const c = clipRect(ns[0]);
  if (c) {
    const cl = Math.max(l, c.left), ct = Math.max(t, c.top);
    const cr = Math.min(r, c.right), cb = Math.min(b, c.bottom);
    if (cr - cl > 8 && cb - ct > 8) { l = cl; t = ct; r = cr; b = cb; }
  }
  /* Clamped to the screen, and refused if none of it is on the screen.
   *
   * This is the bug that made the tour dim the very thing it was pointing at.
   * The dim is painted as a 9,999-pixel shadow *around* the highlight, so the
   * highlight is a hole — and a hole positioned below the fold is no hole at
   * all. Two of the tour's steps target a whole scrolling pane, `#tab-whatif`
   * being 2,400 pixels of it, and while the smooth scroll that brings it into
   * view is still running the box can sit entirely past the bottom of the
   * window: measured at y = 1411 to 2407 in a 1000-pixel viewport. The screen
   * went uniformly grey, including the panel the card was explaining, and it
   * varied run to run because it depended on where the scroll had got to.
   *
   * Clamping keeps the lit region on the part of the target a viewer can
   * actually see. Returning null when there is nothing left tells the caller to
   * hide the spotlight — and hiding it removes the dim with it, which is the
   * right failure: an undimmed screen with no highlight reads as "no particular
   * thing", where a fully dimmed one reads as broken.
   */
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.max(2, l - pad), top = Math.max(2, t - pad);
  let right = Math.min(vw - 2, r + pad), bottom = Math.min(vh - 2, b + pad);
  if (right - left < 8 || bottom - top < 8) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Put a spotlight element over `spec`, or hide it if there is nothing to light.
 *
 *  Returns the box it settled on, so a caller that wants to keep the highlight
 *  true while a panel scrolls under it can compare frames cheaply.
 */
export function place(el, spec) {
  if (!el) return null;
  const box = boxOf(spec);
  if (!box) { el.hidden = true; return null; }
  el.hidden = false;
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  return box;
}
