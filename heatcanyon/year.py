"""The climate year: one year of hourly meteorology, calibrated and summarised.

WHY THIS MODULE EXISTS

The original model solved one afternoon. That is the right thing to solve first
— 2 July 2026 was the hottest day of the Manhattan summer and the day the
FortyGuard purchase covers — but a single day cannot answer the questions a city
actually asks. How many hours a year does this facade sit above 35 degC. Which
month does this canyon peak in. Does the shading that saves July cost January.
How many nights a year does this block fail to drop below 26 degC, which is the
number the epidemiology of heat mortality is most sensitive to. Every one of
those is a *temporal* question and none of them can be asked of one day.

WHERE A YEAR OF DATA COMES FROM WITHOUT A CREDENTIAL

FortyGuard's heatmap endpoint costs a flat 4,220 credits per call regardless of
tile count, so a year of hourly urban fields is not on the table: 8,760 calls
would be 37 million credits against a 2 million budget, and the project has no
key committed anyway. What *is* freely available at hourly resolution for any
point on earth is the ERA5 reanalysis, served by Open-Meteo without a key. This
project already uses it — the solar reconstruction in ``heatcanyon.solar`` is
validated against ERA5 radiation to 7.3% RMS — so the temporal axis rests on a
source the repository already trusts and already checks.

WHAT ERA5 CANNOT DO, AND WHAT IS DONE ABOUT IT

ERA5's grid cell over Midtown is 0.25 deg — roughly 25 km, and the cell that
contains Manhattan also contains a large amount of water and New Jersey. It is
therefore *not* an urban 2 m air temperature, and using it raw as the anchor
would silently replace a measured urban field with a regional one. Measured
against FortyGuard on the one day both cover, ERA5 runs about 2 K too warm at
mid-afternoon and about 2 K too cool before dawn: its diurnal amplitude is too
large, exactly the error a coarse, partly-marine cell would make against a dense
city with high thermal mass.

So the series is bias-corrected: a 24-value diurnal offset curve fitted to the
eight hours where FortyGuard and ERA5 both speak, applied year-round.
``BiasCorrection.report`` carries the fit, the residuals and the honest
limitation — the curve is estimated from ONE day, so it captures the shape of
the bias but not its seasonality, and both the corrected and the raw series are
carried through to the web app so the correction is always visible rather than
baked in.

The correction is a calibration, not a measurement. Every product derived from
it is labelled ``reanalysis (bias-corrected)`` and never ``measured``.

WHAT THIS MODULE PRODUCES

``YearMet``   the hourly series, corrected, with solar geometry per hour
``DayRecord`` 365 daily summaries — max, min, mean, degree-hours, tropical night
``MonthRecord`` 12 monthly summaries plus the *representative day*: the day whose
              own diurnal profile sits closest to the month's mean profile, and
              therefore the day worth solving at full facade resolution to stand
              for that month
``Episode``   heat-wave episodes found by run-length over a threshold
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from . import solar

#: The year the platform shows. It ENDS on the modelled heat wave's month, so
#: the year contains the day the rest of the project solves in full and the two
#: can be checked against each other. ERA5's archive lags real time by about
#: five days, which is why the window is not simply "the last 365 days".
WINDOW = ("2025-08-01", "2026-07-31")

#: Everything the physics engine needs, in the units it needs. Wind is requested
#: in m/s explicitly: Open-Meteo's default is km/h, and the one-day cache this
#: project shipped with carried km/h into ``Met.wind_10m``, which is m/s. See
#: ``scripts/fetch_year.py``.
HOURLY_VARS = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "apparent_temperature",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "shortwave_radiation",
    "direct_normal_irradiance",
    "diffuse_radiation",
    "precipitation",
]

CACHE_DIR = Path("data/manhattan")
TZ = ZoneInfo("America/New_York")

#: Thresholds the year is scored against. 35 degC is the project's own heat
#: threshold (and the one the FortyGuard exceedance layer was bought at); 32 is
#: NYC's heat-advisory heat-index neighbourhood; 26 degC is the night-time
#: threshold above which sleep is disrupted and heat mortality rises, which is
#: why "tropical nights" is a public-health metric and not a curiosity.
T_HOT_C = 35.0
T_WARM_C = 32.0
T_TROPICAL_NIGHT_C = 26.0
#: Base temperatures for degree days. 18 degC is the conventional balance point.
T_BASE_C = 18.0

SEASONS = {
    "summer": (6, 7, 8),
    "autumn": (9, 10, 11),
    "winter": (12, 1, 2),
    "spring": (3, 4, 5),
}
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]


def cache_path(start: str = WINDOW[0], end: str = WINDOW[1]) -> Path:
    return CACHE_DIR / f"_openmeteo_year_{start}_{end}.json"


# --------------------------------------------------------------- bias fitting


@dataclass
class BiasCorrection:
    """A 24-value diurnal offset added to ERA5 air temperature, in K.

    ``offsets[h]`` is added to the ERA5 value at local wall-clock hour ``h``.
    Positive means ERA5 was too cool at that hour.
    """

    offsets: np.ndarray                     # shape (24,)
    anchors: list[dict] = field(default_factory=list)
    method: str = "diurnal offset, cyclic linear interpolation over 8 anchors"
    fitted_on: str = ""

    def apply(self, values: np.ndarray, hour_of_day: np.ndarray) -> np.ndarray:
        return values + self.offsets[hour_of_day]

    @property
    def report(self) -> dict:
        o = self.offsets
        return {
            "method": self.method,
            "fitted_on": self.fitted_on,
            "offsets_by_local_hour_k": [round(float(v), 3) for v in o],
            "mean_k": round(float(o.mean()), 3),
            "range_k": [round(float(o.min()), 3), round(float(o.max()), 3)],
            "anchors": self.anchors,
            "amplitude_effect": (
                "ERA5's diurnal amplitude over this cell is "
                f"{abs(float(o.max() - o.min())):.1f} K wider than FortyGuard's urban "
                "field, so the correction is mostly an amplitude correction rather "
                "than a level shift."
            ),
            "limitation": (
                "The curve is fitted to a single day — the one day FortyGuard and "
                "ERA5 both cover — so it captures the shape of the bias but not its "
                "seasonality. A winter offset is an extrapolation. Both the corrected "
                "and the raw series are carried through to the web app, and every "
                "product derived from the corrected series is labelled "
                "'reanalysis (bias-corrected)', never 'measured'."
            ),
        }


def fit_bias(era5_by_hour: dict[int, float], fg_by_hour: dict[int, float],
             fitted_on: str = "") -> BiasCorrection:
    """Fit the diurnal offset from paired (local hour -> value) readings.

    Interpolation is cyclic: hour 23 is adjacent to hour 0, so the curve closes
    on itself rather than kinking at midnight. With eight anchors three hours
    apart that matters — a non-cyclic fit would leave the overnight hours, which
    is where the bias is largest, flat-extrapolated from one end.
    """
    hours = sorted(set(era5_by_hour) & set(fg_by_hour))
    if not hours:
        raise ValueError("no overlapping hours between ERA5 and FortyGuard")
    deltas = [fg_by_hour[h] - era5_by_hour[h] for h in hours]

    # Wrap one period either side so np.interp sees a periodic function.
    xs = np.array([h - 24 for h in hours] + hours + [h + 24 for h in hours], dtype=float)
    ys = np.array(deltas * 3, dtype=float)
    offsets = np.interp(np.arange(24, dtype=float), xs, ys)

    anchors = [{
        "local_hour": int(h),
        "era5_c": round(float(era5_by_hour[h]), 2),
        "fortyguard_c": round(float(fg_by_hour[h]), 2),
        "offset_k": round(float(fg_by_hour[h] - era5_by_hour[h]), 2),
    } for h in hours]
    return BiasCorrection(offsets=offsets, anchors=anchors, fitted_on=fitted_on)


# ----------------------------------------------------------------- the series


@dataclass
class DayRecord:
    """One day of the year, summarised. Every field is derived, none is fitted."""

    date: str
    doy: int
    month: int
    t_max: float
    t_min: float
    t_mean: float
    t_max_hour: int
    rh_mean: float
    wind_mean: float
    cloud_mean: float
    ghi_total_kwh: float          # kWh/m2 on the horizontal, the day's solar budget
    dni_peak: float
    precip_mm: float
    hours_above_35: float
    hours_above_32: float
    degree_hours_above_35: float  # K.h, the dose metric
    tropical_night: bool          # overnight minimum stayed above 26 degC
    cdd: float                    # cooling degree days, base 18
    hdd: float                    # heating degree days, base 18
    daylight_hours: float
    sun_noon_altitude: float
    #: How wrong this day's reconstruction is, measured against a full re-solve by
    #: ``tiers.reconstruction_audit``. Filled in by the pipeline after the monthly
    #: tiers exist, which is why it has a default: a DayRecord is well defined
    #: before anything has been solved.
    recon_p50_k: float | None = None
    recon_p95_k: float | None = None
    recon_solved: bool = False

    def as_dict(self) -> dict:
        return {
            "date": self.date, "doy": self.doy, "month": self.month,
            "tmax": round(self.t_max, 2), "tmin": round(self.t_min, 2),
            "tmean": round(self.t_mean, 2), "tmax_h": self.t_max_hour,
            "rh": round(self.rh_mean, 1), "wind": round(self.wind_mean, 2),
            "cloud": round(self.cloud_mean, 3),
            "ghi_kwh": round(self.ghi_total_kwh, 3),
            "dni_peak": round(self.dni_peak),
            "precip": round(self.precip_mm, 2),
            "h35": round(self.hours_above_35, 1),
            "h32": round(self.hours_above_32, 1),
            "kh35": round(self.degree_hours_above_35, 2),
            "trop": 1 if self.tropical_night else 0,
            "cdd": round(self.cdd, 3), "hdd": round(self.hdd, 3),
            "daylight": round(self.daylight_hours, 2),
            "noon_alt": round(self.sun_noon_altitude, 1),
            # None until the pipeline has solved the monthly tiers and measured it.
            "recon_p50": (round(self.recon_p50_k, 2)
                          if self.recon_p50_k is not None else None),
            "recon_p95": (round(self.recon_p95_k, 2)
                          if self.recon_p95_k is not None else None),
            "solved": 1 if self.recon_solved else 0,
        }


@dataclass
class Episode:
    """A run of consecutive days over a threshold — a heat wave, found not assumed."""

    start: str
    end: str
    days: int
    peak_c: float
    peak_date: str
    mean_tmax_c: float
    tropical_nights: int
    total_degree_hours: float

    def as_dict(self) -> dict:
        return {
            "start": self.start, "end": self.end, "days": self.days,
            "peak_c": round(self.peak_c, 2), "peak_date": self.peak_date,
            "mean_tmax_c": round(self.mean_tmax_c, 2),
            "tropical_nights": self.tropical_nights,
            "degree_hours": round(self.total_degree_hours, 1),
        }


@dataclass
class MonthRecord:
    month: int
    label: str
    days: int
    t_max_mean: float
    t_min_mean: float
    t_mean: float
    t_max_abs: float
    t_min_abs: float
    hours_above_35: float
    hours_above_32: float
    degree_hours_above_35: float
    tropical_nights: int
    cdd: float
    hdd: float
    ghi_total_kwh: float
    rh_mean: float
    wind_mean: float
    cloud_mean: float
    sun_noon_altitude: float
    rep_date: str                 # the day that stands for this month
    rep_doy: int
    rep_rms_k: float              # how well it stands for it
    diurnal_c: list[float] = field(default_factory=list)     # 24 values, month mean

    def as_dict(self) -> dict:
        return {
            "month": self.month, "label": self.label, "days": self.days,
            "tmax_mean": round(self.t_max_mean, 2),
            "tmin_mean": round(self.t_min_mean, 2),
            "tmean": round(self.t_mean, 2),
            "tmax_abs": round(self.t_max_abs, 2),
            "tmin_abs": round(self.t_min_abs, 2),
            "h35": round(self.hours_above_35, 1),
            "h32": round(self.hours_above_32, 1),
            "kh35": round(self.degree_hours_above_35, 1),
            "trop": self.tropical_nights,
            "cdd": round(self.cdd, 1), "hdd": round(self.hdd, 1),
            "ghi_kwh": round(self.ghi_total_kwh, 1),
            "rh": round(self.rh_mean, 1), "wind": round(self.wind_mean, 2),
            "cloud": round(self.cloud_mean, 3),
            "noon_alt": round(self.sun_noon_altitude, 1),
            "rep_date": self.rep_date, "rep_doy": self.rep_doy,
            "rep_rms_k": round(self.rep_rms_k, 3),
            "diurnal_c": [round(v, 2) for v in self.diurnal_c],
        }


class YearMet:
    """One year of hourly meteorology for the study area, ready for the physics.

    Arrays are parallel and hour-indexed. ``t_air`` is the bias-corrected series
    and is what the model runs on; ``t_air_raw`` is ERA5 as delivered and is
    carried so the correction is always inspectable.
    """

    def __init__(self, payload: dict, lat: float, lon: float,
                 bias: BiasCorrection | None = None) -> None:
        h = payload["hourly"]
        self.lat, self.lon = lat, lon
        self.units = payload.get("hourly_units", {})
        self.cell = (payload.get("latitude"), payload.get("longitude"))
        self.elevation = payload.get("elevation")
        self.start, self.end = h["time"][0][:10], h["time"][-1][:10]

        n = len(h["time"])
        self.times: list[str] = list(h["time"])
        self.hour_of_day = np.empty(n, dtype=np.int16)
        self.doy = np.empty(n, dtype=np.int16)
        self.month = np.empty(n, dtype=np.int16)
        self.day_index = np.empty(n, dtype=np.int32)
        self.utc_offset = np.empty(n, dtype=np.float32)
        self.dates: list[str] = []

        seen: dict[str, int] = {}
        for i, stamp in enumerate(h["time"]):
            dt = datetime.fromisoformat(stamp).replace(tzinfo=TZ)
            d = stamp[:10]
            if d not in seen:
                seen[d] = len(self.dates)
                self.dates.append(d)
            self.day_index[i] = seen[d]
            self.hour_of_day[i] = dt.hour
            self.doy[i] = dt.timetuple().tm_yday
            self.month[i] = dt.month
            off = dt.utcoffset()
            self.utc_offset[i] = (off.total_seconds() / 3600.0) if off else -5.0

        def arr(key: str, fill: float = 0.0) -> np.ndarray:
            raw = h.get(key) or [fill] * n
            return np.array([fill if v is None else float(v) for v in raw],
                            dtype=np.float32)

        self.t_air_raw = arr("temperature_2m", 15.0)
        self.rh = np.clip(arr("relative_humidity_2m", 60.0), 1.0, 100.0)
        self.dew = arr("dew_point_2m", 8.0)
        self.apparent_raw = arr("apparent_temperature", 15.0)
        self.cloud = np.clip(arr("cloud_cover", 40.0) / 100.0, 0.0, 1.0)
        self.wind = np.maximum(arr("wind_speed_10m", 3.0), 0.2)
        self.wind_dir = arr("wind_direction_10m", 250.0)
        self.ghi = np.maximum(arr("shortwave_radiation"), 0.0)
        self.dni = np.maximum(arr("direct_normal_irradiance"), 0.0)
        self.dhi = np.maximum(arr("diffuse_radiation"), 0.0)
        self.precip = np.maximum(arr("precipitation"), 0.0)

        self.bias = bias
        self.t_air = (bias.apply(self.t_air_raw, self.hour_of_day)
                      if bias is not None else self.t_air_raw.copy())
        # The apparent-temperature series inherits the same correction, so the
        # two do not disagree about how warm the day was.
        self.apparent = (bias.apply(self.apparent_raw, self.hour_of_day)
                         if bias is not None else self.apparent_raw.copy())

        self._suns: list[solar.SunPosition] | None = None
        self._days: list[DayRecord] | None = None
        self._months: list[MonthRecord] | None = None

    # --------------------------------------------------------------- basics
    def __len__(self) -> int:
        return len(self.times)

    @property
    def n_days(self) -> int:
        return len(self.dates)

    def index_of(self, day: str, hour: int) -> int | None:
        """Hour index for a date string and a local wall-clock hour."""
        try:
            di = self.dates.index(day)
        except ValueError:
            return None
        hits = np.where((self.day_index == di) & (self.hour_of_day == hour))[0]
        return int(hits[0]) if len(hits) else None

    def day_slice(self, day: str) -> np.ndarray:
        di = self.dates.index(day)
        return np.where(self.day_index == di)[0]

    # ----------------------------------------------------------- solar path
    def sun(self, i: int) -> solar.SunPosition:
        """Solar position at hour ``i``, half-past the hour, in local time.

        Half-past, because Open-Meteo's hourly radiation is the mean over the
        preceding hour and the mid-point is the geometry that mean belongs to.
        The same convention the one-day pipeline uses, kept identical so the
        year and the event day cannot disagree about where the sun was.
        """
        if self._suns is None:
            self._suns = [None] * len(self)          # type: ignore[list-item]
        cached = self._suns[i]
        if cached is not None:
            return cached
        stamp = self.times[i]
        y, m, d = int(stamp[:4]), int(stamp[5:7]), int(stamp[8:10])
        s = solar.sun_position(self.lat, self.lon, y, m, d,
                               float(self.hour_of_day[i]) + 0.5,
                               utc_offset=float(self.utc_offset[i]))
        self._suns[i] = s
        return s

    def sun_altitudes(self) -> np.ndarray:
        return np.array([self.sun(i).altitude for i in range(len(self))],
                        dtype=np.float32)

    # ----------------------------------------------------------- day records
    @property
    def days(self) -> list[DayRecord]:
        if self._days is not None:
            return self._days
        out: list[DayRecord] = []
        alt = self.sun_altitudes()
        for di, day in enumerate(self.dates):
            k = np.where(self.day_index == di)[0]
            t = self.t_air[k]
            hod = self.hour_of_day[k]
            # Night is the block a sleeping person is exposed to: 22:00 to 06:00.
            night = k[(hod >= 22) | (hod <= 6)]
            t_night_min = float(self.t_air[night].min()) if len(night) else float(t.min())
            above35 = np.maximum(t - T_HOT_C, 0.0)
            out.append(DayRecord(
                date=day, doy=int(self.doy[k[0]]), month=int(self.month[k[0]]),
                t_max=float(t.max()), t_min=float(t.min()), t_mean=float(t.mean()),
                t_max_hour=int(hod[int(np.argmax(t))]),
                rh_mean=float(self.rh[k].mean()),
                wind_mean=float(self.wind[k].mean()),
                cloud_mean=float(self.cloud[k].mean()),
                ghi_total_kwh=float(self.ghi[k].sum()) / 1000.0,
                dni_peak=float(self.dni[k].max()),
                precip_mm=float(self.precip[k].sum()),
                hours_above_35=float((t > T_HOT_C).sum()),
                hours_above_32=float((t > T_WARM_C).sum()),
                degree_hours_above_35=float(above35.sum()),
                tropical_night=bool(t_night_min > T_TROPICAL_NIGHT_C),
                cdd=max(0.0, float(t.mean()) - T_BASE_C),
                hdd=max(0.0, T_BASE_C - float(t.mean())),
                daylight_hours=float((alt[k] > 0).sum()),
                sun_noon_altitude=float(alt[k].max()),
            ))
        self._days = out
        return out

    # --------------------------------------------------------- month records
    @property
    def months(self) -> list[MonthRecord]:
        if self._months is not None:
            return self._months
        days = self.days
        out: list[MonthRecord] = []
        for m in range(1, 13):
            dm = [d for d in days if d.month == m]
            if not dm:
                continue
            k = np.where(self.month == m)[0]
            hod = self.hour_of_day[k]
            # Mean diurnal profile for the month, then the day closest to it.
            diurnal = np.array([
                float(self.t_air[k[hod == h]].mean()) if (hod == h).any() else np.nan
                for h in range(24)
            ])
            # WHICH DAY STANDS FOR THE MONTH, and it is not purely the closest
            # diurnal profile.
            #
            # The representative day is solved at full facade resolution and every
            # other day of its month is reconstructed from it. Two things make a
            # reconstruction wrong: a different air temperature, which the
            # reconstruction corrects, and a different SOLAR DECLINATION, which it
            # cannot. Declination moves about 0.4 deg a day near the equinoxes, so
            # a representative day at the start of March is up to five degrees of
            # declination away from the end of it — enough to move the shadow line
            # and change the incidence angle on every lit band.
            #
            # So the score is the diurnal RMS plus a penalty for distance from the
            # month's midpoint. The 0.05 K per day is calibrated to make them
            # comparable: a day 15 days off the midpoint costs 0.75 K of notional
            # RMS, which is about the spread between candidate days' own RMS
            # values, so a genuinely much better profile can still win while an
            # equally good one at the edge of the month cannot.
            best, best_rms, best_score = dm[0], float("inf"), float("inf")
            mid_doy = float(np.median([d.doy for d in dm]))
            for d in dm:
                kd = self.day_slice(d.date)
                prof = np.full(24, np.nan, dtype=np.float64)
                prof[self.hour_of_day[kd]] = self.t_air[kd]
                ok = np.isfinite(prof) & np.isfinite(diurnal)
                if ok.sum() < 20:
                    continue
                rms = float(np.sqrt(np.mean((prof[ok] - diurnal[ok]) ** 2)))
                score = rms + 0.05 * abs(d.doy - mid_doy)
                if score < best_score:
                    best, best_rms, best_score = d, rms, score
            out.append(MonthRecord(
                month=m, label=MONTH_NAMES[m - 1], days=len(dm),
                t_max_mean=float(np.mean([d.t_max for d in dm])),
                t_min_mean=float(np.mean([d.t_min for d in dm])),
                t_mean=float(np.mean([d.t_mean for d in dm])),
                t_max_abs=float(max(d.t_max for d in dm)),
                t_min_abs=float(min(d.t_min for d in dm)),
                hours_above_35=float(sum(d.hours_above_35 for d in dm)),
                hours_above_32=float(sum(d.hours_above_32 for d in dm)),
                degree_hours_above_35=float(sum(d.degree_hours_above_35 for d in dm)),
                tropical_nights=int(sum(1 for d in dm if d.tropical_night)),
                cdd=float(sum(d.cdd for d in dm)),
                hdd=float(sum(d.hdd for d in dm)),
                ghi_total_kwh=float(sum(d.ghi_total_kwh for d in dm)),
                rh_mean=float(np.mean([d.rh_mean for d in dm])),
                wind_mean=float(np.mean([d.wind_mean for d in dm])),
                cloud_mean=float(np.mean([d.cloud_mean for d in dm])),
                sun_noon_altitude=float(np.mean([d.sun_noon_altitude for d in dm])),
                rep_date=best.date, rep_doy=best.doy, rep_rms_k=best_rms,
                diurnal_c=[float(v) if np.isfinite(v) else 0.0 for v in diurnal],
            ))
        out.sort(key=lambda r: r.month)
        self._months = out
        return out

    def month_record(self, m: int) -> MonthRecord:
        """One month's summary.

        NOT called ``month``. ``self.month`` is the per-hour array of calendar
        months assigned in ``__init__``, so a method of that name is shadowed by
        it and calling it raises "'numpy.ndarray' object is not callable" — which
        is exactly what happened the first time anything tried to use it.
        """
        for r in self.months:
            if r.month == int(m):
                return r
        raise KeyError(m)

    # --------------------------------------------------------------- seasons
    def seasons(self) -> list[dict]:
        days = self.days
        out = []
        for name, months in SEASONS.items():
            ds = [d for d in days if d.month in months]
            if not ds:
                continue
            out.append({
                "season": name, "months": list(months), "days": len(ds),
                "tmax_mean": round(float(np.mean([d.t_max for d in ds])), 2),
                "tmin_mean": round(float(np.mean([d.t_min for d in ds])), 2),
                "tmean": round(float(np.mean([d.t_mean for d in ds])), 2),
                "h35": round(float(sum(d.hours_above_35 for d in ds)), 1),
                "kh35": round(float(sum(d.degree_hours_above_35 for d in ds)), 1),
                "trop": int(sum(1 for d in ds if d.tropical_night)),
                "cdd": round(float(sum(d.cdd for d in ds)), 1),
                "hdd": round(float(sum(d.hdd for d in ds)), 1),
                "ghi_kwh": round(float(sum(d.ghi_total_kwh for d in ds)), 1),
                "noon_alt_mean": round(float(np.mean([d.sun_noon_altitude for d in ds])), 1),
            })
        return out

    # -------------------------------------------------------------- episodes
    def episodes(self, threshold_c: float = T_HOT_C, min_days: int = 2,
                 metric: str = "t_max") -> list[Episode]:
        """Heat-wave episodes: runs of ``min_days`` or more over ``threshold_c``.

        Found by run-length over the daily series rather than declared in
        advance. The project's own study event — 29 June to 5 July 2026 — should
        fall out of this as one of the episodes, and ``scripts/validate.py``
        checks that it does. An episode definition that cannot recover the event
        it was written to describe is not a definition worth shipping.
        """
        days = self.days
        out: list[Episode] = []
        run: list[DayRecord] = []

        def close(run: list[DayRecord]) -> None:
            if len(run) < min_days:
                return
            peak = max(run, key=lambda d: d.t_max)
            out.append(Episode(
                start=run[0].date, end=run[-1].date, days=len(run),
                peak_c=peak.t_max, peak_date=peak.date,
                mean_tmax_c=float(np.mean([d.t_max for d in run])),
                tropical_nights=int(sum(1 for d in run if d.tropical_night)),
                total_degree_hours=float(sum(d.degree_hours_above_35 for d in run)),
            ))

        for d in days:
            hot = getattr(d, metric) >= threshold_c
            if hot:
                run.append(d)
            else:
                close(run)
                run = []
        close(run)
        out.sort(key=lambda e: (-e.days, -e.peak_c))
        return out

    # ---------------------------------------------------------------- totals
    def annual(self) -> dict:
        days = self.days
        t = self.t_air
        return {
            "window": [self.start, self.end],
            "days": len(days),
            "hours": len(self),
            "tmean_c": round(float(t.mean()), 2),
            "tmax_c": round(float(t.max()), 2),
            "tmin_c": round(float(t.min()), 2),
            "tmax_date": max(days, key=lambda d: d.t_max).date,
            "tmin_date": min(days, key=lambda d: d.t_min).date,
            "hours_above_35": round(float((t > T_HOT_C).sum()), 1),
            "hours_above_32": round(float((t > T_WARM_C).sum()), 1),
            "degree_hours_above_35": round(float(np.maximum(t - T_HOT_C, 0).sum()), 1),
            "days_above_35": int(sum(1 for d in days if d.t_max > T_HOT_C)),
            "days_above_32": int(sum(1 for d in days if d.t_max > T_WARM_C)),
            "tropical_nights": int(sum(1 for d in days if d.tropical_night)),
            "cdd": round(float(sum(d.cdd for d in days)), 1),
            "hdd": round(float(sum(d.hdd for d in days)), 1),
            "ghi_total_kwh": round(float(self.ghi.sum()) / 1000.0, 1),
            "rain_mm": round(float(self.precip.sum()), 1),
            "swing_c": round(float(max(d.t_max for d in days)
                                   - min(d.t_min for d in days)), 2),
        }

    # --------------------------------------------------------------- exports
    def provenance(self) -> dict:
        return {
            "source": "ERA5 reanalysis via the Open-Meteo archive (free, no key)",
            "endpoint": "https://archive-api.open-meteo.com/v1/archive",
            "requested_at": [round(self.lat, 4), round(self.lon, 4)],
            "grid_cell": [round(float(self.cell[0]), 4), round(float(self.cell[1]), 4)]
                         if self.cell[0] is not None else None,
            "grid_cell_note": (
                "ERA5's cell is about 0.25 deg (~25 km) and the one containing Midtown "
                "also contains open water and New Jersey. It is a regional 2 m air "
                "temperature, not an urban one, which is what the bias correction is for."
            ),
            "elevation_m": self.elevation,
            "timezone": "America/New_York (local wall clock, DST-aware)",
            "units": self.units,
            "window": [self.start, self.end],
            "hours": len(self),
            "variables": HOURLY_VARS,
            "convention": "hourly values are means over the preceding hour, local time",
            "kind": "reanalysis (bias-corrected)",
            "bias_correction": self.bias.report if self.bias else None,
        }


# ------------------------------------------------------------------ loading


def load(start: str = WINDOW[0], end: str = WINDOW[1], *,
         lat: float = 40.7540, lon: float = -73.9825,
         bias: BiasCorrection | None = None) -> YearMet:
    """Load the cached year. Raises with the fetch command if it is not there."""
    path = cache_path(start, end)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} is missing. Run `python scripts/fetch_year.py` "
            f"--start {start} --end {end} (free, no API key)."
        )
    return YearMet(json.loads(path.read_text()), lat, lon, bias=bias)


def hours_since(start_iso: str, day: str, hour: int) -> int:
    """Index of a (day, hour) into a contiguous hourly series starting at midnight."""
    d0 = date.fromisoformat(start_iso)
    d1 = date.fromisoformat(day)
    return (d1 - d0).days * 24 + hour
