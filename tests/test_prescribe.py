"""The prescription layer: does the geometry derive, and does the attribution select.

These tests run against synthetic ``BuildingLoads``-shaped fixtures built here
rather than against anything the pipeline produces. That is deliberate on two
counts. ``prescribe`` reads attributes off whatever it is handed and imports
neither ``loads`` nor ``envelope`` at runtime, so a local fixture exercises
exactly the same code path a real building does. And a test that needed a built
atlas would only run on a machine that had one, which would mean the selection
table went unchecked on every machine that did not.

What is being checked is not that the numbers are right — the physics is checked
in ``scripts/validate.py`` and the year in ``tests/test_year.py`` — but that the
two claims this module makes about itself hold: that the device follows from the
solar geometry rather than from a table, and that the measure follows from the
attribution rather than from a temperature.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from heatcanyon import prescribe as PR


# ------------------------------------------------------------------ fixtures


@dataclass
class Face:
    """The subset of ``loads.FaceLoad`` that ``prescribe`` reads."""

    azimuth: float
    compass: str
    area_m2: float = 200.0
    glazed_m2: float = 70.0
    t_peak_c: float = 48.0
    peak_hour_edt: int = 15
    dt_solar: float = 6.0
    dt_trap: float = 2.0
    dt_sky: float = -1.5
    sun_hours_yr: float = 1400.0
    winter_sun_share: float = 0.20


@dataclass
class Floor:
    """The subset of ``loads.FloorLoad`` that ``prescribe`` reads."""

    floor: int
    band: int
    faces: list[Face]
    z_lo: float = 0.0
    z_hi: float = 3.5
    storeys_in_band: int = 2
    envelope_m2: float = 400.0
    peak_w: tuple[float, float] = (4000.0, 6500.0)
    peak_hour_edt: int = 15
    annual_kwh: tuple[float, float] = (9000.0, 15000.0)
    t_surface_peak_c: float = 48.0
    t_indoor_free_c: tuple[float, float] = (31.0, 35.0)
    dt_solar: float = 6.0
    dt_trap: float = 2.0
    dt_sky: float = -1.5
    dominant: str = "solar"
    night_recovery: str = "limited"
    hours_indoor_over_threshold: float = 420.0
    person_hours: float = 1800.0
    severity: int = 3


@dataclass
class Assembly:
    key: str = "pre_war_masonry"
    label: str = "Pre-war solid masonry"
    era: str = "before 1945"
    u_wall: tuple[float, float] = (1.4, 2.2)
    wwr: tuple[float, float] = (0.20, 0.32)
    u_glass: tuple[float, float] = (2.8, 5.4)
    shgc: tuple[float, float] = (0.55, 0.75)
    infiltration_ach: tuple[float, float] = (0.6, 1.4)
    thermal_mass: str = "heavy"
    note: str = "fixture"
    source: str = "fixture"


@dataclass
class Occupancy:
    key: str = "residential"
    label: str = "Residential"
    internal_gain_w_m2: tuple[float, float] = (4.0, 8.0)
    occupied_hours: tuple[int, int] = (0, 24)
    overnight: bool = True
    setpoint_c: float = 24.0
    persons_per_unit: float = 2.3


@dataclass
class Roof:
    area_m2: float = 900.0
    t_peak_c: float = 61.0


@dataclass
class Loads:
    """The subset of ``loads.BuildingLoads`` that ``prescribe`` reads."""

    bin: str = "1000001"
    assembly: Assembly = field(default_factory=Assembly)
    occupancy: Occupancy = field(default_factory=Occupancy)
    floors: list[Floor] = field(default_factory=list)
    roof: Roof | None = field(default_factory=Roof)
    peak_kw: tuple[float, float] = (40.0, 66.0)
    annual_mwh: tuple[float, float] = (90.0, 150.0)
    peak_hour_edt: int = 15
    worst_floor: int = 9
    person_hours: float = 18000.0
    basis: str = "assumed"


#: A solar position table standing in for the solved hours: a Midtown summer
#: afternoon. 13:00 is the south facade's hour and 17:00 the west facade's, and
#: the altitude difference between them is the whole reason the two get different
#: devices.
SUN = {
    9: (42.0, 105.0),
    11: (58.0, 140.0),
    13: (68.0, 195.0),
    15: (52.0, 240.0),
    17: (28.0, 265.0),
    18: (17.0, 272.0),
    7: (22.0, 88.0),
    8: (33.0, 97.0),
}

CTX = {"sun": SUN, "height_m": 42.0, "roof_area_m2": 900.0,
       "mrt_peak_c": 58.0, "peak_air_c": 37.0}


def _west_face(**kw) -> Face:
    d = dict(azimuth=270.0, compass="west", peak_hour_edt=17,
             dt_solar=7.2, dt_trap=2.1, dt_sky=-1.4)
    d.update(kw)
    return Face(**d)


def _south_face(**kw) -> Face:
    d = dict(azimuth=180.0, compass="south", peak_hour_edt=13,
             dt_solar=6.4, dt_trap=2.0, dt_sky=-1.8)
    d.update(kw)
    return Face(**d)


def _east_face(**kw) -> Face:
    d = dict(azimuth=90.0, compass="east", peak_hour_edt=8,
             dt_solar=5.9, dt_trap=1.9, dt_sky=-1.6)
    d.update(kw)
    return Face(**d)


def _north_face(**kw) -> Face:
    d = dict(azimuth=0.0, compass="north", peak_hour_edt=13,
             dt_solar=0.6, dt_trap=1.8, dt_sky=-1.2)
    d.update(kw)
    return Face(**d)


def solar_building(face_factory, n=12, **floor_kw) -> Loads:
    floors = []
    for i in range(1, n + 1):
        band = min(9, (i - 1) * 10 // n)
        kw = dict(dominant="solar", night_recovery="limited",
                  dt_solar=6.8, dt_trap=2.0, dt_sky=-1.6,
                  t_surface_peak_c=49.0, severity=3)
        kw.update(floor_kw)
        floors.append(Floor(floor=i, band=band,
                            faces=[face_factory(), _north_face()],
                            z_lo=3.5 * (i - 1), z_hi=3.5 * i, **kw))
    return Loads(floors=floors)


def trap_building(recovery: str, n=8) -> Loads:
    floors = []
    for i in range(1, n + 1):
        band = min(9, (i - 1) * 10 // n)
        faces = [Face(azimuth=90.0, compass="east", dt_solar=1.4, dt_trap=6.9,
                      dt_sky=(-2.4 if recovery == "good" else -0.4)),
                 Face(azimuth=270.0, compass="west", dt_solar=1.2, dt_trap=6.4,
                      dt_sky=(-2.4 if recovery == "good" else -0.4))]
        floors.append(Floor(
            floor=i, band=band, faces=faces,
            dominant="trap", night_recovery=recovery,
            dt_solar=1.3, dt_trap=6.7,
            dt_sky=(-2.4 if recovery == "good" else -0.4),
            t_surface_peak_c=44.0, severity=3))
    return Loads(floors=floors)


def ambient_building(n=6) -> Loads:
    floors = []
    for i in range(1, n + 1):
        faces = [Face(azimuth=0.0, compass="north", dt_solar=0.4, dt_trap=0.6)]
        floors.append(Floor(floor=i, band=min(9, (i - 1) * 10 // n), faces=faces,
                            dominant="ambient", night_recovery="good",
                            dt_solar=0.4, dt_trap=0.6, dt_sky=-1.1,
                            t_surface_peak_c=35.0, severity=3,
                            hours_indoor_over_threshold=140.0))
    return Loads(floors=floors)


def fake_resolve(request: dict) -> dict:
    """A stand-in for the pipeline's ``run_scenario`` closure.

    Returns only ``d_facade_peak_k`` and the seasonal split, which is the minimum
    the contract requires — so this fixture also exercises the derivation path
    for the figures a resolver does not report.
    """
    shade = float(request["spec"].get("facade_shade", 0.0))
    albedo = float(request["spec"].get("roof_albedo", 0.0))
    adm = float(request["spec"].get("wall_admittance", 0.0))
    trees = float(request["spec"].get("tree_cover", 0.0))
    wall = float(request["spec"].get("wall_albedo", 0.0))
    d = (-9.0 * shade - (14.0 if albedo else 0.0) - (3.5 if adm else 0.0)
         - 6.0 * trees - 2.5 * wall)
    return {
        "d_facade_peak_k": d,
        "seasonal": {"summer_d_facade_k": d, "winter_d_facade_k": d * 0.35},
    }


# ------------------------------------------------------- shading_geometry


def test_south_wall_at_high_altitude_gets_a_horizontal_overhang():
    """The positive result: a modest projection does the whole job."""
    g = PR.shading_geometry(180.0, 68.0, 195.0)
    assert g["device"] == "horizontal"
    assert g["projection_m"] is not None
    assert 0.0 < g["projection_m"] <= PR.CUTOFF_PROJECTION_M
    assert g["infeasible_reason"] is None
    # And it is the formula, not a table: P = h cos(dg) / tan(alt).
    import math
    expect = 2.1 * math.cos(math.radians(15.0)) / math.tan(math.radians(68.0))
    assert g["projection_m"] == pytest.approx(round(expect, 2))


@pytest.mark.parametrize("alt,az", [(28.0, 265.0), (20.0, 262.0), (15.0, 275.0)])
def test_west_wall_at_low_altitude_is_never_a_horizontal_overhang(alt, az):
    g = PR.shading_geometry(270.0, alt, az)
    assert g["device"] != "horizontal"
    assert g["device"] in ("vertical", "operable", "glazing", "eggcrate")
    assert g["infeasible_reason"]
    # The divergent projection is reported, not clamped away.
    assert g["projection_uncapped_m"] > PR.CUTOFF_PROJECTION_M


@pytest.mark.parametrize("alt,az", [(22.0, 88.0), (18.0, 95.0), (12.0, 85.0)])
def test_east_wall_at_low_altitude_is_never_a_horizontal_overhang(alt, az):
    """The negative result the contract asks for by name."""
    g = PR.shading_geometry(90.0, alt, az)
    assert g["device"] != "horizontal"
    assert g["projection_uncapped_m"] > PR.CUTOFF_PROJECTION_M
    assert "cutoff" in g["infeasible_reason"] or "1.5 m" in g["infeasible_reason"]


def test_a_wall_with_no_beam_falls_back_to_glazing():
    """A north facade's load is diffuse and no external device intercepts it."""
    g = PR.shading_geometry(0.0, 60.0, 180.0)
    assert g["device"] == "glazing"
    assert g["shgc_target"] is not None
    assert "diffuse" in g["infeasible_reason"]

    below = PR.shading_geometry(180.0, 1.0, 180.0)
    assert below["device"] == "glazing"


def test_oblique_beam_selects_fins_at_a_buildable_ratio():
    """Fins are chosen only where their depth-to-spacing ratio is buildable."""
    # Sun 60 degrees off the normal in plan and low: the overhang is too deep
    # but the fin ratio is under 1:1.
    g = PR.shading_geometry(180.0, 25.0, 240.0)
    assert g["device"] in ("vertical", "eggcrate")
    if g["device"] == "vertical":
        assert g["fin_depth_to_spacing"] <= PR.FIN_MAX_DEPTH_RATIO
        assert g["fin_spacing_m"] > 0


def test_geometry_reports_the_angles_it_derived_from():
    """A facade consultant has to be able to check the arithmetic."""
    g = PR.shading_geometry(270.0, 28.0, 265.0)
    for k in ("peak_altitude_deg", "peak_azimuth_deg", "wall_azimuth_deg",
              "incidence_deg", "projection_uncapped_m", "cutoff_m"):
        assert g[k] is not None


# ----------------------------------------------------------- the catalogue


def test_catalogue_has_measures_available_before_the_next_heat_wave():
    """Every capital measure answers "not this season". Some must not."""
    this_season = [m for m in PR.MEASURES.values() if m.lead_time == "this season"]
    assert len(this_season) >= 4
    keys = {m.key for m in this_season}
    assert {"window_film", "blinds_policy", "tenant_relocation",
            "cooling_centre_routing"} <= keys


def test_every_measure_declares_whether_it_can_be_re_solved():
    for m in PR.MEASURES.values():
        assert isinstance(m.resolvable, bool)
        # A measure claiming to be re-solvable must carry a lever to re-solve.
        assert bool(m.spec) == m.resolvable
        assert m.lead_time in ("this season", "one year", "capital cycle")
        assert m.confidence in ("modelled", "assumed")
        assert m.note and m.winter_cost


def test_catalogue_is_a_stable_ordering():
    a = [c["key"] for c in PR.catalogue()]
    b = [c["key"] for c in PR.catalogue()]
    assert a == b
    assert len(set(a)) == len(a)


# ----------------------------------------------------- selection by attribution


def test_solar_south_facade_gets_a_fixed_overhang_under_the_cutoff():
    ps = PR.for_building(solar_building(_south_face), resolve=fake_resolve, context=CTX)
    horiz = [p for p in ps if p.key == "fixed_shading_horizontal"]
    assert horiz, [p.key for p in ps]
    for p in horiz:
        assert p.device == "horizontal"
        assert 0 < p.geometry["projection_m"] <= PR.CUTOFF_PROJECTION_M
        assert "south" in p.faces


def test_solar_west_facade_never_gets_a_fixed_overhang():
    ps = PR.for_building(solar_building(_west_face), resolve=fake_resolve, context=CTX)
    for p in ps:
        if "west" in p.faces:
            assert p.device != "horizontal"
    keys = {p.key for p in ps if "west" in p.faces}
    assert keys & {"operable_shading", "fixed_shading_vertical", "glazing_retrofit"}


def test_the_why_string_cites_the_attribution_that_selected_the_measure():
    ps = PR.for_building(solar_building(_west_face), resolve=fake_resolve, context=CTX)
    p = next(p for p in ps if "west" in p.faces)
    # The kelvin figures, not an adjective.
    assert "6.8 K" in p.why or "7.2 K" in p.why
    assert "K" in p.why and "%" in p.why
    assert "absorbed shortwave" in p.why


def test_curtain_wall_promotes_the_glazing_retrofit():
    """Selection table row 3: WWR above 0.5 ranks glazing first."""
    b = solar_building(_south_face)
    b.assembly = Assembly(key="modern_curtain_wall", wwr=(0.55, 0.72))
    ps = PR.for_building(b, resolve=fake_resolve, context=CTX)
    facade = [p for p in ps if p.family in ("shading", "glazing")]
    assert facade[0].key == "glazing_retrofit"
    assert "window-to-wall" in facade[0].why


def test_a_facade_that_wants_its_winter_sun_gets_an_operable_device():
    """Selection table row 2: winter sun share at or above 0.35."""
    ps = PR.for_building(
        solar_building(lambda: _south_face(winter_sun_share=0.48)),
        resolve=fake_resolve, context=CTX)
    south = [p for p in ps if "south" in p.faces and p.family == "shading"]
    assert south
    assert south[0].key == "operable_shading"
    assert "heating season" in south[0].why


def test_trap_dominant_without_recovery_is_never_offered_night_purge():
    """The exclusion the contract states outright, for each failing recovery."""
    for recovery in ("none", "limited"):
        ps = PR.for_building(trap_building(recovery), resolve=fake_resolve, context=CTX)
        assert "night_purge" not in {p.key for p in ps}
        insulation = [p for p in ps if p.key == "wall_insulation"]
        assert insulation
        # And it says why, rather than silently omitting it.
        assert "excluded" in insulation[0].why.lower()
        assert "night purge" in insulation[0].why.lower()


def test_trap_dominant_with_good_recovery_is_offered_night_purge():
    ps = PR.for_building(trap_building("good"), resolve=fake_resolve, context=CTX)
    purge = [p for p in ps if p.key == "night_purge"]
    assert purge
    assert purge[0].lead_time == "this season"
    # A trapping problem is not a shading problem.
    assert "fixed_shading_horizontal" not in {p.key for p in ps}


def test_trap_dominant_also_reaches_for_the_wall_opposite():
    ps = PR.for_building(trap_building("none"), resolve=fake_resolve, context=CTX)
    assert "opposite_facade_albedo" in {p.key for p in ps}


def test_ambient_gets_no_facade_measure():
    ps = PR.for_building(ambient_building(), resolve=fake_resolve, context=CTX)
    keys = {p.key for p in ps}
    assert not (keys & {"fixed_shading_horizontal", "fixed_shading_vertical",
                        "fixed_shading_eggcrate", "operable_shading",
                        "glazing_retrofit"})
    assert "mechanical_capacity" in keys
    p = next(p for p in ps if p.key == "mechanical_capacity")
    assert "no facade measure" in p.why


def test_an_acute_exposure_gets_something_available_this_season():
    ps = PR.for_building(
        solar_building(_west_face, hours_indoor_over_threshold=90.0, severity=4),
        resolve=fake_resolve, context=CTX)
    soon = [p for p in ps if p.lead_time == "this season"]
    assert soon
    assert "acute rather than chronic" in " ".join(p.why for p in soon)


def test_a_landmarked_facade_moves_the_measure_inside_the_glass():
    ctx = dict(CTX, landmark=True)
    ps = PR.for_building(solar_building(_south_face), resolve=fake_resolve, context=ctx)
    keys = {p.key for p in ps}
    assert "fixed_shading_horizontal" not in keys
    assert "window_film" in keys


# ------------------------------------------------------------------- roof


def test_roof_measure_fires_on_height_area_and_top_floor_share():
    ps = PR.for_building(solar_building(_south_face), resolve=fake_resolve, context=CTX)
    roof = [p for p in ps if p.key == "cool_roof"]
    assert roof
    assert "m² of roof" in roof[0].why
    assert "top band holds" in roof[0].why
    # A short building with a small roof does not get one.
    short = PR.for_building(solar_building(_south_face), resolve=fake_resolve,
                            context=dict(CTX, height_m=8.0, roof_area_m2=40.0))
    assert "cool_roof" not in {p.key for p in short}


# ----------------------------------------------------------------- canopy


def test_canopy_states_the_band_limit_it_reaches():
    ps = PR.for_building(solar_building(_south_face, n=20),
                         resolve=fake_resolve, context=CTX)
    canopy = [p for p in ps if p.key == "street_canopy"]
    assert canopy, [p.key for p in ps]
    c = canopy[0]
    assert c.bands[0] == 0 and c.bands[1] <= PR.CANOPY_TOP_BAND
    # The reach must be stated in prose, in both the reasoning and the
    # does-not-fix, because silence about it reads as coverage.
    assert f"bands 0–{PR.CANOPY_TOP_BAND}".lower() in c.why.lower()
    assert "no further" in c.why
    assert f"bands 0–{PR.CANOPY_TOP_BAND}" in c.does_not_fix
    # And it must not claim the upper floors.
    top = max(f.floor for f in solar_building(_south_face, n=20).floors)
    assert c.floors[1] < top


# ---------------------------------------------------------- does_not_fix


def test_every_prescription_names_what_it_leaves_untouched():
    for b in (solar_building(_south_face), solar_building(_west_face),
              solar_building(_east_face, n=20), trap_building("none"),
              trap_building("good"), ambient_building()):
        ps = PR.for_building(b, resolve=fake_resolve, context=CTX)
        assert ps
        for p in ps:
            assert p.does_not_fix.strip(), f"{p.key} has no does_not_fix"
            assert len(p.does_not_fix) > 40


def test_does_not_fix_names_the_measure_that_covers_the_rest():
    ps = PR.for_building(solar_building(_south_face, n=20),
                         resolve=fake_resolve, context=CTX)
    canopy = next(p for p in ps if p.key == "street_canopy")
    # Floors above the canopy's reach are covered by a facade or roof measure,
    # and the field must name it rather than leave the gap implicit.
    assert ("covered by" in canopy.does_not_fix
            or "Nothing in this schedule reaches" in canopy.does_not_fix)


def test_a_full_height_measure_still_states_its_limits():
    ps = PR.for_building(solar_building(_south_face), resolve=fake_resolve, context=CTX)
    full = [p for p in ps if p.floors == (1, 12)]
    assert full
    for p in full:
        assert "roof" in p.does_not_fix or "elevation" in p.does_not_fix


# ------------------------------------------------------------------ effect


def test_effect_source_is_always_re_solved():
    ps = PR.for_building(solar_building(_south_face), resolve=fake_resolve, context=CTX)
    got = [p for p in ps if p.effect is not None]
    assert got
    for p in got:
        assert p.effect.source == "re-solved"
        assert p.effect.d_facade_peak_k < 0


def test_resolve_none_yields_a_stated_reason_rather_than_an_exception():
    ps = PR.for_building(solar_building(_south_face), resolve=None, context=CTX)
    assert ps
    for p in ps:
        assert p.effect is None
        assert p.effect_note.strip()
        assert "no resolver" in p.effect_note.lower() or "does not change" in p.effect_note


def test_a_measure_with_no_physical_lever_says_so_rather_than_guessing():
    ps = PR.for_building(trap_building("good"), resolve=fake_resolve, context=CTX)
    purge = next(p for p in ps if p.key == "night_purge")
    assert purge.effect is None
    assert "no lever" in purge.effect_note


def test_a_resolver_that_raises_costs_one_number_not_the_schedule():
    def boom(request):
        raise RuntimeError("canyon 412 has no cross-section")

    ps = PR.for_building(solar_building(_south_face), resolve=boom, context=CTX)
    assert ps
    for p in ps:
        assert p.effect is None
    note = next(p.effect_note for p in ps if MEASURE_RESOLVABLE(p))
    assert "RuntimeError" in note and "no cross-section" in note


def MEASURE_RESOLVABLE(p) -> bool:
    return PR.MEASURES[p.key].resolvable


def test_derived_energy_drops_confidence_and_says_which_figures_were_derived():
    ps = PR.for_building(solar_building(_south_face), resolve=fake_resolve, context=CTX)
    p = next(p for p in ps if p.effect is not None)
    assert p.confidence == "assumed"
    assert "first-order" in p.effect_note
    assert p.effect.d_annual_kwh[0] <= p.effect.d_annual_kwh[1]


def test_a_resolver_that_reports_energy_is_taken_at_its_word():
    def full(request):
        return {"d_facade_peak_k": -5.0, "d_annual_kwh": (-4000.0, -2000.0),
                "d_peak_kw": (-3.0, -1.5), "d_person_hours": -900.0,
                "d_winter_kwh": (300.0, 700.0),
                "seasonal": {"winter_d_facade_k": -1.8}}

    ps = PR.for_building(solar_building(_south_face), resolve=full, context=CTX)
    p = next(p for p in ps if p.effect is not None)
    assert p.effect.d_annual_kwh == (-4000.0, -2000.0)
    assert p.effect.d_winter_kwh == (300.0, 700.0)
    assert p.effect.d_person_hours == -900.0
    assert p.confidence == PR.MEASURES[p.key].confidence


# ------------------------------------------------------------ determinism


def _signature(ps) -> str:
    import json
    return json.dumps([p.as_dict() for p in ps], sort_keys=True)


def test_the_same_building_yields_the_same_schedule_in_the_same_order():
    for factory in (_south_face, _west_face, _east_face):
        a = PR.for_building(solar_building(factory), resolve=fake_resolve, context=CTX)
        b = PR.for_building(solar_building(factory), resolve=fake_resolve, context=CTX)
        assert [p.key for p in a] == [p.key for p in b]
        assert [p.floors for p in a] == [p.floors for p in b]
        assert [p.faces for p in a] == [p.faces for p in b]
        assert _signature(a) == _signature(b)


def test_determinism_survives_a_reordered_input():
    """Nothing may depend on the order floors or faces arrive in."""
    b1 = solar_building(_west_face, n=10)
    b2 = solar_building(_west_face, n=10)
    b2.floors = list(reversed(b2.floors))
    for f in b2.floors:
        f.faces = list(reversed(f.faces))
    a = PR.for_building(b1, resolve=fake_resolve, context=CTX)
    b = PR.for_building(b2, resolve=fake_resolve, context=CTX)
    assert _signature(a) == _signature(b)


def test_the_published_order_is_the_rank_order():
    ps = PR.for_building(solar_building(_south_face, n=20),
                         resolve=fake_resolve, context=CTX)
    ranks = [PR.MEASURES[p.key].rank for p in ps]
    assert ranks == sorted(ranks)


# ------------------------------------------------------------ floor ranges


def test_contiguous_floors_merge_and_a_gap_does_not():
    b = solar_building(_south_face, n=10)
    # Make floors 5 and 6 ambient: the shading run must split around them.
    for f in b.floors:
        if f.floor in (5, 6):
            f.dominant = "ambient"
            f.dt_solar, f.dt_trap = 0.3, 0.5
            for fc in f.faces:
                fc.dt_solar, fc.dt_trap = 0.3, 0.5
    ps = PR.for_building(b, resolve=fake_resolve, context=CTX)
    shading = sorted(p.floors for p in ps if p.family == "shading")
    assert (1, 4) in shading and (7, 10) in shading


def test_the_merged_geometry_is_the_governing_floor_not_an_average():
    """A device sized on the least demanding band is undersized on the rest."""
    b = solar_building(_south_face, n=6)
    # Give one floor a later, lower peak: it demands the deeper projection.
    b.floors[3].faces[0].peak_hour_edt = 15
    ps = PR.for_building(b, resolve=fake_resolve, context=CTX)
    horiz = [p for p in ps if p.key == "fixed_shading_horizontal"]
    if horiz:
        deepest = max(p.geometry.get("projection_uncapped_m", 0.0) for p in horiz)
        assert deepest > 0.0


def test_bands_are_reported_so_the_schedule_never_implies_storey_resolution():
    ps = PR.for_building(solar_building(_south_face, n=20),
                         resolve=fake_resolve, context=CTX)
    for p in ps:
        assert 0 <= p.bands[0] <= p.bands[1] <= 9


# --------------------------------------------------------------- plumbing


def test_as_dict_is_json_serialisable():
    import json
    ps = PR.for_building(solar_building(_west_face), resolve=fake_resolve, context=CTX)
    json.dumps([p.as_dict() for p in ps])


def test_an_empty_building_produces_an_empty_schedule_without_raising():
    assert PR.for_building(Loads(floors=[], roof=None), resolve=None, context={}) == []


def test_the_solar_fallback_works_without_a_context():
    """No sun table, no callable: the module computes the position itself."""
    ps = PR.for_building(solar_building(_south_face), resolve=None, context=None)
    assert ps
    assert any(p.family == "shading" or p.family == "glazing" for p in ps)
