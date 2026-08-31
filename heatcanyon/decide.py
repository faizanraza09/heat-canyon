"""The adapter: the Dataset on one side, the decision layer's pure functions on
the other.

WHY A SEPARATE MODULE

``loads.building_floors`` takes plain arrays and a list of ``Panel`` records.
``prescribe.for_building`` takes a ``BuildingLoads`` and a ``resolve`` callable.
``portfolio.allocate`` takes ``Candidate`` records. None of the three knows what
a ``Dataset`` is, and that is deliberate — it is what makes each of them
callable from a test with six lines of synthetic input, and what stopped four
modules being written against one another's internals while they were being
written in parallel.

Something still has to do the assembling, though, and if that lived in
``pipeline.py`` the server would have to import the pipeline to answer a
request, while if it lived in ``server.py`` the pipeline would have to import
the server. So it lives here, and both call it. This module is allowed to know
the shape of everything; nothing below it is.

WHAT ``resolve`` ACTUALLY IS

``prescribe`` decides *what* to solve and interprets the answer; it never
re-solves physics itself. That is what keeps a measure's stated effect and the
model's own answer from ever drifting apart — there is one engine, and the
prescription quotes it rather than paraphrasing it.

The callable it is handed is built here, closing over the real intervention
engine, so a prescription's effect is the same computation
``POST /api/intervention`` runs and the same one the analyst's
``run_intervention`` tool runs. Three surfaces, one solve.

THE COST OF BEING HONEST ABOUT RANGES

Every figure that passes through ``envelope.ASSEMBLIES`` is a range, and this
module never collapses one. That means ``building_floors`` is doing roughly
twice the arithmetic it would with midpoints, and the JSON products are roughly
twice the size. Both are worth it: the spread *is* the finding when the input is
an era rule rather than a survey, and a single confident number derived from a
guess is the easiest thing in this system to over-trust.
"""

from __future__ import annotations

import math
from typing import Any, Callable

import numpy as np

from . import economics as EC
from . import envelope as EN
from . import loads as LD
from . import portfolio as PF
from . import prescribe as PR

#: Which solved period the schedule is built on. The event day is the one day
#: the FortyGuard measurement actually covers, so a load quoted "at peak" is
#: quoted against measured air temperature rather than against reanalysis.
EVENT = "event"


# --------------------------------------------------------------- assembling


def panels_of(d, bi: int) -> list[LD.Panel]:
    """This building's facade panels, as ``loads`` wants them."""
    idx = d.panels_of_building.get(bi)
    if idx is None or not len(idx):
        return []
    return [
        LD.Panel(
            index=int(p),
            azimuth=float(d.panel_azimuth[p]),
            length_m=float(d.panel_length[p]),
            base_m=float(d.panel_base[p]),
            top_m=float(d.panel_top[p]),
        )
        for p in idx
    ]


def _annual_for(d, idx: np.ndarray) -> dict[str, np.ndarray]:
    """The annual planes this building's panels occupy, sliced once.

    Only the planes the schedule actually reads. Slicing the full (29,415, 10)
    plane per building was the first version and it made a 150-building export
    take four minutes; the planes are memoised in ``Dataset.plane`` so the cost
    is entirely in the slicing.
    """
    want = ("sun_hours", "dose_kwh", "absorbed_kwh", "degree_hours_35",
            "hours_above_35", "t_max", "summer_mean", "winter_mean",
            "swing", "winter_sun_share")
    out: dict[str, np.ndarray] = {}
    for name in want:
        try:
            out[name] = np.asarray(d.plane(name))[idx, :]
        except Exception:  # noqa: BLE001 — an absent plane degrades one column
            continue

    # The year's own hourly air series, not a plane and not per panel. `loads`
    # needs it to turn one solved day's indoor-to-air offset into an annual hour
    # count; without it `hours_indoor_over_threshold` is 0 and `person_hours`
    # with it, which reads as safety rather than as a missing input. That is the
    # one failure mode this project's labelling exists to prevent, so it is
    # supplied here rather than left to each caller to remember.
    try:
        t_air_year = np.asarray(d.year["hourly"]["t_air_c"], dtype=np.float64)
        out["t_air_year"] = t_air_year
        # And the cooling season's own mean air temperature, which `loads` uses
        # to integrate the ventilation term over the season rather than scaling
        # one solved day. June to September inclusive, matching the season the
        # module's `annual_kwh` is defined over — an annual conduction integral
        # for New York goes large and negative and is not a cooling number.
        # There is no month field on the hourly record — it carries `day_index`
        # into `year.days`, and each day carries its date. So the month comes
        # from the date, which also means it stays correct if the study year ever
        # stops starting in August.
        day_index = np.asarray(d.year["hourly"]["day_index"], dtype=np.int32)
        day_month = np.array([int(rec["date"][5:7]) for rec in d.year["days"]],
                             dtype=np.int32)
        if day_index.size == t_air_year.size and day_month.size:
            summer = np.isin(day_month[np.clip(day_index, 0, day_month.size - 1)],
                             (6, 7, 8, 9))
            if summer.any():
                out["summer_mean_air"] = float(t_air_year[summer].mean())
    except Exception:  # noqa: BLE001
        pass
    return out


def _terms_for(d, idx: np.ndarray) -> dict[str, np.ndarray] | None:
    """The attribution planes, if this build wrote them.

    Returns the SCALED terms — the three rescaled to sum exactly to the observed
    rise. The raw planes overstate it by a second-order error that reaches three
    kelvin on an ordinary sunlit July wall, and a schedule that prints
    "12.4 K of this floor's excess is direct solar" from numbers that add to
    three kelvin more than the floor's actual excess is indefensible. See
    ``physics.SurfaceTerms.scaled`` for why the correction is legitimate rather
    than cosmetic, and docs/DECISIONS.md section 1 for the measured sizes.

    WHICH SAMPLING, AND WHY IT IS NOT THE PEAK ONE.

    The pipeline writes two sets. ``_peak`` takes each band's terms at that
    band's own hottest hour; ``_mean`` averages them over the hours the band is
    actually above 30 degC. The schedule reads ``_mean``, and the reason is that
    the peak-hour set answers the wrong question: a band is at its hottest
    *because* the sun is on it, so sampling there returns "solar" for every
    facade that gets any sun at all — 99.6% of them in this scene, which is a
    tautology dressed as a finding.

    A measure is not chosen against one instant. It is chosen against the hours
    that carry the load, and over those a band in a deep slot spends most of its
    time shaded and hot, heated by the wall opposite. That is a different
    problem needing a different measure, and it is only visible in the working
    mean.

    Falls back to the peak planes if a build wrote those and not these, so an
    older ``web/data`` still produces a schedule — with the caveat that its
    dominant term will read solar almost everywhere.

    A build without either returns None and the schedule reports a dominant term
    it cannot name, which is exactly the state the platform was in before this
    layer and is labelled as such rather than filled in with a guess.
    """
    for suffix in ("mean", "peak"):
        try:
            return {
                "dt_solar": np.asarray(d.plane(f"dt_solar_{suffix}"))[idx, :],
                "dt_trap": np.asarray(d.plane(f"dt_trap_{suffix}"))[idx, :],
                "dt_sky": np.asarray(d.plane(f"dt_sky_{suffix}"))[idx, :],
            }
        except Exception:  # noqa: BLE001
            continue
    return None


def building_loads(d, bin_or_index: str | int, *, period: str = EVENT):
    """Assemble one building's per-floor schedule from the solved fields."""
    bi = (bin_or_index if isinstance(bin_or_index, int)
          else d.bin_to_index.get(str(bin_or_index)))
    if bi is None:
        raise KeyError(f"no building {bin_or_index!r} in the model")

    attrs = d.buildings["attrs"][bi]
    idx = d.panels_of_building.get(bi)
    if idx is None or not len(idx):
        raise KeyError(f"building {bin_or_index!r} has no facade panels")

    p = d.period(d.resolve_period(period) if hasattr(d, "resolve_period") else period)
    # (H, p, B) for this building only. The full period array is 9.9 MB and
    # slicing it per building is what keeps a 150-building export in seconds.
    surface = np.asarray(p.surface)[:, idx, :]
    air = np.asarray(p.air)[:, idx, :] if getattr(p, "air", None) is not None else None
    irr = _irradiance(d, p, idx)

    floors = int(attrs.get("floors") or 0)
    height = float(attrs.get("h") or 0.0)
    if floors <= 0:
        # PLUTO's floor count is missing on some records. Three metres a storey
        # is the standard fallback and it is recorded on the result rather than
        # applied silently, because every per-floor figure downstream inherits it.
        floors = max(1, int(round(height / 3.0)))

    assembly = EN.assembly_for(attrs.get("year"), height, attrs.get("use"))
    occupancy = EN.occupancy_for(attrs.get("use"))

    return LD.building_floors(
        bin=str(attrs.get("bin") or bi),
        floors=floors,
        height_m=height,
        base_m=float(attrs.get("base") or 0.0),
        panels=panels_of(d, bi),
        band_area=None,
        surface=surface,
        air=air,
        irradiance=irr,
        terms=_terms_for(d, idx),
        annual=_annual_for(d, idx),
        assembly=assembly,
        occupancy=occupancy,
        hours=p.hours,
    )


def _irradiance(d, p, idx: np.ndarray) -> np.ndarray:
    """Incident shortwave per panel-band per hour, (H, p, B).

    The pipeline does not write an irradiance field — it writes the surface
    temperature the irradiance produced, which is the more useful quantity and a
    quarter of the bytes. So it is reconstructed here from the sunlit mask and
    the hour's own beam and diffuse, which is the same closed form
    ``yearsolve.wall_irradiance_v`` uses.

    This is an approximation and it is worth naming: it recovers the beam and
    the isotropic diffuse but not the ground-reflected term's dependence on the
    panel's own sky view factor, so it runs a few percent low on a wall facing a
    bright road. It feeds the solar-gain-through-glazing term only; the
    conduction term, which dominates, uses the solved surface temperature and is
    unaffected.
    """
    lit = np.asarray(p.lit)[:, idx, :].astype(np.float32)
    out = np.zeros(lit.shape, dtype=np.float32)
    for h, meta in enumerate(p.hours):
        alt = math.radians(max(float(meta.get("sun_alt", 0.0)), 0.0))
        dni = float(meta.get("dni", 0.0))
        dhi = float(meta.get("dhi", 0.0))
        # cos of incidence on a vertical surface, averaged over the azimuths that
        # are lit at all: the mask already carries which those are.
        beam = dni * max(math.cos(alt), 0.0)
        out[h] = lit[h] * beam + dhi * 0.5
    return out


# ------------------------------------------------------------ the re-solver


def resolver(d, *, bins: list[str] | None = None, streets: list[str] | None = None,
             max_canyons: int = 12) -> Callable[[dict], dict | None]:
    """Build the ``resolve`` callable ``prescribe.for_building`` is handed.

    It closes over the real intervention engine, so a prescription's stated
    effect is the same computation the HTTP endpoint and the analyst's
    ``run_intervention`` tool both run. There is one engine and three callers,
    which is the only arrangement in which the three cannot disagree.

    The callable takes ``{"spec": ..., "period": ..., "window": ...}`` and
    returns the engine's own result dict, or None if the solve failed — a
    prescription whose effect could not be computed says so and is still
    reported, because "we could not price this" is information and dropping the
    measure silently is not.
    """
    from .agent import interventions as IV

    def resolve(request: dict) -> dict | None:
        spec = request.get("spec")
        if spec is None:
            return None
        # `prescribe` asks in its own vocabulary — a lever dict, a face list, a
        # floor range, and "summer, winter, year". The engine answers in a nested
        # structure keyed by period and by surface. Translating between the two
        # is the entire reason this module exists, and getting it wrong is quiet:
        # `result.get("d_facade_peak_k")` on the engine's own dict returns None,
        # `float(None or 0.0)` is 0.0, and every measure comes back with an
        # effect of exactly zero kelvin, `source: "re-solved"`, and no error.
        # That is what happened, and it is why this function now has a test.
        want = request.get("periods") or ["year"]
        period = ("seasons" if any(w in ("summer", "winter") for w in want)
                  else "year")
        try:
            raw = IV.run(
                d, spec=spec,
                period=request.get("period", period),
                window=request.get("window", "peak"),
                max_canyons=int(request.get("max_canyons", max_canyons)),
                bins=list(request.get("bins") or bins
                          or ([str(request["bin"])] if request.get("bin") else [])) or None,
                streets=list(request.get("streets") or streets or []) or None,
            )
        except Exception as exc:  # noqa: BLE001
            # The engine raising on one measure must not lose the other five.
            resolve.errors.append(f"{request.get('measure', spec)}: "
                                  f"{type(exc).__name__}: {exc}")
            return None
        return _flatten_intervention(raw)

    resolve.errors = []  # type: ignore[attr-defined]
    return resolve


def _flatten_intervention(raw: dict | None) -> dict | None:
    """The engine's nested result, in the flat shape ``prescribe`` reads.

    Only the facade delta is taken from the solve. The energy, demand and
    person-hour figures are deliberately NOT invented here: ``prescribe`` derives
    them from the building's own load when they are absent, by a documented
    first-order scaling that drops the prescription's confidence to ``assumed``
    and says so in ``effect_note``. Passing a fabricated kilowatt-hour figure up
    from here would silently promote it to ``modelled``.
    """
    if not raw:
        return None
    overall = raw.get("overall") or {}
    facade = overall.get("facade_lower") or overall.get("facade_peak") or {}
    seasonal = raw.get("seasonal") or {}
    out = {
        "d_facade_peak_k": float(facade.get("mean", 0.0) or 0.0),
        "spread_k": [float(facade.get("p10", 0.0) or 0.0),
                     float(facade.get("p90", 0.0) or 0.0)],
        "made_worse_fraction": float(facade.get("made_worse_fraction", 0.0) or 0.0),
        "canyons_solved": raw.get("canyons_solved"),
        "seasonal": seasonal,
        "note": raw.get("limitations"),
    }
    # The seasonal split is the column the year exists for: a measure that
    # removes several kelvin in July removes January's solar gain too, and the
    # sign of that is the price of the measure rather than a defect in it.
    if seasonal:
        out["d_summer_k"] = seasonal.get("summer_d_facade_k")
        out["d_winter_k"] = seasonal.get("winter_d_facade_k")
        out["seasonal_penalty_k"] = seasonal.get("seasonal_penalty_k")
    return out


# ---------------------------------------------------------------- prescribe


def prescriptions_for(d, bin_: str, *, measures: list[str] | None = None,
                      period: str = "seasons", max_canyons: int = 12) -> dict:
    """One building's schedule and its measures, priced."""
    bl = building_loads(d, bin_)
    resolve = resolver(d, bins=[str(bin_)], max_canyons=max_canyons)
    attrs_i = d.bin_to_index.get(str(bin_))
    attrs = d.buildings["attrs"][attrs_i] if attrs_i is not None else {}
    context = {
        "bin": str(bin_),
        "address": attrs.get("addr"),
        "period": period,
        "units": int(attrs.get("units") or 0),
        "hvi": attrs.get("hvi"),
        "year_built": attrs.get("year"),
        "zip": attrs.get("zip"),
        "land_use": attrs.get("use"),
    }
    pres = PR.for_building(bl, resolve=resolve, context=context)
    # Before pricing, not after: `_price_all` reads `effect.d_annual_kwh`, so a
    # re-derivation that ran afterwards would price the figure it replaced.
    _rederive_solar_effects(pres, bl)
    priced = _price_all(pres, bl)
    return {
        "bin": str(bin_),
        "loads": floors_payload(bl),
        "prescriptions": [_jsonable(x) for x in pres],
        "priced": priced,
        "resolve_errors": list(getattr(resolve, "errors", [])),
        "basis": getattr(bl, "basis", "assumed"),
    }


def _rng(v, nd: int = 1) -> list[float]:
    """A (lo, hi) pair as a two-element list, rounded, never collapsed."""
    if v is None:
        return [0.0, 0.0]
    lo, hi = (v if isinstance(v, (list, tuple)) else (v, v))
    return [round(float(lo), nd), round(float(hi), nd)]


def floors_payload(bl) -> dict:
    """One building's schedule in the shape docs/DECISIONS.md section 7 states.

    THIS EXISTS BECAUSE HANDING THE DATACLASS TO A GENERIC SERIALISER WAS WRONG.

    `_jsonable` emits a dataclass under its own field names — `floor`,
    `t_surface_peak_c`, `dominant`, and faces under `compass` and `t_peak_c`.
    The contract specifies short keys — `f`, `t_surf`, `dom`, and faces under
    `c` and `t` — and the four interface modules were built against the
    contract, because that is what a contract is for.

    Shipping the dataclass names instead did not throw anywhere. It rendered:
    every floor number came out `undefined`, every indoor estimate an em dash,
    every what-if bar `NaN` against a `-999` sentinel, and the worst floor read
    "UNDEFINED". A schedule that is confidently wrong in the reader's own
    typeface is worse than one that fails to load, and nothing in the Python
    tests could have caught it — they check the objects, not the wire format.

    So the translation is explicit and it lives next to the contract it
    implements. The rule is unchanged: a range is a two-element list at both
    ends, and nothing here is permitted to average one.
    """
    asm, occ = bl.assembly, bl.occupancy

    def face(fa) -> dict:
        return {
            "az": round(float(fa.azimuth), 1),
            "c": fa.compass,
            "m2": round(float(fa.area_m2), 1),
            "glazed_m2": round(float(fa.glazed_m2), 1),
            "t": round(float(fa.t_peak_c), 1),
            "hr": int(fa.peak_hour_edt),
            "w": _rng(fa.conduction_w, 0),
            "solar_w": _rng(fa.solar_gain_w, 0),
            "kwh": _rng(fa.annual_kwh, 0),
            "solar": round(float(fa.dt_solar), 2),
            "trap": round(float(fa.dt_trap), 2),
            "sky": round(float(fa.dt_sky), 2),
            "sunh": round(float(fa.sun_hours_yr)),
            "wss": round(float(fa.winter_sun_share), 3),
        }

    def floor(fl) -> dict:
        return {
            "f": int(fl.floor),
            "band": int(fl.band),
            "z_lo": round(float(fl.z_lo), 1),
            "z_hi": round(float(fl.z_hi), 1),
            "storeys": int(fl.storeys_in_band),
            "envelope_m2": round(float(fl.envelope_m2), 1),
            "peak_w": _rng(fl.peak_w, 0),
            "hr": int(fl.peak_hour_edt),
            "annual_kwh": _rng(fl.annual_kwh, 0),
            "t_surf": round(float(fl.t_surface_peak_c), 1),
            "t_in": _rng(fl.t_indoor_free_c, 1),
            "solar": round(float(fl.dt_solar), 2),
            "trap": round(float(fl.dt_trap), 2),
            "sky": round(float(fl.dt_sky), 2),
            "dom": fl.dominant,
            "rec": fl.night_recovery,
            "hrs": round(float(fl.hours_indoor_over_threshold)),
            "ph": round(float(fl.person_hours)),
            "sev": int(fl.severity),
            "faces": [face(fa) for fa in fl.faces],
        }

    return {
        "bin": str(bl.bin),
        "assembly": {
            "key": asm.key, "label": asm.label, "era": asm.era,
            "u_wall": _rng(asm.u_wall, 2), "wwr": _rng(asm.wwr, 2),
            "u_glass": _rng(asm.u_glass, 2), "shgc": _rng(asm.shgc, 2),
            "thermal_mass": asm.thermal_mass,
            "note": asm.note, "source": asm.source,
        },
        "occupancy": {
            "key": occ.key, "label": occ.label,
            "setpoint_c": float(occ.setpoint_c), "overnight": bool(occ.overnight),
        },
        "peak_kw": _rng(bl.peak_kw, 1),
        "annual_mwh": _rng(bl.annual_mwh, 1),
        "peak_hour_edt": int(bl.peak_hour_edt),
        "worst_floor": int(bl.worst_floor),
        "person_hours": round(float(bl.person_hours)),
        "basis": bl.basis,
        "notes": list(bl.notes or []),
        "floors": [floor(fl) for fl in bl.floors],
        "roof": _jsonable(bl.roof) if bl.roof is not None else None,
    }


def _as_saving(v) -> tuple[float, float]:
    """A signed CHANGE as a signed SAVING, which is a negation and not an abs().

    THIS TOOK THE ABSOLUTE VALUE, AND ITS OWN DOCSTRING SAID WHY THAT WAS WRONG.

    `prescribe.Effect` reports deltas: a measure that removes load reports
    `d_annual_kwh` NEGATIVE. `economics.price` wants the amount SAVED, positive.
    Between the two conventions the operation is a negation — which flips the
    endpoints, so they are reordered.

    It used to be `abs()`, under a docstring that ended "some measures genuinely
    do cost energy, so the two must never be confused". Taking the absolute
    value is exactly that confusion: it maps a penalty and a saving of the same
    size onto the same input. Every one of the 29 `wall_insulation` measures in
    the build reported a POSITIVE `d_annual_kwh` — the model's honest answer,
    because dropping a wall's admittance makes its OUTER face run hotter, which
    is what an insulated wall does — and each was priced as though it saved that
    much cooling instead of costing it.

    `price` needs no protecting from the sign: its docstring commits to pricing
    a negative saving "as a loss rather than clamped to zero", and `payback_yr`
    is already None wherever the low end of the saving is not positive. The only
    thing standing between an honest penalty and an honest price was this
    function.
    """
    lo, hi = (v if isinstance(v, (list, tuple)) else (v, v))
    lo, hi = float(lo), float(hi)
    return (-max(lo, hi), -min(lo, hi))


#: `prescribe` names measures by the DEVICE it derived — three kinds of fixed
#: shading, because the geometry selects between them — while `economics` prices
#: by the COST LINE a contractor bills, which does not distinguish an overhang
#: from a fin. The two vocabularies were settled independently against the same
#: contract and neither is wrong; mapping between them is what this module is
#: for. Written out rather than fuzzy-matched, because a near-miss here would
#: silently price a glazing retrofit as a coat of paint.
_COST_LINE = {
    "fixed_shading_horizontal": "external_shading",
    "fixed_shading_vertical": "external_shading",
    "fixed_shading_eggcrate": "external_shading",
    "operable_shading": "operable_shading",
    "glazing_retrofit": "glazing_retrofit",
    "window_film": "window_film",
    "wall_insulation": "exterior_insulation",
    "opposite_facade_albedo": "cool_facade_coating",
    "cool_roof": "cool_roof",
    "roof_insulation": "exterior_insulation",
    "night_purge": "night_purge",
    "mechanical_capacity": "heat_pump",
}

#: Measures this layer will not put a building capex against, and why. They are
#: real and they are selected; what they are not is a line item on this
#: building's capital plan, so pricing them here would move somebody else's
#: budget into this owner's payback calculation.
_NOT_A_BUILDING_COST = {
    "street_canopy": ("a street tree is a Parks Department planting on public "
                      "right-of-way, not a charge against this building"),
    "tenant_relocation": ("an operating decision during a wave, whose cost is "
                          "lost rent and goodwill rather than capital"),
    "cooling_centre_routing": ("a public-health referral, funded by the "
                               "cooling-centre network"),
    "blinds_policy": ("an operating instruction with no capital cost worth "
                      "stating"),
}


#: Every measure whose lever is the SUN, and the two facts that decide how it
#: is priced: where the device sits relative to the glass, and whether it is
#: seasonally selective.
#:
#: ``where`` — the physical distinction the old arrangement collapsed:
#:
#:   ``outside``  A louvre, fin or awning. Intercepts the beam BEFORE the wall,
#:                so it takes the transmitted-solar term AND cools the wall,
#:                which takes part of the conduction term too. Both are real and
#:                they are different terms of the same sum, so crediting both is
#:                not double-counting — the conduction half is exactly what the
#:                canyon engine's -18 to -6 K facade delta measures, and it is
#:                the one place that delta belongs.
#:   ``glass``    A new insulated unit. Takes the solar term through its SHGC and
#:                the GLAZED SHARE of the conduction term through its U-value.
#:                Gets no credit from the outdoor delta: it rejects the beam at
#:                the glass line, so the wall outside barely cools at all — 0.727
#:                K on 560 3 Avenue, which is what made scaling by it absurd.
#:   ``inside``   A film or a blind. Solar term only. The wall outside does not
#:                know it is there, so no conduction credit of either kind.
#:
#: ``winter`` — how much of the summer solar cut also lands in the heating
#: season, which is the device's seasonal selectivity and NOT a fudge factor.
#: Each value is what this catalogue's own ``winter_cost`` prose already claims,
#: now carried as a number so it reaches the money instead of only the page:
#:
#:   operable 0.00   "the point of an operable device is that it retracts, so the
#:                    winter beam is available when it is wanted"
#:   horizontal 0.25 "an overhang sized on the summer profile angle passes most of
#:                    the winter beam underneath it ... the one shading device
#:                    whose seasonal penalty is small by construction". ASSUMED:
#:                    "most" is read as three quarters. The geometry to compute
#:                    it properly is on the prescription — projection, window
#:                    head, and the winter sun altitude — and doing so is the
#:                    obvious next refinement.
#:   fins/eggcrate 1 A fin intercepts the low, near-normal beam, which is
#:                    precisely the winter one. No selectivity at all.
#:   film 1.00       "permanent and unselective ... it cannot be retracted"
#:   glazing 1.00    "rejects the January beam as efficiently as the July one"
_SOLAR_LEVER: dict[str, dict] = {
    "glazing_retrofit": {
        "where": "glass", "winter": 1.00,
        "replaces_unit": True, "default_shgc_target": 0.25,
    },
    "window_film":              {"where": "inside",  "winter": 1.00},
    "operable_shading":         {"where": "outside", "winter": 0.00},
    # The only entry whose winter figure is a FALLBACK. `prescribe` computes the
    # real one per facade from the overhang's own projection against a January
    # sun and puts it on the geometry as `winter_shaded_fraction`; it comes out
    # 0.32 on a south elevation, 0.08 on an east one and None on a north one,
    # which is a spread no single number covers. This 0.25 is what remains for a
    # prescription whose geometry predates that and carries no fraction.
    "fixed_shading_horizontal": {"where": "outside", "winter": 0.25,
                                 "winter_from_geometry": True},
    "fixed_shading_vertical":   {"where": "outside", "winter": 1.00},
    "fixed_shading_eggcrate":   {"where": "outside", "winter": 1.00},
}


def _rederive_solar_effects(prescriptions, loads) -> int:
    """Re-derive the energy of a glass-lever measure from the glass, not the wall.

    WHAT THIS REPLACES, AND WHY IT WAS WRONG
    ----------------------------------------

    `prescribe._derive_energy` converts a re-solved facade delta into energy by
    scaling the building's own load by `|dT| / (T_surface - setpoint)`. That is
    exact for conduction through an opaque wall and it is the wrong lever
    entirely for glass. The canyon engine has no glass in its vocabulary — its
    levers are `wall_albedo`, `ground_albedo`, `roof_albedo`, `tree_cover`,
    `facade_shade` and `wall_admittance` — so a glazing swap was being asked for
    as `facade_shade`, "the fraction of the beam intercepted OUTSIDE the
    envelope". A brise-soleil does that. A low-SHGC unit does not: it lets the
    beam reach the glass and rejects it AT the glass line, so the outdoor
    surface barely moves, and on 560 3 Avenue the model reported 0.727 K and
    scaled the whole benefit down to 2.2% of the facade's cooling load. Measured
    across all 91 glazing measures in the build, the understatement ran from
    3.9x to 544x, median 18.6x — worst exactly where the outdoor delta was
    smallest, which is the signature of a category error and not a calibration
    one.

    The outdoor delta is not discarded and is not wrong. It is a different
    quantity: the urban-heat co-benefit of a cooler facade, which the canyon
    engine is the right thing to ask and which stays on the effect as
    `d_facade_peak_k`. What changes is that the INDOOR energy is no longer
    derived from it by a ratio.

    WHY HERE
    --------

    `prescribe` imports its siblings for type checking only and calls nothing in
    them at runtime, which is what lets its tests run against synthetic
    fixtures; `loads` owns the expression and cannot see a measure. This module
    already holds both and already prices, so the composition belongs here. The
    arithmetic itself is `loads.glass_retrofit_delta`, fifteen lines below the
    expression it differentiates, so the two cannot drift.
    """
    u_new = EC.CONSTANTS["u_glass_retrofit_w_m2k"].pair
    asm = getattr(loads, "assembly", None)
    if asm is None:
        return 0
    setpoint = float(getattr(getattr(loads, "occupancy", None), "setpoint_c", 24.0) or 24.0)
    n = 0
    for p in prescriptions:
        lever = _SOLAR_LEVER.get(getattr(p, "key", ""))
        eff = getattr(p, "effect", None)
        if lever is None or eff is None:
            continue
        faces = set(getattr(p, "faces", None) or [])
        lo_f, hi_f = getattr(p, "floors", (0, 0))
        geo = getattr(p, "geometry", None) or {}
        where = lever["where"]

        winter_scale = float(lever["winter"])
        winter_computed = False
        if lever.get("winter_from_geometry"):
            wsf = geo.get("winter_shaded_fraction")
            if wsf is not None:
                # A north elevation takes no winter beam at all, and `prescribe`
                # returns None for that rather than 0.0 — a different statement,
                # so it falls through to the fallback rather than being read as
                # "this overhang costs nothing in January".
                winter_scale = max(0.0, min(1.0, float(wsf)))
                winter_computed = True
        kw: dict = {"winter_scale": winter_scale}
        if where == "glass":
            kw["shgc_new"] = float(geo.get("shgc_target")
                                   or lever["default_shgc_target"])
            kw["u_glass_new"] = u_new
        else:
            # `facade_shade` is the catalogue's own figure for the fraction of
            # the beam this device stops. For an external device that is what it
            # has always meant. For a film it is the same fraction read at the
            # glass line instead of outside it, which is where a film is.
            spec = PR.MEASURES[p.key].spec or {}
            kw["solar_cut"] = float(spec.get("facade_shade", 0.0))
            if not kw["solar_cut"]:
                continue

        # The conduction half of an EXTERNAL device, and the only place the
        # re-solved outdoor delta is the right lever. It is the same ratio
        # `_derive_energy` applies — the delta over the driving temperature
        # difference — and it is exact for conduction, which is what it is used
        # for here and is not what it was used for before.
        d_facade = abs(float(getattr(eff, "d_facade_peak_k", 0.0) or 0.0))

        d_kwh = [0.0, 0.0]
        d_kw = [0.0, 0.0]
        d_win = [0.0, 0.0]
        d_ph = 0.0
        d_t_in = 0.0
        hours: set[int] = set()
        for fl in getattr(loads, "floors", None) or []:
            if not (lo_f <= int(getattr(fl, "floor", 0)) <= hi_f):
                continue
            treated_here: list = []
            f_sol_here = 0.0
            for fa in getattr(fl, "faces", None) or []:
                if getattr(fa, "compass", None) not in faces:
                    continue
                treated_here.append(fa)
                cf = 0.0
                if where == "outside" and d_facade > 0.0:
                    drive = max(1.0, float(getattr(fl, "t_surface_peak_c", 0.0)) - setpoint)
                    cf = min(1.0, d_facade / drive)
                try:
                    d = LD.solar_control_delta(fa, asm, cond_frac=cf, **kw)
                except Exception:  # noqa: BLE001 — one face, not the schedule
                    continue
                for i in (0, 1):
                    d_kwh[i] += d["kwh"][i]
                    d_kw[i] += d["peak_w"][i] / 1000.0
                    d_win[i] += d["winter_kwh"][i]
                f_sol_here = float(d.get("solar_fraction") or 0.0)
                hours.add(int(getattr(fa, "peak_hour_edt", 0)))
                # kept for the diagnostic below, not for the arithmetic

            # EXPOSURE IS PER FLOOR, NOT PER FACE. A person sits in a room and
            # the room's temperature is solved from what every face admits, so
            # this is called once per storey with all of its treated faces —
            # summing a per-face figure would count the same room repeatedly.
            if treated_here and f_sol_here > 0.0:
                try:
                    x = LD.exposure_delta(fl, treated_here,
                                          solar_fraction=f_sol_here)
                    d_ph += x["d_person_hours"]
                    d_t_in = max(d_t_in, x["d_t_indoor_k"])
                except Exception:  # noqa: BLE001 — one floor, not the schedule
                    pass

        if not any(d_kwh):
            continue

        # Deltas, so a saving is NEGATIVE — `prescribe.Effect`'s convention, and
        # `_as_benefit` downstream depends on it.
        eff.d_annual_kwh = (-abs(d_kwh[1]), -abs(d_kwh[0]))
        eff.d_peak_kw = (-abs(d_kw[1]), -abs(d_kw[0]))
        eff.d_winter_kwh = (abs(d_win[0]), abs(d_win[1]))
        # Person-hours only where the exposure chain actually produced one. A
        # floor whose indoor estimate sits far from the 28 degC threshold has a
        # near-zero slope and legitimately returns nothing, and leaving the old
        # outdoor-delta figure in place there would mix two methods in one
        # column — which is exactly the inconsistency this replaces.
        if d_ph > 0.0:
            eff.d_person_hours = -abs(round(d_ph, 1))
        eff.source = "re-solved facade delta; energy from the solar lever"

        note = getattr(p, "effect_note", "") or ""
        coincidence = (
            "The peak figure is taken at the hour the WHOLE BUILDING peaks, not "
            "at each face's own worst hour, because a demand charge is billed on "
            "the one highest reading the meter takes and a west elevation's "
            "evening maximum is not when a building that peaks mid-afternoon "
            "gets metered."
        )
        mechanism = {
            "glass": ("the new unit's solar heat gain coefficient and U-value. "
                      "The facade kelvin figure beside it earns this measure "
                      "nothing: a low-SHGC unit rejects the beam at the glass "
                      "line, so the wall outside barely cools, and that delta "
                      "is the urban co-benefit rather than a saving here"),
            "outside": ("this device's own shading fraction on the transmitted "
                        "beam, and the re-solved facade delta on the conducted "
                        "skin load. Both terms are real for a device fitted "
                        "outside the glass and they are different halves of the "
                        "same sum, so neither is double-counted"),
            "inside": ("this device's shading fraction on the transmitted beam "
                       "alone. It sits behind the glass, so the wall outside "
                       "does not run cooler and no part of the conduction term "
                       "is credited to it"),
        }[where]
        winter_says = (
            "It takes no heating-season penalty: this device retracts, so the "
            "winter beam is still available."
            if lever["winter"] <= 0.0 else
            f"The heating-season penalty is the same solar term over the winter "
            f"share of the annual dose at {winter_scale:.0%} of the summer cut, "
            + ("computed from this overhang's own projection against a 21 "
               "January sun on this facade's orientation rather than taken from "
               "the catalogue" if winter_computed else
               "this device's seasonal selectivity as the catalogue states it")
            + ", priced as delivered heat rather than inferred from a ratio."
        )
        p.effect_note = (note + " " if note else "") + (
            "Energy is not scaled from the facade temperature delta alone for "
            "this measure. It is the cooling-season expression in loads.py "
            "re-evaluated against " + mechanism + ". " + coincidence + " "
            + winter_says
            + (f" Person-hours are the same lever carried through to exposure: "
               f"{d_t_in:.2f} K off the free-running indoor mean on the worst "
               f"treated storey, converted to hours by the density of this "
               f"building's own annual air series at the 28 °C threshold, so a "
               f"floor already far above it is credited with little and a floor "
               f"sitting on it with a great deal. Linearised about the current "
               f"offset and silent on the daily swing, which the admittance "
               f"procedure damps and this does not differentiate."
               if d_ph > 0.0 else
               " Person-hours are unchanged from the facade-delta scaling: this "
               "measure's treated storeys sit far enough from the 28 °C "
               "threshold that the exposure slope is zero there, so the "
               "exposure chain returns nothing to replace it with.")
        )
        p.confidence = "assumed"
        n += 1
    return n


def _winter_heat(p) -> tuple[float, float] | None:
    """The heating-season penalty to price, or None if it was only inferred.

    ``d_winter_kwh`` reaches this two ways. Where ``_rederive_solar_effects``
    computed it, it is the measure's own solar term over the winter share of the
    annual dose — a heat quantity, priced. Where ``prescribe`` inferred it from
    ``|winter_facade_dT| / |summer_facade_dT| * 0.5`` applied to a cooling
    figure, it is a ratio of a ratio that ``prescribe`` itself calls the least
    certain number on the prescription, and putting a dollar sign on that would
    dress a guess as a cost. So only the computed one is priced, and the
    difference is legible in ``effect.source``.
    """
    eff = getattr(p, "effect", None)
    if eff is None:
        return None
    if "solar lever" not in str(getattr(eff, "source", "") or ""):
        return None
    w = getattr(eff, "d_winter_kwh", None)
    if not w:
        return None
    try:
        lo, hi = float(w[0]), float(w[1])
    except Exception:  # noqa: BLE001
        return None
    return (abs(lo), abs(hi)) if (lo or hi) else None


def _price_all(prescriptions, loads) -> int:
    """Put a price on every measure that has an effect. Returns how many.

    `prescribe` deliberately does not price — its own docstring says so — and
    leaves `Prescription.money` for `economics.price` to fill. Nothing was
    filling it. Every measure came back with `money: null`,
    `Candidate.from_prescription` dropped all of them, and the portfolio was
    empty by construction while reporting no error at all: a whole stage of the
    chain was missing and the only symptom was a programme with nothing in it.

    A measure with no re-solved effect is left unpriced on purpose. Pricing a
    saving the model could not compute would put a dollar figure on a
    kilowatt-hour that does not exist, which is worse than an empty column.
    """
    n = 0
    try:
        gross = sum(f.envelope_m2 for f in loads.floors) or None
    except Exception:  # noqa: BLE001
        gross = None

    for p in prescriptions:
        eff = getattr(p, "effect", None)
        if eff is None or getattr(p, "money", None) is not None:
            continue
        kwh = getattr(eff, "d_annual_kwh", None)
        kw = getattr(eff, "d_peak_kw", None)
        if not kwh or not kw:
            continue

        if p.key in _NOT_A_BUILDING_COST:
            # Left unpriced deliberately, and the reason travels with the
            # measure so the interface can say it rather than showing an empty
            # column that reads as a missing number.
            p.money = None
            note = getattr(p, "effect_note", "") or ""
            why = _NOT_A_BUILDING_COST[p.key]
            p.effect_note = (note + " " if note else "") + (
                f"Not priced against this building: {why}. The measure is still "
                f"selected and its effect is still re-solved; what is absent is "
                f"a capex line, not a benefit.")
            continue

        line = _COST_LINE.get(p.key)
        if line is None:
            p.money = None
            note = getattr(p, "effect_note", "") or ""
            p.effect_note = (note + " " if note else "") + (
                f"Not priced: economics.py carries no capex band for "
                f"'{p.key}'. Adding one is a change to that table, not to this "
                f"prescription — the measure and its effect stand.")
            continue

        try:
            p.money = EC.price(
                measure_key=line,
                area_m2=float(getattr(p, "area_m2", 0.0) or 0.0),
                # Two of the capex bands are quoted per square metre of glass,
                # not of wall; price() picks the denominator and says so in
                # `basis` when this comes back zero.
                glazed_m2=float(getattr(p, "glazed_m2", 0.0) or 0.0),
                # The heating-season penalty, as DELIVERED HEAT. Only where it
                # was computed from the measure's own lever — the inferred
                # figure `_derive_energy` leaves behind is a ratio of a ratio
                # and pricing it would give a number that looks costed and is
                # not. A measure without one is priced on its summer side alone
                # and `effect_note` already says the penalty is unquantified.
                winter_kwh_thermal=_winter_heat(p),
                kwh_saved_yr=_as_saving(kwh),
                kw_peak_saved=_as_saving(kw),
                occupancy=loads.occupancy,
                gross_floor_m2=gross,
            )
            n += 1
        except Exception:  # noqa: BLE001 — one unpriceable measure, not the set
            continue
    return n


# ---------------------------------------------------------------- portfolio


def candidates_from(prescriptions_by_bin: dict[str, list], attrs_by_bin: dict,
                    at_risk_by_bin: dict[str, float] | None = None
                    ) -> list[PF.Candidate]:
    """Turn every priced measure into a portfolio candidate.

    ``Candidate.from_prescription`` is duck-typed on the documented shape, which
    means ATTRIBUTE access — `p.effect`, `p.money` — not dict keys. Handing it
    the serialised form is silent: every lookup misses, every candidate comes
    back None, and the portfolio is empty while 757 measures sit priced one
    function call away. So dicts read back from `prescriptions.json` are wrapped
    first, and the wrapper is recursive because `effect` and `money` are nested.
    """
    out: list[PF.Candidate] = []
    for bin_, pres in prescriptions_by_bin.items():
        a = attrs_by_bin.get(str(bin_), {})
        for p in pres:
            p = _attrify(_as_benefit(p))
            try:
                c = PF.Candidate.from_prescription(
                    p, bin=str(bin_), addr=a.get("addr"),
                    hvi=a.get("hvi"), units=int(a.get("units") or 0),
                    # The building's own modelled exposure, so `portfolio`'s
                    # residual interaction model has a real headroom to work
                    # against rather than inferring one from the largest single
                    # measure. Without it two measures on one building each
                    # claim their full benefit and the programme's total is a
                    # sum of overlapping claims.
                    person_hours_at_risk=(at_risk_by_bin or {}).get(str(bin_)),
                    year_built=a.get("year"), zip=a.get("zip"))
            except Exception as exc:  # noqa: BLE001
                # A measure that cannot be priced is not a candidate, but it is
                # also not an error worth failing the programme over.
                continue
            if c is not None:
                out.append(c)
    # Deterministic: the programme must not depend on dict ordering.
    out.sort(key=lambda c: (str(c.bin), str(c.measure)))
    return out


#: The effect fields that are SIGNED CHANGES on a prescription and MAGNITUDES
#: on a candidate. See `_as_benefit`.
_BENEFIT_FIELDS = ("d_person_hours", "d_annual_kwh", "d_peak_kw",
                   "d_facade_peak_k")


def _as_benefit(p):
    """A prescription with its effect expressed as a benefit, not as a change.

    TWO MODULES, TWO SIGN CONVENTIONS, AND THE ADAPTER RECONCILES THEM.

    `prescribe.Effect` carries deltas: a measure that removes exposure reports
    `d_person_hours` NEGATIVE, because the building's exposure went down. That
    is the right convention for a thing called a delta, and the seasonal columns
    depend on it — a shading measure's winter figure is positive precisely
    because it costs heating.

    `portfolio.Candidate` carries benefits: `person_hours_avoided` is how much
    good the measure does, and it is meaningless below zero. `from_prescription`
    reads `effect.d_person_hours` straight through and orders on
    `capex / person_hours` where the denominator is positive.

    Handing one to the other unreconciled is silent. 726 of 769 candidates came
    back with a negative benefit, every one of them fell to the `ph > 0` guard,
    every ordering key became infinity, and the panel reported a programme that
    avoided minus half a million person-hours. Nothing raised.

    So the benefit fields are taken as magnitudes here, in the one module whose
    job is knowing both shapes. The signed values stay untouched on the
    prescription itself, which is what the schedule and the seasonal column
    read — this returns a shallow copy and mutates nothing.
    """
    if not isinstance(p, dict):
        return p
    eff = p.get("effect")
    if not isinstance(eff, dict):
        return p
    out = dict(p)
    e = dict(eff)
    for k in _BENEFIT_FIELDS:
        v = e.get(k)
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            lo, hi = float(min(v)), float(max(v))
            e[k] = [abs(lo), abs(hi)] if hi <= 0 else [lo, hi]
        elif isinstance(v, (int, float)):
            e[k] = abs(float(v))
    out["effect"] = e
    return out


class _Attr:
    """Attribute access over a plain dict, recursively.

    Only for reading a serialised prescription back into the shape
    `portfolio.Candidate.from_prescription` duck-types against. Deliberately
    minimal and deliberately not a general utility: anything richer would invite
    it to be used where a real dataclass belongs.
    """

    __slots__ = ("_d",)

    def __init__(self, d: dict) -> None:
        object.__setattr__(self, "_d", d)

    def __getattr__(self, name: str):
        try:
            return _attrify(object.__getattribute__(self, "_d")[name])
        except KeyError:
            raise AttributeError(name) from None

    def __repr__(self) -> str:
        return f"_Attr({object.__getattribute__(self, '_d')!r})"


def _attrify(o):
    """A dict becomes attribute-readable; everything else passes through."""
    if isinstance(o, dict):
        return _Attr(o)
    if isinstance(o, list):
        return [_attrify(v) for v in o]
    return o


def programme(d, *, objective: str = "person_hours", budget_usd: float = 2_000_000.0,
              constraint: dict | None = None, candidates: list | None = None) -> dict:
    """Allocate a budget, and say where a second objective would disagree."""
    cands = candidates if candidates is not None else _cached_candidates(d)
    if not cands:
        return {"error": "no priced candidates in this build",
                "candidates": [], "allocation": None}

    alloc = PF.allocate(cands, budget_usd, objective=objective,
                        constraint=constraint or None)
    other = "vulnerable" if objective != "vulnerable" else "person_hours"
    dis = PF.compare_objectives(cands, budget_usd, (objective, other),
                                constraint=constraint or None)
    tariff = _tariff()

    # An ORDER PER OBJECTIVE, as indices into `candidates`, which is what
    # docs/DECISIONS.md section 7 specifies and what the interface reads.
    #
    # Writing only the single ordered `curve` for the requested objective was
    # the first version, and it cost the whole view: the panel found no `curves`
    # key, reported "0 objectives", and had nothing to compare. Indices rather
    # than repeated records because four orderings of 769 candidates is four
    # copies of the same table, and the disagreement between two of them is the
    # point of the panel — it has to hold all four at once.
    # Keyed on OBJECT IDENTITY, not on (bin, measure).
    #
    # A building legitimately carries several prescriptions of one family —
    # operable shading on the west face over floors 4-11 and on the north face
    # over floors 20-26 are two work orders with two areas and two prices — so
    # ten Park Avenue alone has eight rows keyed `operable_shading`. Keying the
    # map on the pair collapsed 769 candidates into 356 distinct slots, and
    # every curve came back with the survivors repeated. `PF.curve` returns the
    # very objects it was given, so identity is exact and cannot collide.
    ident = {id(c): i for i, c in enumerate(cands)}
    curves: dict[str, list[int]] = {}
    for obj in ("person_hours", "degree_hours", "vulnerable", "peak_relief"):
        try:
            ordered = PF.curve(cands, objective=obj, constraint=constraint or None)
        except Exception:  # noqa: BLE001 — an objective this data cannot score
            continue        # is dropped, not faked; the panel shows what exists
        idx = [ident.get(id(c)) for c in ordered]
        curves[obj] = [i for i in idx if i is not None]

    return {
        "objective": objective,
        "budget_usd": budget_usd,
        "curves": curves,
        "curve": [_jsonable(c) for c in PF.curve(cands, objective=objective,
                                                 constraint=constraint or None)],
        "allocation": _jsonable(alloc),
        "phases": {k: [_jsonable(c) for c in v] for k, v in PF.phase(alloc).items()},
        "disagreement": _jsonable(dis),
        "ledger": PF.ledger(alloc, tariff_usd_kwh=tariff),
        "constants_unverified": sum(
            1 for r in EC.constants_table() if not r.get("verified")),
    }


def _tariff():
    c = EC.CONSTANTS.get("electricity_usd_kwh")
    return getattr(c, "value", None) if c is not None else None


_CAND_CACHE: dict[int, list] = {}


def _cached_candidates(d) -> list:
    """Every ranked building's measures, priced once per process.

    Pricing 150 buildings is roughly a thousand canyon re-solves. That is a few
    seconds, which is fine once and unacceptable on every slider drag, so the
    result is held against the Dataset's identity. The cache is deliberately not
    keyed on anything else: a Dataset is immutable once loaded, and a build that
    changes the data restarts the process.
    """
    key = id(d)
    hit = _CAND_CACHE.get(key)
    if hit is not None:
        return hit

    attrs_by_bin = {str(a.get("bin")): a for a in d.buildings["attrs"] if a.get("bin")}
    by_bin: dict[str, list] = {}
    at_risk: dict[str, float] = {}
    for it in d.ranked.get("items", []):
        b = str(it.get("bin"))
        try:
            one = prescriptions_for(d, b, max_canyons=6)
        except Exception:  # noqa: BLE001 — one building must not lose the set
            continue
        by_bin[b] = one["prescriptions"]
        at_risk[b] = float((one["loads"] or {}).get("person_hours") or 0.0)
    out = candidates_from(by_bin, attrs_by_bin, at_risk)
    _CAND_CACHE[key] = out
    return out


# ------------------------------------------------------------------ server


def serve_building(d, bin_: str, *, measures: list[str] | None = None,
                   loads_module: Any = None) -> dict:
    """``POST /api/prescribe``. Signature fixed by ``server.prescribe``."""
    return prescriptions_for(d, bin_, measures=measures)


def serve_portfolio(d, *, objective: str = "person_hours",
                    budget_usd: float = 2_000_000.0,
                    constraint: dict | None = None) -> dict:
    """``GET /api/portfolio``. Signature fixed by ``server.portfolio``."""
    return programme(d, objective=objective, budget_usd=budget_usd,
                     constraint=constraint)


# ------------------------------------------------------------- serialisation


def _jsonable(o: Any) -> Any:
    """Dataclasses, numpy scalars and tuples into something json can hold.

    Ranges stay as two-element lists rather than being averaged. That is the
    whole reason this is written out rather than handed to a generic encoder:
    a serialiser that helpfully collapsed a ``(lo, hi)`` tuple to its midpoint
    would defeat the layer's one non-negotiable property in a place nobody
    would look for it.
    """
    import dataclasses

    if o is None or isinstance(o, (str, bool, int)):
        return o
    if isinstance(o, float):
        # NON-FINITE FLOATS ARE NOT JSON, AND PYTHON WILL WRITE THEM ANYWAY.
        #
        # `json.dumps` emits bare `Infinity` and `NaN` by default. Both are
        # valid Python and neither is valid JSON, so `JSON.parse` rejects the
        # WHOLE FILE — not the field. One candidate whose benefit was zero
        # produced `"usd_per_person_hour": Infinity`, and the browser reported
        # `portfolio.json` as absent from the build while 769 rows sat on disk.
        # The panel then said "0 candidates" and looked like an empty programme
        # rather than a parse error.
        #
        # None, not a large number: a cost per person-hour that could not be
        # computed is missing, and a sentinel would sort into the ordering as if
        # it were a real and very bad candidate.
        return o if math.isfinite(o) else None
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return [_jsonable(v) for v in o.tolist()]
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        out = {f.name: _jsonable(getattr(o, f.name))
               for f in dataclasses.fields(o)}
        # Properties carry the derived reads — `dominant`, `shares`, `severity`
        # — and a reader of the JSON should not have to recompute what the
        # dataclass already exposes.
        for name in ("dominant", "shares", "night_recovery", "severity",
                     "dt_total", "residential", "reading"):
            if isinstance(getattr(type(o), name, None), property):
                out.setdefault(name, _jsonable(getattr(o, name)))
        return out
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [_jsonable(v) for v in o]
    return str(o)
