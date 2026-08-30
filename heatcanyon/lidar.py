"""2017 airborne LiDAR, rasterised into a real surface model over the AOI.

Why this module exists
----------------------
Every height in this project used to come from one number per building:
``height_roof`` out of the NYC footprint table, extruded flat. That is a
LoD 1.5 model — one horizontal lid per polygon — and Midtown is the worst
possible place to accept it. The 1916 zoning resolution produced a
neighbourhood of wedding-cake towers, so a very large share of the buildings
here step back two, three, four times on the way up. A flat lid at the roof
height erases every one of those setbacks.

Setbacks are not cosmetic for this model. They are the mechanism by which sky
reaches the upper facade bands and by which sun reaches down into a canyon, so
erasing them biases the two quantities the project exists to compute: the wall
sky view factor and which bands are sunlit at which hour.

The obvious fix — DOITT's "NYC 3-D Building Model" — does not work. Its own
metadata says most buildings are LoD 1.5 with "domes and pitched roofs not
rendered", ~100 iconic buildings at LoD 2, from a 2014 survey. Swapping a
LoD 1.5 extrusion for a LoD 1.5 mesh buys nothing. The three NYS elevation
services are all bare-earth DEMs (their NYC maximum is ~126 m, i.e. terrain
with every building stripped out), so they are useless for roofs too.

That leaves the point cloud, which is the real thing: USGS 3DEP's
``NY_NewYorkCity`` collection, published as Entwine Point Tiles. Because EPT is
an octree with a JSON hierarchy, only the nodes overlapping Midtown need
fetching — about 164 MB for this AOI rather than the full 4.75-billion-point
collection.

The 2017 vintage problem
------------------------
The cloud is eight years old, and Midtown has built since: One Vanderbilt
(2020) stands 427 m directly over Grand Central, inside this AOI, and did not
exist when the plane flew. So LiDAR cannot simply replace the footprint
heights — on new construction it would report the demolished predecessor, or
bare ground.

The resolution is to let each source do what it is actually good at. The
footprint table is authoritative for *how tall* a building is, because it is
maintained and current. The LiDAR is authoritative for *what shape* the
building is between the ground and that height, because it measured it. So
every building is gated: the cloud's robust height is compared against the
footprint height, and the LiDAR profile is accepted only where the two agree.
Where they disagree the building has changed since 2017 and it falls back to
the flat extrusion, which is exactly the old behaviour. Nothing regresses; the
unchanged ~95% of Midtown gains its real massing.

Noise
-----
Classes 7 and 18 (low/high noise) are dropped outright — without that a single
spurious return puts a 500 m needle through a brownstone, and because the
shadow tracer honours the tallest cell along a ray, one needle draws a long
false shadow across the neighbourhood. Class 9 (water) is dropped as well.
A per-building ceiling then clips whatever survives classification, so real
spires are kept while isolated fliers are not.
"""

from __future__ import annotations

import concurrent.futures as futures
import io
import json
import math
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import geometry as G

EPT_ROOT = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/NY_NewYorkCity"
CACHE = Path("data/lidar")
UA = "heatcanyon/1.0 (urban heat research)"

#: ASPRS classes to discard before anything else looks at the points.
#: 7 = low noise, 18 = high noise, 9 = water.
NOISE_CLASSES = (7, 9, 18)

#: Octree depth to descend to. Node post-spacing is cube/(256 * 2**depth) in
#: EPSG:3857 units; at depth 8 that is ~0.96 Mercator units, and Mercator is
#: inflated by 1/cos(lat) here, so ~0.73 m on the ground. Against the 3 m
#: physics grid that is ~17 returns per cell, which makes a per-cell maximum a
#: stable statistic rather than a coin flip.
DEFAULT_DEPTH = 8


# --------------------------------------------------------------- EPT plumbing


def _get(url: str, tries: int = 4, timeout: float = 180.0) -> bytes:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001 — retry any transport failure
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url[:200]}\n  {last}")


def _cached(rel: str) -> bytes:
    """Fetch ``rel`` from the EPT bucket, memoised on disk.

    The cache is deliberately the raw ``.laz`` bytes rather than decoded
    arrays: it keeps a rebuild fully offline (the same guarantee the rest of
    the pipeline makes) without committing to any particular grid resolution,
    so the raster can be recomputed at a different res without re-downloading.
    """
    path = CACHE / rel
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    raw = _get(f"{EPT_ROOT}/{rel}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return raw


@dataclass
class _Octree:
    bounds: list[float]
    size: float

    def node_xy(self, depth: int, x: int, y: int) -> tuple[float, float, float, float]:
        s = self.size / (2**depth)
        return (
            self.bounds[0] + x * s,
            self.bounds[1] + y * s,
            self.bounds[0] + (x + 1) * s,
            self.bounds[1] + (y + 1) * s,
        )


def _select_nodes(
    tree: _Octree,
    aoi_3857: tuple[float, float, float, float],
    max_depth: int,
) -> dict[str, int]:
    """Octree keys whose XY extent overlaps the AOI, down to ``max_depth``.

    EPT is cumulative: the points at depths 0..d together form the cloud at
    depth d's resolution, so every ancestor level is kept rather than only the
    leaves. Hierarchy pages are loaded lazily — a count of -1 means "this
    subtree is described in its own page" — which is what keeps this to ~17
    small JSON fetches instead of walking the hierarchy for all of New York.
    """
    hier: dict[str, int] = {}

    def load(key: str) -> None:
        hier.update(json.loads(_cached(f"ept-hierarchy/{key}.json")))

    load("0-0-0-0")
    selected: dict[str, int] = {}
    frontier = ["0-0-0-0"]

    while frontier:
        nxt: list[str] = []
        for key in frontier:
            depth, x, y, _z = (int(v) for v in key.split("-"))
            x0, y0, x1, y1 = tree.node_xy(depth, x, y)
            if x1 <= aoi_3857[0] or x0 >= aoi_3857[2]:
                continue
            if y1 <= aoi_3857[1] or y0 >= aoi_3857[3]:
                continue
            count = hier.get(key)
            if count is None:
                continue
            if count == -1:
                load(key)
                count = hier.get(key, 0)
                if count in (None, 0, -1):
                    continue
            selected[key] = int(count)
            if depth < max_depth:
                for dx in (0, 1):
                    for dy in (0, 1):
                        for dz in (0, 1):
                            nxt.append(
                                f"{depth + 1}-{2 * x + dx}-{2 * y + dy}-{2 * _z + dz}"
                            )
        frontier = nxt
    return selected


# ------------------------------------------------------------- the surface


@dataclass
class Surface:
    """Highest-hit and ground elevations on the physics grid, in metres.

    Both are absolute elevations on the LiDAR's vertical datum, not heights
    above ground, because the two are needed separately: the footprint table
    carries its own ``base_m`` ground elevation, and comparing that against a
    LiDAR-derived ground is how a datum mismatch would be caught.
    """

    top: np.ndarray          # (ny, nx) float32, NaN where no returns landed
    ground: np.ndarray       # (ny, nx) float32, NaN where no class-2 returns
    count: np.ndarray        # (ny, nx) int32, returns per cell
    res: float
    x0: float
    y0: float
    n_points: int
    n_nodes: int

    @property
    def coverage(self) -> float:
        return float(np.isfinite(self.top).mean())


def _reduce_max(grid: np.ndarray, idx: np.ndarray, vals: np.ndarray) -> None:
    if idx.size == 0:
        return
    order = np.argsort(idx, kind="stable")
    idx_s, vals_s = idx[order], vals[order]
    starts = np.flatnonzero(np.r_[True, idx_s[1:] != idx_s[:-1]])
    cells = idx_s[starts]
    runs = np.fmax.reduceat(vals_s, starts)
    flat = grid.reshape(-1)
    np.fmax(flat[cells], runs, out=runs)
    flat[cells] = runs


def _reduce_min(grid: np.ndarray, idx: np.ndarray, vals: np.ndarray) -> None:
    if idx.size == 0:
        return
    order = np.argsort(idx, kind="stable")
    idx_s, vals_s = idx[order], vals[order]
    starts = np.flatnonzero(np.r_[True, idx_s[1:] != idx_s[:-1]])
    cells = idx_s[starts]
    runs = np.fmin.reduceat(vals_s, starts)
    flat = grid.reshape(-1)
    np.fmin(flat[cells], runs, out=runs)
    flat[cells] = runs


def _reduce_count(grid: np.ndarray, idx: np.ndarray) -> None:
    if idx.size == 0:
        return
    grid.reshape(-1)[:] += np.bincount(idx, minlength=grid.size).astype(np.int32)


def surface_for(
    dsm: G.DSM,
    proj: G.Projector,
    max_depth: int = DEFAULT_DEPTH,
    workers: int = 8,
    log=print,
) -> Surface:
    """Rasterise the LiDAR onto ``dsm``'s exact grid.

    Sharing the grid with the DSM rather than introducing a second one is the
    whole point: the refined heights have to line up cell-for-cell with the
    footprint ``building_id`` raster, or the two could not be combined.
    """
    import laspy  # local import: only a LiDAR build needs the dependency
    from pyproj import Transformer

    ny, nx = dsm.shape
    ept = json.loads(_cached("ept.json"))
    tree = _Octree(bounds=list(map(float, ept["bounds"])),
                   size=float(ept["bounds"][3] - ept["bounds"][0]))

    # Grid corners -> lon/lat -> Web Mercator, to pick octree nodes. The AOI is
    # axis-aligned in the local frame and Mercator is conformal and
    # north-aligned, so a corner-derived bbox is tight enough for node
    # selection (a slightly generous bbox only costs a few extra nodes).
    to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    xs_l, ys_l = [], []
    for gx in (dsm.x0, dsm.x0 + nx * dsm.res):
        for gy in (dsm.y0, dsm.y0 + ny * dsm.res):
            lon, lat = proj.to_lonlat(gx, gy)
            mx, my = to_3857.transform(lon, lat)
            xs_l.append(mx)
            ys_l.append(my)
    aoi_3857 = (min(xs_l), min(ys_l), max(xs_l), max(ys_l))

    nodes = _select_nodes(tree, aoi_3857, max_depth)
    expected = sum(nodes.values())
    log(f"LiDAR: {len(nodes)} EPT nodes to depth {max_depth}, ~{expected:,} returns")

    top = np.full((ny, nx), np.nan, dtype=np.float32)
    ground = np.full((ny, nx), np.nan, dtype=np.float32)
    count = np.zeros((ny, nx), dtype=np.int32)
    to_wgs = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)

    def load(key: str) -> bytes:
        return _cached(f"ept-data/{key}.laz")

    n_points = 0
    done = 0
    # Downloads are IO-bound and decoding releases the GIL inside lazrs, so a
    # thread pool is enough; the reduction stays on this thread so the grids
    # need no locking.
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for key, raw in zip(nodes, pool.map(load, list(nodes))):
            las = laspy.read(io.BytesIO(raw))
            cls = np.asarray(las.classification)
            keep = ~np.isin(cls, NOISE_CLASSES)
            if not keep.any():
                done += 1
                continue
            mx = np.asarray(las.x)[keep]
            my = np.asarray(las.y)[keep]
            mz = np.asarray(las.z)[keep].astype(np.float32)
            cls = cls[keep]

            lon, lat = to_wgs.transform(mx, my)
            gx = (np.asarray(lon) - proj.lon0) * proj.mx
            gy = (np.asarray(lat) - proj.lat0) * proj.my
            j = np.floor((gx - dsm.x0) / dsm.res).astype(np.int64)
            i = np.floor((gy - dsm.y0) / dsm.res).astype(np.int64)
            inside = (i >= 0) & (i < ny) & (j >= 0) & (j < nx)
            if not inside.any():
                done += 1
                continue
            flat = (i[inside] * nx + j[inside]).astype(np.int64)
            zs = mz[inside]
            _reduce_max(top, flat, zs)
            _reduce_count(count, flat)

            is_ground = cls[inside] == 2
            if is_ground.any():
                _reduce_min(ground, flat[is_ground], zs[is_ground])

            n_points += int(inside.sum())
            done += 1
            if done % 100 == 0 or done == len(nodes):
                log(f"  LiDAR {done}/{len(nodes)} nodes, {n_points:,} returns on grid")

    surf = Surface(top=top, ground=ground, count=count, res=dsm.res,
                   x0=dsm.x0, y0=dsm.y0, n_points=n_points, n_nodes=len(nodes))
    log(f"LiDAR: {n_points:,} returns on grid, {surf.coverage * 100:.1f}% of cells hit")
    return surf


# ------------------------------------------------------- combining the two


@dataclass
class RefineReport:
    """What the gate decided, so the result is auditable rather than magic."""

    n_buildings: int
    n_refined: int
    n_flat_no_data: int
    n_flat_new_build: int
    n_relevelled: int
    n_truncation_repaired: int
    truncation_repairs: list[dict]
    setback_buildings: int
    median_setback_depth_m: float
    clamped_cell_fraction: float
    examples: list[dict]

    def as_dict(self) -> dict:
        return {
            "buildings": self.n_buildings,
            "refined_from_lidar": self.n_refined,
            "flat_no_lidar": self.n_flat_no_data,
            "flat_built_since_2017": self.n_flat_new_build,
            "relevelled_to_lidar": self.n_relevelled,
            "truncation_repaired": self.n_truncation_repaired,
            "truncation_repairs": self.truncation_repairs,
            "buildings_with_setbacks": self.setback_buildings,
            "median_setback_depth_m": round(self.median_setback_depth_m, 1),
            "clamped_cell_fraction": round(self.clamped_cell_fraction, 4),
            "examples": self.examples,
        }


def _shift(a: np.ndarray, dy: int, dx: int, fill: float) -> np.ndarray:
    """Translate ``a`` by (dy, dx), padding the vacated edge with ``fill``."""
    out = np.full_like(a, fill)
    ys = slice(max(dy, 0), a.shape[0] + min(dy, 0))
    xs = slice(max(dx, 0), a.shape[1] + min(dx, 0))
    yd = slice(max(-dy, 0), a.shape[0] + min(-dy, 0))
    xd = slice(max(-dx, 0), a.shape[1] + min(-dx, 0))
    out[ys, xs] = a[yd, xd]
    return out


_NEIGHBOURS = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy, dx) != (0, 0)]


def refine_dsm(
    dsm: G.DSM,
    surf: Surface,
    buildings: list[dict],
    min_returns: int = 40,
    abs_tol_m: float = 6.0,
    rel_tol: float = 0.18,
    setback_threshold_m: float = 6.0,
    truncated_frac: float = 0.25,
    min_repair_m: float = 25.0,
    height_trusted: list | None = None,
    log=print,
) -> tuple[G.DSM, RefineReport]:
    """Replace flat lids with measured roof profiles, on the same grid.

    The gate is deliberately **asymmetric**, because the two sources fail in
    opposite directions and a symmetric comparison cannot tell those failures
    apart. Measured on this AOI, a symmetric gate rejected 51% of buildings,
    including ones built in 1900–1930 that plainly have not changed.

    Downward disagreement is real. If the cloud's robust height sits far
    *below* the maintained table height, the building did not exist in 2017 —
    One Vanderbilt reads 96 m against its true 427 m, a 2020 tower reads 2 m of
    bare site. Those buildings must keep the flat extrusion.

    Upward disagreement is almost never real. Airborne LiDAR returns off a
    tower's flank land, in plan, inside its low neighbour's footprint, so a
    1924 brownstone reads 106 m; and podium/tower footprint pairs put a 243 m
    tower's returns inside a 48 m podium polygon. Rather than trying to
    diagnose those cases, the profile is simply clamped to the table height.
    That single clamp removes the entire class of error, and it follows from
    the division of labour this module is built on: the footprint table is
    authoritative for *how tall*, the cloud for *what shape below that*.

    A grayscale closing then runs over the setback depth, so an isolated cell
    that missed its return cannot punch a one-cell pit into an otherwise flat
    roof, while genuine setbacks — which are tens of metres across — survive
    untouched. Without it, scan shadowing beside tall neighbours speckles
    roofs with false holes, and each hole leaks sky into the SVF integral.

    ``dsm.building_id`` is passed through unchanged, which is what lets facade
    panels, canyon cross-sections and per-building scores keep their identity
    across this change.
    """
    ny, nx = dsm.shape
    bid = dsm.building_id
    built = bid >= 0
    h_flat = dsm.height                      # flat lids, the current behaviour

    # Per-cell ground datum and table height, gathered through building_id.
    n_b = len(buildings)
    base_of = np.zeros(n_b + 1, dtype=np.float32)
    hgt_of = np.zeros(n_b + 1, dtype=np.float32)
    for i, b in enumerate(buildings):
        base_of[i] = float(b.get("base_m") or 0.0)
        hgt_of[i] = float(b["height_m"])
    gather = np.where(built, bid, n_b)
    base_grid = base_of[gather]
    h_table = hgt_of[gather]

    # LiDAR height above this building's own ground.
    h_lidar = surf.top - base_grid
    has_return = np.isfinite(surf.top) & (surf.count > 0) & built

    # ---- the gate, per building -------------------------------------------
    # Interior cells (all eight neighbours share the building) exclude the
    # footprint edge, where facade returns and neighbour bleed concentrate.
    interior = built.copy()
    for dy, dx in _NEIGHBOURS:
        interior &= _shift(bid, dy, dx, -1) == bid
    interior &= has_return

    flat_bid = bid.reshape(-1)
    flat_rel = (h_lidar - 0.0).reshape(-1)
    flat_ret = has_return.reshape(-1)
    flat_int = interior.reshape(-1)
    returns_flat = surf.count.reshape(-1)

    tol = np.maximum(abs_tol_m, rel_tol * hgt_of[:n_b])

    gate = np.full(n_b, np.nan, dtype=np.float64)
    over_frac = np.zeros(n_b, dtype=np.float64)
    n_ret = np.zeros(n_b, dtype=np.int64)
    order = np.argsort(flat_bid, kind="stable")
    bid_s = flat_bid[order]
    first = np.searchsorted(bid_s, np.arange(n_b), side="left")
    last = np.searchsorted(bid_s, np.arange(n_b), side="right")
    for i in range(n_b):
        cells = order[first[i]:last[i]]
        if cells.size == 0:
            continue
        n_ret[i] = int(returns_flat[cells].sum())
        use = cells[flat_int[cells]]
        if use.size < 3:
            use = cells[flat_ret[cells]]
        if use.size >= 3:
            gate[i] = float(np.percentile(flat_rel[use], 98.0))
            # How much of this footprint — not just its edge — stands above the
            # table height. See `truncated` below for why the distinction is
            # the whole ballgame.
            over_frac[i] = float(np.mean(flat_rel[use] > hgt_of[i] + tol[i]))

    too_few = (n_ret < min_returns) | ~np.isfinite(gate)
    short = ~too_few & (gate < hgt_of[:n_b] - tol)

    # A cloud reading far below the table height has two very different causes,
    # and construction year separates them.
    #
    # If the building postdates the flight it genuinely was not there, and the
    # table height is the only truth available — stay flat.
    #
    # If it predates the flight, it was standing and measured, so a low reading
    # means the *table* is wrong for this polygon. The usual cause is structural:
    # ``nyc.footprints`` gives every ring of a MultiPolygon the whole building's
    # height, so a tower's podium ring claims the tower's height. Clamping such a
    # ring to its table value would keep a 425 m lid over a 30 m podium. Trusting
    # the cloud and clamping to the measured height instead carves the podium back
    # down to what it is.
    year = np.array([float(b.get("year") or 0) for b in buildings], dtype=np.float64)
    predates_flight = (year > 0) & (year < 2015)
    new_build = short & ~predates_flight
    relevel = short & predates_flight

    # ---- and the same disagreement in the other direction -----------------
    #
    # The clamp above treats *all* upward disagreement as bleed, and for almost
    # every building that is right: a tower's flank returns land, in plan,
    # inside its low neighbour's footprint, which is what made a 1924 brownstone
    # read 106 m. But it is not always right. Where a footprint is joined to the
    # infrastructure lot beneath it — Midtown has a run of these over the Grand
    # Central and Penn rail yards — the city records a height for the podium and
    # the table is simply short of the building. Clamping there discards a real
    # tower: the MetLife Building is carried as 47.9 m against an actual 246 m,
    # so two hundred metres of facade is never solved and never coloured.
    #
    # `interior` is what separates the two, and it is already computed for
    # exactly this reason. Bleed arrives at the footprint *edge*, where a
    # neighbour's flank overhangs; a genuinely truncated footprint stands above
    # the table height across its whole area. Measured on this AOI:
    #
    #     MetLife           45.6% of interior cells above table + tol
    #     450 Lexington     89.4%
    #     230 Park Ave       2.2%   (correct height, tower next door)
    #     Grand Central      1.9%   (correct height, towers all around)
    #
    # A twenty-fold separation, so the threshold is not delicate. Buildings that
    # pass it take the cloud's 98th percentile as their height, the same figure
    # and the same reasoning `relevel` uses in the opposite direction.
    # ...but only where the table height has nothing vouching for it.
    #
    # This condition is the whole difference between a repair and a wrecking
    # ball, and it was learned the expensive way. Without it the gate fired on
    # 864 of 5,329 footprints. Checked against PLUTO's own floor count — an
    # independent record the cloud knows nothing about — the *old* height was
    # closer to `floors x 3.2 m` in 88% of the cases PLUTO could adjudicate,
    # and the discrepancy got worse for bigger repairs, not better. The gate was
    # confidently rewriting buildings that were right.
    #
    # What PLUTO can adjudicate is exactly the point. A footprint whose BBL
    # carries a floor count is one whose join to the tax lot worked, and a
    # working join is itself evidence that `height_roof` describes this
    # building. The truncated ones are the opposite case by construction: the
    # footprint is joined to the infrastructure lot underneath it, which is a
    # viaduct or a rail yard and has no floors at all. MetLife and 450
    # Lexington both report `floors = None` for precisely that reason.
    #
    # So: repair only where nothing independent vouches for the height, the
    # cloud disagrees across the footprint's interior rather than its edge, and
    # the disagreement is structural rather than a parapet or a water tank.
    # That takes 864 down to 85, keeps both hand-verified towers, and stops the
    # gate touching a single building PLUTO could have defended.
    trusted = np.zeros(n_b, dtype=bool)
    if height_trusted is not None:
        trusted[:min(n_b, len(height_trusted))] = np.asarray(
            height_trusted[:n_b], dtype=bool)

    truncated = (~too_few & np.isfinite(gate) & ~trusted
                 & (over_frac >= truncated_frac)
                 & (gate > hgt_of[:n_b] + tol)
                 & (gate - hgt_of[:n_b] >= min_repair_m))

    # The correction has to reach the *table*, not just this raster. Facade
    # panels, floor counts, the massing grid and every per-building score read
    # `height_m` (see pipeline.py), so a taller lid here with a short record
    # beside it would leave the geometry and the physics disagreeing about the
    # same building. Writing it back is why this mutates `buildings`, which is
    # otherwise read-only to this function — hence saying so loudly.
    corrected: list[dict] = []
    for i in np.flatnonzero(truncated):
        b = buildings[int(i)]
        was = float(b["height_m"])
        now = float(gate[i])
        b["height_m"] = round(now, 2)
        b["top_m"] = round(float(b.get("base_m") or 0.0) + now, 2)
        b["height_src"] = "lidar_truncation_repair"
        corrected.append({"bin": b.get("bin"), "was_m": round(was, 1),
                          "now_m": round(now, 1),
                          "interior_over": round(float(over_frac[i]), 3)})
    hgt_of[:n_b] = np.array([float(b["height_m"]) for b in buildings],
                            dtype=np.float32)
    h_table = hgt_of[gather]
    if corrected:
        log(f"LiDAR: repaired {len(corrected)} truncated footprint heights "
            f"(largest {max(c['now_m'] - c['was_m'] for c in corrected):.0f} m)")

    accept = ~too_few & ~new_build

    accept_of = np.zeros(n_b + 1, dtype=bool)
    accept_of[:n_b] = accept
    accept_grid = accept_of[gather] & built

    # Ceiling per building: the table height, except where the cloud overrules it.
    ceil_of = np.zeros(n_b + 1, dtype=np.float32)
    ceil_of[:n_b] = np.where(relevel | truncated, gate, hgt_of[:n_b]).astype(np.float32)
    h_ceiling = ceil_of[gather]

    # ---- build the profile -------------------------------------------------
    # Clamp from above (kills bleed), floor at zero, and express as a setback
    # depth below the table height so the morphological filter operates on a
    # quantity that is 0 on an unmodified roof and cannot carry a neighbour's
    # absolute height across a footprint boundary.
    usable = accept_grid & has_return
    clamped = np.clip(h_lidar, 0.0, h_ceiling)
    n_clamp = int((usable & (h_lidar > h_ceiling + 0.5)).sum())

    deficit = np.where(usable, h_ceiling - clamped, 0.0).astype(np.float32)

    # Grayscale opening on the deficit: erode then dilate. Erosion treats
    # everything outside the building as zero depth, so a setback is trimmed at
    # the footprint edge rather than bleeding outward; dilation is masked back
    # to built cells.
    eroded = deficit.copy()
    for dy, dx in _NEIGHBOURS:
        np.minimum(eroded, _shift(deficit, dy, dx, 0.0), out=eroded)
    opened = eroded.copy()
    for dy, dx in _NEIGHBOURS:
        np.maximum(opened, _shift(eroded, dy, dx, 0.0), out=opened)
    opened = np.where(accept_grid, opened, 0.0)

    height = np.where(accept_grid, np.maximum(h_ceiling - opened, 0.0), h_flat)
    height = np.where(built, height, 0.0).astype(np.float32)

    # ---- report ------------------------------------------------------------
    depths: list[float] = []
    setbacks = 0
    for i in range(n_b):
        if not accept[i]:
            continue
        cells = order[first[i]:last[i]]
        if cells.size == 0:
            continue
        prof = height.reshape(-1)[cells]
        depth = float(prof.max() - np.percentile(prof, 10.0))
        if depth >= setback_threshold_m:
            setbacks += 1
            depths.append(depth)

    examples: list[dict] = []
    for i in np.argsort(-(hgt_of[:n_b] * new_build))[:6]:
        if new_build[i]:
            b = buildings[i]
            examples.append({
                "bin": b.get("bin"), "name": b.get("name"),
                "table_h": round(float(hgt_of[i]), 1),
                "lidar_h": round(float(gate[i]), 1),
                "year": b.get("year"), "verdict": "flat: built since the 2017 flight",
            })

    report = RefineReport(
        n_buildings=n_b, n_refined=int(accept.sum()),
        n_flat_no_data=int(too_few.sum()), n_flat_new_build=int(new_build.sum()),
        n_relevelled=int(relevel.sum()),
        n_truncation_repaired=len(corrected),
        truncation_repairs=corrected,
        setback_buildings=setbacks,
        median_setback_depth_m=float(np.median(depths)) if depths else 0.0,
        clamped_cell_fraction=float(n_clamp / max(1, int(usable.sum()))),
        examples=examples,
    )
    log(f"LiDAR refine: {report.n_refined:,} buildings took measured roofs "
        f"({setbacks:,} with real setbacks, median depth "
        f"{report.median_setback_depth_m:.0f} m), {report.n_flat_new_build:,} kept "
        f"flat as built since 2017, {report.n_relevelled:,} relevelled to the "
        f"cloud, {report.n_truncation_repaired:,} repaired from a truncated "
        f"footprint height, {report.n_flat_no_data:,} had too few returns")
    return (
        G.DSM(height=height, building_id=dsm.building_id, res=dsm.res,
              x0=dsm.x0, y0=dsm.y0),
        report,
    )
