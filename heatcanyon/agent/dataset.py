"""Every pipeline output, loaded once and indexed — the agent's whole world.

ONE LOADER, TWO CONSUMERS

This is deliberately the only place that knows the on-disk layout. The in-process
tools read it, and so does any Python the agent writes itself:

    import heatcanyon.agent.dataset as D
    d = D.load()
    d.buildings["attrs"][17]

That second path is why the class is a plain object with public attributes rather
than a set of accessor methods. The agent is given a shell and told it can write
scripts; a script that has to guess the layout of ``annual/monthly_mean.bin``
will get it wrong, and a tool that hides the layout behind a query language would
mean the agent can only ask the questions somebody anticipated. So the layout is
documented here, in the docstring the agent is pointed at, and the arrays are
right there as NumPy.

LAZY WHERE IT MATTERS

Twelve monthly periods at 9.9 MB each is 119 MB, and a question about July has no
business paying for December. Periods and annual planes load on first touch and
stay. ``meta.json``, ``year.json`` and the JSON products load eagerly because
essentially every question needs them.

THE INDEX SET IS THE POINT

Raw arrays plus ``panels_of_building`` plus ``canyon_of_panel`` plus
``bin_to_index`` is what turns "which buildings" into an answer. Building those
maps costs a second at load and saves the agent writing them, wrongly, in every
script.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import knobs

#: Periods that can be selected. ``event`` is the FortyGuard-anchored study day;
#: ``month_01`` .. ``month_12`` are the twelve representative days.
EVENT = "event"


def month_key(m: int) -> str:
    return f"month_{int(m):02d}"


@dataclass
class Period:
    """One solved day at eight hours: the fields, and what they rest on."""

    key: str
    date: str
    anchor_source: str
    surface: np.ndarray           # (H,P,B) float32 degC
    air: np.ndarray               # (H,P,B) float32 degC
    lit: np.ndarray               # (H,P,B) bool
    ground_sun: np.ndarray        # (H,ny,nx) bool
    hours: list[dict]             # per-hour meteorology and solar geometry

    @property
    def n_hours(self) -> int:
        return int(self.surface.shape[0])


class Dataset:
    """Everything the pipeline wrote, plus the indexes that make it queryable."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or knobs.data_root())
        self._lock = threading.Lock()

        self.meta = self._json("meta.json")
        self.year = self._json("year.json")
        self.buildings = self._json("buildings.json")
        self.facades = self._json("facades.json")
        self.canyons = self._json("canyons.json")
        self.ranked = self._json("ranked.json")
        self.scenarios = self._json("scenarios.json")
        self.tiles = self._json("tiles.json")

        self.n_panel = int(self.facades["n"])
        self.n_band = int(self.facades["bands"])
        self.n_hour = len(self.meta["hours"])
        self.materials = list(self.buildings["materials"])

        # ---- flat panel geometry
        xy = np.asarray(self.facades["xy"], dtype=np.float32).reshape(-1, 4)
        self.panel_xy = xy
        self.panel_mid = np.stack([(xy[:, 0] + xy[:, 2]) / 2,
                                   (xy[:, 1] + xy[:, 3]) / 2], axis=1)
        self.panel_length = np.hypot(xy[:, 2] - xy[:, 0], xy[:, 3] - xy[:, 1])
        self.panel_building = np.asarray(self.facades["building"], dtype=np.int32)
        self.panel_azimuth = np.asarray(self.facades["az"], dtype=np.float32)
        self.panel_base = np.asarray(self.facades["base"], dtype=np.float32)
        self.panel_top = np.asarray(self.facades["top"], dtype=np.float32)
        self.panel_canyon = np.asarray(self.facades["canyon"], dtype=np.int32)
        self.panel_material = np.asarray(self.facades["mat"], dtype=np.int8)
        h_wall = np.maximum(self.panel_top - self.panel_base, 3.0)
        band = (np.arange(self.n_band, dtype=np.float32) + 0.5) / self.n_band
        self.band_z = h_wall[:, None] * band[None, :]
        self.band_z_absolute = self.panel_base[:, None] + self.band_z

        # ---- indexes
        self.panels_of_building: dict[int, np.ndarray] = {}
        order = np.argsort(self.panel_building, kind="stable")
        b_sorted = self.panel_building[order]
        edges = np.searchsorted(b_sorted, np.unique(b_sorted))
        uniq = np.unique(b_sorted)
        for k, b in enumerate(uniq):
            lo = edges[k]
            hi = edges[k + 1] if k + 1 < len(edges) else len(order)
            self.panels_of_building[int(b)] = order[lo:hi]

        self.attrs = self.buildings["attrs"]
        self.bin_to_index: dict[str, int] = {}
        for i, a in enumerate(self.attrs):
            if a.get("bin"):
                self.bin_to_index[str(a["bin"])] = i
        self.ranked_by_bin: dict[str, dict] = {}
        for rank, it in enumerate(self.ranked["items"], start=1):
            self.ranked_by_bin[str(it["bin"])] = dict(it, rank=rank)

        self.canyon_by_index = {int(c["i"]): c for c in self.canyons}

        # The canyon properties the day reconstruction's wind term needs, per
        # panel. Assembled here so `surface_on` calls the same
        # `tiers.wind_factor` the pipeline's audit does rather than a fourth
        # implementation of the canyon wind blend. The values for a panel with no
        # canyon within 90 m mirror the open-ground fallback the solve uses.
        self.panel_aspect = np.full(self.n_panel, 0.25, dtype=np.float64)
        self.panel_h_mean = np.full(self.n_panel, 10.0, dtype=np.float64)
        for p_i, ci in enumerate(self.panel_canyon):
            c = self.canyon_by_index.get(int(ci)) if ci >= 0 else None
            if c is not None:
                self.panel_aspect[p_i] = c["hw"]
                self.panel_h_mean[p_i] = max((c["hl"] + c["hr"]) / 2.0, 4.0)
        self.canyons_by_street: dict[str, list[dict]] = {}
        for c in self.canyons:
            self.canyons_by_street.setdefault((c.get("name") or "").upper(), []).append(c)

        # ---- projection, so the agent can convert either way
        pr = self.meta["projection"]
        self._lon0, self._lat0 = pr["lon0"], pr["lat0"]
        self._mx, self._my = pr["m_per_deg_lon"], pr["m_per_deg_lat"]

        # ---- lazy stores
        self._periods: dict[str, Period] = {}
        self._planes: dict[str, np.ndarray] = {}
        self._sens: np.ndarray | None = None
        self._svf: np.ndarray | None = None

        # ---- the year, as arrays
        h = self.year["hourly"]
        self.year_t_air = np.asarray(h["t_air_c"], dtype=np.float32)
        self.year_t_air_raw = np.asarray(h["t_air_raw_c"], dtype=np.float32)
        self.year_apparent = np.asarray(h["apparent_c"], dtype=np.float32)
        self.year_rh = np.asarray(h["rh"], dtype=np.float32)
        self.year_wind = np.asarray(h["wind_ms"], dtype=np.float32)
        self.year_cloud = np.asarray(h["cloud"], dtype=np.float32)
        self.year_ghi = np.asarray(h["ghi"], dtype=np.float32)
        self.year_dni = np.asarray(h["dni"], dtype=np.float32)
        self.year_dhi = np.asarray(h["dhi"], dtype=np.float32)
        self.year_hour_of_day = np.asarray(h["hour_of_day"], dtype=np.int16)
        self.year_day_index = np.asarray(h["day_index"], dtype=np.int32)
        self.days = self.year["days"]
        self.months = self.year["months"]
        self.date_to_day: dict[str, int] = {d["date"]: i
                                           for i, d in enumerate(self.days)}
        self.day_tmax = np.asarray([d["tmax"] for d in self.days], dtype=np.float32)
        self.day_tmin = np.asarray([d["tmin"] for d in self.days], dtype=np.float32)
        self.day_tmean = np.asarray([d["tmean"] for d in self.days], dtype=np.float32)

    # ------------------------------------------------------------- plumbing
    def _json(self, name: str) -> dict:
        path = self.root / name
        if not path.exists():
            raise FileNotFoundError(
                f"{path} is missing — run `python -m heatcanyon.cli build` first.")
        return json.loads(path.read_text())

    def _i16(self, rel: str, scale: float = 100.0,
             dtype: str = "int16") -> np.ndarray:
        raw = np.frombuffer((self.root / rel).read_bytes(),
                            dtype="<u2" if dtype == "uint16" else "<i2")
        return raw.astype(np.float32) / scale

    def _bits(self, rel: str, count: int) -> np.ndarray:
        packed = np.frombuffer((self.root / rel).read_bytes(), dtype=np.uint8)
        return np.unpackbits(packed)[:count].astype(bool)

    # -------------------------------------------------------------- periods
    def period(self, key: str = EVENT) -> Period:
        """One of the thirteen solved days. Loaded on first touch, then cached."""
        key = self.resolve_period(key)
        with self._lock:
            hit = self._periods.get(key)
            if hit is not None:
                return hit

            sub = "" if key == EVENT else key
            base = self.root / sub if sub else self.root
            if not (base / "thermal.bin").exists() and sub:
                raise FileNotFoundError(f"no such period on disk: {key}")
            shape = (self.n_hour, self.n_panel, self.n_band)
            n = int(np.prod(shape))
            surface = self._i16(f"{sub}/thermal.bin" if sub else "thermal.bin").reshape(shape)
            air = self._i16(f"{sub}/air.bin" if sub else "air.bin").reshape(shape)
            lit = self._bits(f"{sub}/sunlit.bin" if sub else "sunlit.bin", n).reshape(shape)
            sg = self.meta["shadow_grid"]
            gs_n = self.n_hour * sg["ny"] * sg["nx"]
            gsun = self._bits(f"{sub}/ground_sun.bin" if sub else "ground_sun.bin",
                              gs_n).reshape(self.n_hour, sg["ny"], sg["nx"])

            if key == EVENT:
                info = self.year["periods"]["event"]
            else:
                m = int(key.split("_")[1])
                info = next(x for x in self.year["periods"]["months"]
                            if x["month"] == m)
            p = Period(key=key, date=info["date"],
                       anchor_source=info["anchor_source"],
                       surface=surface, air=air, lit=lit, ground_sun=gsun,
                       hours=info["hours"])
            self._periods[key] = p
            return p

    def resolve_period(self, key: str | int | None) -> str:
        """Accept ``event``, ``7``, ``july``, ``month_07``, a date, or None."""
        if key is None:
            return EVENT
        if isinstance(key, int):
            return month_key(key)
        k = str(key).strip().lower()
        if k in ("event", "study", "study_day", "heatwave", "wave"):
            return EVENT
        if k.startswith("month_"):
            return month_key(int(k.split("_")[1]))
        if k.isdigit():
            v = int(k)
            return EVENT if v == 0 else month_key(v)
        from ..year import MONTH_NAMES
        for i, name in enumerate(MONTH_NAMES, start=1):
            if k in (name.lower(), name.lower()[:3]):
                return month_key(i)
        if len(k) >= 7 and k[4] == "-":
            if k[:10] == self.year["periods"]["event"]["date"]:
                return EVENT
            return month_key(int(k[5:7]))
        raise ValueError(f"unrecognised period: {key!r}")

    def period_keys(self) -> list[str]:
        return [EVENT] + [month_key(m) for m in range(1, 13)]

    # -------------------------------------------------------- annual planes
    PLANES = ("sun_hours", "dose_kwh", "absorbed_kwh", "degree_hours_35",
              "degree_hours_40", "hours_above_35", "t_max", "t_min", "t_mean",
              "summer_mean", "winter_mean", "swing", "winter_sun_share")

    def plane(self, name: str) -> np.ndarray:
        """One annual plane, shape (n_panel, n_band)."""
        with self._lock:
            hit = self._planes.get(name)
            if hit is not None:
                return hit
            spec = self.meta["year"]["annual_fields"]
            shape = (self.n_panel, self.n_band)
            if name in spec["planes"]:
                ps = spec["planes"][name]
                arr = self._i16(f"annual/{name}.bin", ps["scale"],
                                ps.get("dtype", "int16")).reshape(shape)
            elif name == "month_of_max":
                arr = np.frombuffer((self.root / "annual/month_of_max.bin").read_bytes(),
                                    dtype=np.uint8).reshape(shape).astype(np.int16)
            elif name == "monthly_mean":
                arr = self._i16("annual/monthly_mean.bin").reshape((12,) + shape)
            elif name == "monthly_sun_hours":
                extra = (spec.get("extra_planes") or {}).get("monthly_sun_hours", {})
                arr = self._i16("annual/monthly_sun_hours.bin",
                                extra.get("scale", 10.0),
                                extra.get("dtype", "uint16")).reshape((12,) + shape)
            else:
                raise KeyError(f"no annual plane {name!r}; have "
                               f"{sorted(set(self.PLANES) | {'month_of_max', 'monthly_mean', 'monthly_sun_hours'})}")
            self._planes[name] = arr
            return arr

    @property
    def sensitivity(self) -> np.ndarray:
        """dT_surface/dT_air per panel and band, decoded from the byte plane."""
        with self._lock:
            if self._sens is None:
                spec = self.meta["year"]["sensitivity"]
                raw = np.frombuffer((self.root / "sens.bin").read_bytes(),
                                    dtype=np.uint8).astype(np.float32)
                self._sens = (raw / float(spec.get("scale", 200.0))
                              + float(spec.get("offset", 0.5))).reshape(
                    self.n_panel, self.n_band)
            return self._sens

    @property
    def svf_bands(self) -> np.ndarray:
        """Wall sky view factor per panel and band, 0 to 0.5."""
        with self._lock:
            if self._svf is None:
                raw = np.frombuffer((self.root / "svf_bands.bin").read_bytes(),
                                    dtype=np.uint8).astype(np.float32)
                self._svf = (raw / 255.0 * 0.5).reshape(self.n_panel, self.n_band)
            return self._svf

    # ------------------------------------------------------------ the year
    def day_hours(self, date: str) -> np.ndarray:
        """Hourly indices of one calendar day in the year series."""
        di = self.date_to_day.get(date)
        if di is None:
            raise KeyError(f"{date} is outside the study year "
                           f"{self.year['window'][0]}..{self.year['window'][1]}")
        return np.where(self.year_day_index == di)[0]

    def day_record(self, date: str) -> dict:
        di = self.date_to_day.get(date)
        if di is None:
            raise KeyError(date)
        return self.days[di]

    def month_record(self, m: int) -> dict:
        for r in self.months:
            if r["month"] == int(m):
                return r
        raise KeyError(m)

    def surface_on(self, date: str, hour_slot: int) -> np.ndarray:
        """The facade field on any day of the year, at one of the eight slots.

        Delegates to ``tiers.reconstruct``, which is the ONE definition of this
        formula — the browser implements the same arithmetic and
        ``tiers.reconstruction_audit`` measures that same arithmetic. Three
        implementations would drift, and then the error the interface prints would
        stop being the error of the field on screen.
        """
        from ..tiers import reconstruct

        rec = self.day_record(date)
        key = month_key(rec["month"])
        p = self.period(key)
        hour_edt = p.hours[hour_slot]["edt"]
        if date == p.date:
            return p.surface[hour_slot]
        want = self._air_at(date, hour_edt)
        have = self._air_at(p.date, hour_edt)
        if want is None or have is None:
            return p.surface[hour_slot]
        from ..tiers import wind_factor

        u_rep = self._wind_at(p.date, hour_edt) or 3.0
        u_day = self._wind_at(date, hour_edt) or 3.0
        return reconstruct(
            p.surface[hour_slot], p.lit[hour_slot],
            t_air_rep=have, t_air_day=want,
            ghi_rep=self._ghi_at(p.date, hour_edt) or 0.0,
            ghi_day=self._ghi_at(date, hour_edt) or 0.0,
            gamma=self.sensitivity,
            wind_ratio=wind_factor(u_rep, u_day, self.panel_aspect,
                                   self.panel_h_mean, self.band_z))

    def reconstruction_error(self, date: str) -> dict | None:
        """The measured error of this day's reconstruction, or None if it was solved.

        Per day rather than global, because the residual is solar geometry and it
        is several times larger near the equinoxes than in June.
        """
        rec = self.day_record(date)
        if rec.get("solved"):
            return None
        return {"p50_k": rec.get("recon_p50"), "p95_k": rec.get("recon_p95"),
                "basis": self.meta["year"]["reconstruction"]["method"]}

    def _air_at(self, date: str, hour_edt: int) -> float | None:
        return self._hourly_at(self.year_t_air, date, hour_edt)

    def _ghi_at(self, date: str, hour_edt: int) -> float | None:
        return self._hourly_at(self.year_ghi, date, hour_edt)

    def _wind_at(self, date: str, hour_edt: int) -> float | None:
        return self._hourly_at(self.year_wind, date, hour_edt)

    def _hourly_at(self, arr: np.ndarray, date: str, hour_edt: int) -> float | None:
        try:
            k = self.day_hours(date)
        except KeyError:
            return None
        hits = k[self.year_hour_of_day[k] == int(hour_edt)]
        return float(arr[hits[0]]) if len(hits) else None

    # ---------------------------------------------------------- projection
    def to_xy(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self._lon0) * self._mx, (lat - self._lat0) * self._my)

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        return (self._lon0 + x / self._mx, self._lat0 + y / self._my)

    # ------------------------------------------------------------- describe
    def layout(self) -> dict:
        """The on-disk and in-memory layout, for the agent's data dictionary."""
        return {
            "root": str(self.root),
            "counts": {
                "buildings": len(self.attrs),
                "buildings_scored": self.meta["counts"]["buildings_scored"],
                "facade_panels": self.n_panel,
                "bands_per_panel": self.n_band,
                "hours_per_period": self.n_hour,
                "canyon_sections": len(self.canyons),
                "ranked_items": len(self.ranked["items"]),
                "tiles": len(self.tiles["exceedance"]),
                "year_days": len(self.days),
                "year_hours": int(self.year_t_air.size),
            },
            "periods": self.period_keys(),
            "annual_planes": sorted(set(self.PLANES) |
                                    {"month_of_max", "monthly_mean", "monthly_sun_hours"}),
            "python": {
                "import": "import heatcanyon.agent.dataset as D; d = D.load()",
                "period": "d.period('month_07').surface  # (8, 29415, 10) degC",
                "plane": "d.plane('sun_hours')           # (29415, 10) hours/year",
                "any_day": "d.surface_on('2026-03-14', 4) # (29415, 10) degC",
                "panels_of_building": "d.panels_of_building[building_index]",
                "geometry": ("d.panel_azimuth, d.panel_mid, d.band_z, "
                             "d.panel_canyon, d.svf_bands"),
                "year": ("d.year_t_air, d.year_dni, d.year_hour_of_day, "
                         "d.day_tmax, d.days, d.months"),
                "projection": "d.to_xy(lon, lat) / d.to_lonlat(x, y)",
            },
        }


# A single instance per process. The arrays are large and read-only; loading them
# per request would dominate every question's latency.
_SINGLETON: Dataset | None = None
_SINGLETON_LOCK = threading.Lock()


def load(root: Path | None = None) -> Dataset:
    global _SINGLETON
    with _SINGLETON_LOCK:
        if _SINGLETON is None or (root is not None and Path(root) != _SINGLETON.root):
            _SINGLETON = Dataset(root)
        return _SINGLETON
