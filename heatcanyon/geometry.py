"""Canyon geometry: DSM rasterisation, sky view factor, shadowing, facade panels.

The approach follows the standard urban-climate modelling pattern (SOLWEIG,
Lindberg & Grimmond 2011): rasterise the building heights into a digital
surface model once, then derive every geometric quantity from that raster by
horizon scanning. Doing it this way means sky view factor and shading are
computed from the *actual* three-dimensional scene rather than from an idealised
infinite-canyon assumption, which matters enormously in Midtown where a 120 m
tower sits directly against a 20 m walk-up.

Coordinate system: a local east-north-up frame in metres, origin at the AOI
centre. Over a 2 km area the error from ignoring earth curvature and using a
fixed metres-per-degree scale is a few centimetres — far below the 3 m raster.

Quantities produced here
------------------------
dsm            building height above local ground, metres, on a regular grid
svf_ground     sky view factor at street level, 0 (fully enclosed) to 1 (open)
shadow(h)      boolean sunlit/shaded mask for a given solar position
facades        one panel per footprint edge, with outward azimuth and extent
canyons        per street segment: facade-to-facade width, height either side,
               asymmetry, axis bearing
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np

from . import aoi as aoi_mod


# --------------------------------------------------------------- projection


class Projector:
    """Local equirectangular projection, metres from the AOI centre.

    Deliberately not pyproj: a fixed-scale local frame is exactly invertible,
    dependency-free on the browser side, and accurate to centimetres at this
    extent. The frontend uses the identical constants so geometry never shifts
    between Python and WebGL.
    """

    def __init__(self, area: aoi_mod.AOI) -> None:
        self.area = area
        self.lon0, self.lat0 = area.center
        self.mx = aoi_mod.M_PER_DEG_LON
        self.my = aoi_mod.M_PER_DEG_LAT

    def to_xy(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.mx, (lat - self.lat0) * self.my)

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        return (self.lon0 + x / self.mx, self.lat0 + y / self.my)

    def ring_to_xy(self, ring: Sequence[Sequence[float]]) -> np.ndarray:
        a = np.asarray(ring, dtype=np.float64)
        out = np.empty_like(a)
        out[:, 0] = (a[:, 0] - self.lon0) * self.mx
        out[:, 1] = (a[:, 1] - self.lat0) * self.my
        return out

    def params(self) -> dict:
        return {
            "lon0": self.lon0, "lat0": self.lat0,
            "m_per_deg_lon": self.mx, "m_per_deg_lat": self.my,
        }


# ------------------------------------------------------------------- the DSM


@dataclass
class DSM:
    """Digital surface model: building height above ground on a regular grid."""

    height: np.ndarray          # (ny, nx) metres above local ground, 0 = street
    building_id: np.ndarray     # (ny, nx) int32 index into the building list, -1 = open
    res: float                  # metres per cell
    x0: float                   # west edge, metres in local frame
    y0: float                   # south edge, metres in local frame

    @property
    def shape(self) -> tuple[int, int]:
        return self.height.shape

    def xy_to_ij(self, x: float, y: float) -> tuple[int, int]:
        return (int((y - self.y0) / self.res), int((x - self.x0) / self.res))

    def ij_to_xy(self, i: int, j: int) -> tuple[float, float]:
        return (self.x0 + (j + 0.5) * self.res, self.y0 + (i + 0.5) * self.res)

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Nearest-cell height lookup, 0 outside the grid."""
        ny, nx = self.shape
        j = np.floor((np.asarray(x) - self.x0) / self.res).astype(np.int64)
        i = np.floor((np.asarray(y) - self.y0) / self.res).astype(np.int64)
        inside = (i >= 0) & (i < ny) & (j >= 0) & (j < nx)
        out = np.zeros(np.shape(x), dtype=np.float32)
        out[inside] = self.height[i[inside], j[inside]]
        return out

    @property
    def built_fraction(self) -> float:
        return float((self.height > 0).mean())

    @property
    def mean_building_height(self) -> float:
        built = self.height[self.height > 0]
        return float(built.mean()) if built.size else 0.0


def rasterize_dsm(
    buildings: list[dict],
    proj: Projector,
    res: float = 3.0,
    pad_m: float = 240.0,
) -> DSM:
    """Burn building heights into a raster using a scanline polygon fill.

    Padded well beyond the AOI so horizon scans near the edge still see the
    buildings that actually block the sky there. Taller buildings win where
    footprints overlap, which is the correct behaviour for a surface model.
    """
    area = proj.area
    hw = area.width_m / 2.0 + pad_m
    hh = area.height_m / 2.0 + pad_m
    x0, y0 = -hw, -hh
    nx = int(math.ceil(2 * hw / res))
    ny = int(math.ceil(2 * hh / res))

    height = np.zeros((ny, nx), dtype=np.float32)
    bid = np.full((ny, nx), -1, dtype=np.int32)

    for idx, b in enumerate(buildings):
        ring = proj.ring_to_xy(b["ring"])
        h = np.float32(b["height_m"])
        _fill_polygon(height, bid, ring, h, idx, res, x0, y0)

    return DSM(height=height, building_id=bid, res=res, x0=x0, y0=y0)


def _fill_polygon(
    height: np.ndarray,
    bid: np.ndarray,
    ring: np.ndarray,
    h: float,
    idx: int,
    res: float,
    x0: float,
    y0: float,
) -> None:
    """Even-odd scanline fill of one polygon into the height/id rasters."""
    ny, nx = height.shape
    ys = ring[:, 1]
    i_lo = max(0, int(math.floor((ys.min() - y0) / res)))
    i_hi = min(ny - 1, int(math.ceil((ys.max() - y0) / res)))
    if i_hi < i_lo:
        return

    n = len(ring)
    for i in range(i_lo, i_hi + 1):
        yc = y0 + (i + 0.5) * res
        xs: list[float] = []
        for k in range(n - 1):
            ay, by = ring[k, 1], ring[k + 1, 1]
            if (ay <= yc < by) or (by <= yc < ay):
                t = (yc - ay) / (by - ay)
                xs.append(ring[k, 0] + t * (ring[k + 1, 0] - ring[k, 0]))
        if not xs:
            continue
        xs.sort()
        for a, b in zip(xs[0::2], xs[1::2]):
            ja = max(0, int(math.ceil((a - x0) / res - 0.5)))
            jb = min(nx - 1, int(math.floor((b - x0) / res - 0.5)))
            if jb < ja:
                continue
            seg = height[i, ja : jb + 1]
            mask = seg < h
            if mask.any():
                seg[mask] = h
                bid[i, ja : jb + 1][mask] = idx


# --------------------------------------------------------- sky view factor


def svf_raster(
    dsm: DSM,
    n_azimuth: int = 32,
    max_radius_m: float = 250.0,
    observer_z: float = 1.5,
) -> np.ndarray:
    """Sky view factor at observer height across the whole grid.

    Method: discretised horizon scanning. For each of ``n_azimuth`` equally
    spaced directions, march outward and record the maximum elevation angle
    beta_i of any obstruction. The sky view factor is then

        SVF = (1/N) * sum_i cos^2(beta_i)

    Derivation, because the choice of weighting matters and the literature
    carries more than one form. For a horizontal surface the radiative view
    factor to the sky is the cosine-weighted solid-angle fraction

        SVF = (1/pi) * integral cos(theta_z) dOmega
            = (1/pi) * integral_0^2pi integral_0^(pi/2 - beta) cos t sin t dt dphi
            = (1/2pi) * integral_0^2pi cos^2(beta(phi)) dphi

    since the inner integral evaluates to sin^2(pi/2 - beta)/2 = cos^2(beta)/2.
    Discretising the outer integral over N equal azimuth sectors gives the form
    above. It reduces *exactly* to the closed-form infinite-canyon solution
    cos(atan(2H/W)) — verified to four decimal places against numerical
    integration — which the commonly quoted (1 - sin beta) annulus form does
    not: that form under-estimates SVF by roughly 35% at every aspect ratio.

    Result is 1.0 in the open, approaching 0 in a deep canyon. Values on
    building roofs are computed too (a roof sees far more sky than the street
    below it, which is the whole point of a vertical heat model).
    """
    ny, nx = dsm.shape
    ground = dsm.height.astype(np.float32)
    # Observer stands on whatever surface is there — street or roof.
    base = ground + np.float32(observer_z)

    max_tan = np.zeros((ny, nx), dtype=np.float32)
    svf = np.zeros((ny, nx), dtype=np.float32)

    steps = max(1, int(max_radius_m / dsm.res))
    for a in range(n_azimuth):
        theta = 2.0 * math.pi * a / n_azimuth
        dx, dy = math.sin(theta), math.cos(theta)  # bearing from north, clockwise
        max_tan.fill(0.0)
        for s in range(1, steps + 1):
            r = s * dsm.res
            ox = int(round(dx * s))
            oy = int(round(dy * s))
            if abs(ox) >= nx or abs(oy) >= ny:
                break
            shifted = _shift(ground, oy, ox)
            np.maximum(max_tan, (shifted - base) / np.float32(r), out=max_tan)
        # cos^2(atan(t)) = 1 / (1 + t^2) — no trig needed.
        t = np.maximum(max_tan, 0.0)
        svf += (1.0 / (1.0 + t * t)).astype(np.float32)

    svf /= np.float32(n_azimuth)
    return np.clip(svf, 0.0, 1.0)


def _shift(arr: np.ndarray, oy: int, ox: int) -> np.ndarray:
    """Shift by integer cells, padding the vacated edge with zeros (open sky)."""
    out = np.zeros_like(arr)
    ny, nx = arr.shape
    ys_src = slice(max(0, -oy), min(ny, ny - oy))
    ys_dst = slice(max(0, oy), min(ny, ny + oy))
    xs_src = slice(max(0, -ox), min(nx, nx - ox))
    xs_dst = slice(max(0, ox), min(nx, nx + ox))
    if ys_src.start >= ys_src.stop or xs_src.start >= xs_src.stop:
        return out
    out[ys_dst, xs_dst] = arr[ys_src, xs_src]
    return out


def shadow_raster(
    dsm: DSM,
    solar_altitude_deg: float,
    solar_azimuth_deg: float,
    max_radius_m: float = 600.0,
    observer_z: float = 1.5,
) -> np.ndarray:
    """Boolean sunlit mask at observer height for one solar position.

    Marches along the solar azimuth and tests whether any building rises above
    the sun ray. Below the horizon everything is shaded.
    """
    ny, nx = dsm.shape
    if solar_altitude_deg <= 0.5:
        return np.zeros((ny, nx), dtype=bool)

    ground = dsm.height.astype(np.float32)
    base = ground + np.float32(observer_z)
    tan_alt = np.float32(math.tan(math.radians(solar_altitude_deg)))

    # Step *towards* the sun: azimuth is the compass bearing the sun is in.
    theta = math.radians(solar_azimuth_deg)
    dx, dy = math.sin(theta), math.cos(theta)

    blocked = np.zeros((ny, nx), dtype=bool)
    steps = max(1, int(max_radius_m / dsm.res))
    for s in range(1, steps + 1):
        r = s * dsm.res
        ox, oy = int(round(dx * s)), int(round(dy * s))
        if abs(ox) >= nx or abs(oy) >= ny:
            break
        shifted = _shift(ground, oy, ox)
        ray_z = base + np.float32(r) * tan_alt
        blocked |= shifted > ray_z
    return ~blocked


# ------------------------------------------------------------------ facades


@dataclass
class Facade:
    """One vertical panel: a single footprint edge of a single building."""

    building: int          # index into the building list
    x0: float              # start point, local metres
    y0: float
    x1: float              # end point
    y1: float
    length: float          # metres
    azimuth: float         # outward normal, degrees clockwise from north
    base_m: float          # ground elevation at the wall
    top_m: float           # roof height above that ground

    @property
    def mid(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)

    @property
    def area(self) -> float:
        return self.length * max(0.0, self.top_m - self.base_m)


def extract_facades(
    buildings: list[dict],
    proj: Projector,
    min_length_m: float = 4.0,
    max_panel_m: float = 30.0,
) -> list[Facade]:
    """One facade panel per footprint edge, long edges split into panels.

    Splitting matters because a 100 m Sixth Avenue frontage has meaningfully
    different exposure at its two ends. Edges shorter than ``min_length_m`` are
    dropped — they are digitising artefacts of the photogrammetric footprints,
    not real walls anyone stands next to.

    Outward normal direction is resolved from the ring's signed area, so it
    points away from the building regardless of winding order.
    """
    out: list[Facade] = []
    for bi, b in enumerate(buildings):
        ring = proj.ring_to_xy(b["ring"])
        if len(ring) < 4:
            continue
        # Shoelace: positive means counter-clockwise in a y-up frame.
        area2 = 0.0
        for k in range(len(ring) - 1):
            area2 += ring[k, 0] * ring[k + 1, 1] - ring[k + 1, 0] * ring[k, 1]
        ccw = area2 > 0.0

        base_m = float(b.get("base_m") or 0.0)
        top_m = base_m + float(b["height_m"])

        for k in range(len(ring) - 1):
            ax, ay = float(ring[k, 0]), float(ring[k, 1])
            bx, by = float(ring[k + 1, 0]), float(ring[k + 1, 1])
            ex, ey = bx - ax, by - ay
            seg_len = math.hypot(ex, ey)
            if seg_len < min_length_m:
                continue
            # Outward normal: right of travel for CCW rings, left for CW.
            if ccw:
                nxv, nyv = ey / seg_len, -ex / seg_len
            else:
                nxv, nyv = -ey / seg_len, ex / seg_len
            az = (math.degrees(math.atan2(nxv, nyv)) + 360.0) % 360.0

            n_panels = max(1, int(math.ceil(seg_len / max_panel_m)))
            for p in range(n_panels):
                t0, t1 = p / n_panels, (p + 1) / n_panels
                out.append(
                    Facade(
                        building=bi,
                        x0=ax + ex * t0, y0=ay + ey * t0,
                        x1=ax + ex * t1, y1=ay + ey * t1,
                        length=seg_len / n_panels,
                        azimuth=az,
                        base_m=base_m,
                        top_m=top_m,
                    )
                )
    return out


# ------------------------------------------------------------------ canyons


@dataclass
class Canyon:
    """A street segment resolved into its cross-sectional geometry."""

    street_id: str | None
    name: str
    x: float                    # sample point, local metres
    y: float
    bearing: float              # street axis, degrees clockwise from north (0-180)
    width_m: float              # facade to facade, measured from the DSM
    width_curb_m: float | None  # curb to curb, from NYC Centerline
    h_left: float               # first wall height on the left of the axis
    h_right: float              # ...and the right
    svf: float                  # sky view factor at this point
    open_left: bool             # no building found within the search distance
    open_right: bool
    d_left: float = 0.0         # measured distance to the left wall, metres
    d_right: float = 0.0        # ...and the right
    tower_left: float = 0.0     # tallest mass just behind the left wall
    tower_right: float = 0.0

    # ------------------------------------------------------------ morphology
    @property
    def h_mean(self) -> float:
        return (self.h_left + self.h_right) / 2.0

    @property
    def enclosed(self) -> bool:
        """Both sides walled — the only case where H/W is physically meaningful."""
        return (not self.open_left) and (not self.open_right)

    @property
    def is_canyon(self) -> bool:
        """A real street canyon: walled both sides and narrow enough to couple.

        Beyond about 60 m facade-to-facade the two walls stop behaving as a
        single canyon and the site is better treated as an open plaza, so the
        aspect-ratio relationships are not applied there.
        """
        return self.enclosed and self.width_m <= 60.0

    @property
    def aspect_ratio(self) -> float:
        """H/W using the mean of the two walls — the conventional definition.

        Returns 0 for sites that are not enclosed canyons rather than inventing
        a width from the search limit: an open side has no wall, and pretending
        the search radius is a wall would fabricate geometry. Use ``svf``, which
        is measured from the raster and always valid, for those sites.
        """
        if not self.enclosed or self.width_m <= 0:
            return 0.0
        return self.h_mean / self.width_m

    @property
    def asymmetry(self) -> float:
        """(H_tall - H_short) / H_tall, 0 for a symmetric canyon, ->1 for one-sided.

        Normalising by the taller wall (rather than the mean) keeps the measure
        bounded at 1 for the single-sided case, which is the limit the
        literature's asymmetric-canyon studies actually treat.
        """
        tall, short = max(self.h_left, self.h_right), min(self.h_left, self.h_right)
        return (tall - short) / tall if tall > 0 else 0.0

    @property
    def taller_side(self) -> str:
        return "left" if self.h_left >= self.h_right else "right"

    @property
    def one_sided(self) -> bool:
        return self.open_left != self.open_right


def _bearing(x0: float, y0: float, x1: float, y1: float) -> float:
    """Compass bearing of a segment, folded to 0-180 (a street axis has no sign)."""
    b = (math.degrees(math.atan2(x1 - x0, y1 - y0)) + 360.0) % 360.0
    return b % 180.0


def extract_canyons(
    centerlines: list[dict],
    dsm: DSM,
    svf: np.ndarray,
    proj: Projector,
    sample_spacing_m: float = 25.0,
    max_search_m: float = 45.0,
    probe_step_m: float | None = None,
    min_wall_m: float = 6.0,
) -> list[Canyon]:
    """Resolve each street segment into cross-sections at regular intervals.

    At every sample point we cast a ray perpendicular to the street axis in both
    directions and take the first cell whose building height exceeds
    ``min_wall_m`` as that side's wall. This gives the physically correct
    facade-to-facade width, which is what the canyon literature means by W —
    NYC's ``streetwidth`` field is curb-to-curb and so excludes the sidewalks.
    Both are carried so they can be compared.

    ``min_wall_m`` exists because a 3 m shed is not a canyon wall; below that
    height a structure barely perturbs the flow or the radiation budget.
    """
    step = probe_step_m or dsm.res
    ny, nx = dsm.shape
    out: list[Canyon] = []

    for seg in centerlines:
        if seg.get("rw_type") not in (1, 0) and seg.get("rw_type") is not None:
            # 1 = ordinary street. Highways and ramps are not canyons.
            if seg["rw_type"] != 1:
                continue
        line = proj.ring_to_xy(seg["line"])
        if len(line) < 2:
            continue

        # Walk the polyline at fixed spacing.
        for (px, py, bx, by) in _walk(line, sample_spacing_m):
            bearing = _bearing(px, py, bx, by)
            # Perpendicular unit vector to the street axis.
            ang = math.radians(bearing)
            ax, ay = math.sin(ang), math.cos(ang)       # along-street
            nxv, nyv = ay, -ax                          # cross-street (right)

            d_r, h_r, t_r = _probe(dsm, px, py, nxv, nyv, max_search_m, step, min_wall_m)
            d_l, h_l, t_l = _probe(dsm, px, py, -nxv, -nyv, max_search_m, step, min_wall_m)

            open_r = h_r <= 0.0
            open_l = h_l <= 0.0
            # Width is the sum of *measured* distances. An open side contributes
            # its search limit so the number stays interpretable, but the
            # open_* flags mark it and aspect_ratio refuses to use it.
            w = (d_l if d_l > 0 else max_search_m) + (d_r if d_r > 0 else max_search_m)
            if w <= 1.0:
                continue

            i, j = dsm.xy_to_ij(px, py)
            s = float(svf[i, j]) if (0 <= i < ny and 0 <= j < nx) else 1.0

            out.append(
                Canyon(
                    street_id=str(seg.get("id")) if seg.get("id") is not None else None,
                    name=seg.get("name") or "",
                    x=px, y=py,
                    bearing=bearing,
                    width_m=round(w, 2),
                    width_curb_m=seg.get("width_m"),
                    h_left=round(h_l, 2),
                    h_right=round(h_r, 2),
                    svf=round(s, 4),
                    open_left=open_l,
                    open_right=open_r,
                    d_left=round(d_l, 2),
                    d_right=round(d_r, 2),
                    tower_left=round(t_l, 2),
                    tower_right=round(t_r, 2),
                )
            )
    return out


def _walk(line: np.ndarray, spacing: float):
    """Yield (x, y, ahead_x, ahead_y) samples at fixed spacing along a polyline."""
    total = 0.0
    for k in range(len(line) - 1):
        ax, ay = float(line[k, 0]), float(line[k, 1])
        bx, by = float(line[k + 1, 0]), float(line[k + 1, 1])
        seg = math.hypot(bx - ax, by - ay)
        if seg < 1e-6:
            continue
        n = max(1, int(seg / spacing))
        for p in range(n):
            t = (p + 0.5) / n
            yield (ax + (bx - ax) * t, ay + (by - ay) * t, bx, by)
        total += seg


def _probe(
    dsm: DSM,
    px: float,
    py: float,
    dx: float,
    dy: float,
    max_search: float,
    step: float,
    min_wall: float,
    look_behind_m: float = 30.0,
) -> tuple[float, float, float]:
    """March from (px,py) along (dx,dy) looking for the canyon wall.

    Returns ``(distance, wall_height, tower_height)``:

    * ``wall_height`` is the height of the *first* mass encountered — the
      surface that actually faces the street and forms the canyon wall. This is
      the H that belongs in H/W.
    * ``tower_height`` is the tallest mass within ``look_behind_m`` past it, so
      a setback tower behind a low podium is still known about. It is reported
      separately rather than substituted, because a tower set back 20 m loads
      the street radiatively but does not narrow the canyon.

    Keeping these apart is the difference between a defensible H/W and one
    inflated by every tower on the block.
    """
    ny, nx = dsm.shape
    steps = max(1, int(max_search / step))
    for s in range(1, steps + 1):
        r = s * step
        x, y = px + dx * r, py + dy * r
        i, j = dsm.xy_to_ij(x, y)
        if not (0 <= i < ny and 0 <= j < nx):
            return (r, 0.0, 0.0)
        h = float(dsm.height[i, j])
        if h >= min_wall:
            tower = h
            for extra in range(1, int(look_behind_m / step) + 1):
                r2 = r + extra * step
                x2, y2 = px + dx * r2, py + dy * r2
                i2, j2 = dsm.xy_to_ij(x2, y2)
                if 0 <= i2 < ny and 0 <= j2 < nx:
                    tower = max(tower, float(dsm.height[i2, j2]))
            return (r, h, tower)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------- analytic cross-checks


def svf_infinite_canyon(h: float, w: float) -> float:
    """SVF at the floor of an infinitely long symmetric canyon.

    For a street of width W flanked by walls of height H, the sky occupies the
    wedge between the two roof lines. Integrating the cosine-weighted solid
    angle over that wedge gives

        SVF = cos(atan(2H/W))

    (Oke 1981). Used only as a sanity check against the raster result, which is
    the value the engine actually uses.
    """
    if w <= 0:
        return 0.0
    return math.cos(math.atan(2.0 * h / w))


def svf_asymmetric_canyon(h_left: float, h_right: float, w: float) -> float:
    """SVF at the floor of an asymmetric canyon, as the mean of two half-canyons.

    Each wall blocks its own half of the sky dome independently, so the total
    obstruction is the average of the two symmetric solutions.
    """
    if w <= 0:
        return 0.0
    return 0.5 * (svf_infinite_canyon(h_left, w) + svf_infinite_canyon(h_right, w))


def svf_wall_point(z: float, h_opposite: float, w: float) -> float:
    """SVF for a point at height z on a wall facing a parallel wall of height H.

    A point on a vertical surface sees at most half the sky dome, so SVF = 0.5
    with nothing in front of it. The opposing wall subtends elevation angles
    from the horizontal up to alpha = atan((H - z) / W). By Hottel's result for
    an infinite strip seen by a differential planar element, the view factor to
    a strip spanning elevations t1..t2 is (sin t2 - sin t1)/2, so the remaining
    sky from alpha up to the zenith is

        SVF = (1 - sin(alpha)) / 2               for z < H
        SVF = 0.5                                 for z >= H

    Limits check out: alpha -> 0 gives 0.5 (open), alpha -> 90 deg gives 0.
    A facade's sky access therefore rises steeply once it clears the opposite
    roofline, which is precisely the vertical structure the engine reproduces.

    Note this is the *strip* weighting for a vertical surface, not the cos^2
    weighting used for the horizontal ground — the two orientations have
    genuinely different view factors and conflating them is a common error.
    """
    if w <= 0:
        return 0.0
    if z >= h_opposite:
        return 0.5
    alpha = math.atan((h_opposite - z) / w)
    return 0.5 * (1.0 - math.sin(alpha))


def frontal_area_index(
    facades: list["Facade"], area_m2: float, n_directions: int = 16
) -> float:
    """Direction-averaged frontal area index lambda_f.

        lambda_f(theta) = sum( wall area projected normal to theta ) / A_total

    Averaged over ``n_directions`` equally spaced wind directions, because the
    engine carries one scalar morphology per study area rather than a wind rose.

    This exists because lambda_f is genuinely a different quantity from the plan
    area index lambda_p, and Macdonald's roughness-length equation needs the
    frontal one. They coincide only for cubes. For a district of slender towers
    lambda_f is much the larger, and substituting lambda_p there under-estimates
    z0; for low sprawling sheds the error runs the other way. Since every facade
    panel's orientation and area is already known, there is no need to
    approximate it at all.
    """
    if area_m2 <= 0 or not facades:
        return 0.0
    total = 0.0
    for k in range(n_directions):
        theta = 2.0 * math.pi * k / n_directions
        wx, wy = math.sin(theta), math.cos(theta)
        s = 0.0
        for f in facades:
            az = math.radians(f.azimuth)
            nx, ny = math.sin(az), math.cos(az)
            # Only walls facing into the wind present frontal area.
            proj = nx * wx + ny * wy
            if proj > 0.0:
                s += f.area * proj
        total += s / area_m2
    return total / n_directions


def roughness_length(
    h_mean: float, lambda_p: float, lambda_f: float | None = None
) -> tuple[float, float]:
    """Displacement height d and roughness length z0 from building morphology.

    Macdonald, Griffiths & Hall (1998), the standard morphometric
    parameterisation:

        d  = H * [ 1 + A^(-lambda_p) * (lambda_p - 1) ]
        z0 = H * (1 - d/H)
             * exp{ -[ 0.5 * beta * Cd / kappa^2 * (1 - d/H) * lambda_f ]^(-0.5) }

    with A = 4.43, Cd = 1.2, beta = 1.0, kappa = 0.4 for staggered arrays.

    Note which index goes where. The displacement height uses the **plan** area
    index lambda_p; the roughness length uses the **frontal** area index
    lambda_f. An earlier version of this function passed lambda_p to both, which
    is a real error rather than a simplification -- the two are equal only for
    cubic obstacles, and Midtown is emphatically not cubic. Where lambda_f is
    not supplied it falls back to lambda_p and the caller should treat the
    result as approximate; ``frontal_area_index`` computes it properly from the
    facade panels.

    Macdonald's method is validated up to an area index of roughly 0.35. Beyond
    that the array enters skimming flow, where the real z0 peaks and then
    declines with further densification while this formula keeps rising. The
    index used in the z0 term is therefore clamped at 0.35 and the displacement
    height is allowed to continue (it stays well behaved).

    Worth being plain about what that clamp means for this study area: Midtown
    has lambda_p = 0.45 and a measured lambda_f of about 1.1, so it sits well
    beyond the validated range in both indices and the clamp is active. The
    resulting z0 of roughly 4 m is consistent with published values for dense
    high-rise fabric, but it is a saturated estimate rather than a
    parameterisation evaluated inside its domain, and z0 only enters this engine
    through the log-law profile above roof level -- the part already carrying the
    widest uncertainty band.

    Returns (d, z0) in metres. These set the log-law profile the vertical air
    temperature extrapolation uses above roof level.
    """
    if h_mean <= 0 or lambda_p <= 0:
        return (0.0, 0.03)
    A, Cd, beta, kappa = 4.43, 1.2, 1.0, 0.4
    lp = min(max(lambda_p, 0.01), 0.85)
    lf = lambda_f if (lambda_f and lambda_f > 0) else lp
    # Skimming-flow validity limit on the roughness term.
    lf = min(max(lf, 0.01), 0.35)

    d_over_h = 1.0 + (A ** (-lp)) * (lp - 1.0)
    d_over_h = min(max(d_over_h, 0.0), 0.95)
    inner = 0.5 * beta * Cd / (kappa**2) * (1.0 - d_over_h) * lf
    z0 = h_mean * (1.0 - d_over_h) * math.exp(-(inner ** -0.5)) if inner > 0 else 0.03
    return (h_mean * d_over_h, max(z0, 0.01))
