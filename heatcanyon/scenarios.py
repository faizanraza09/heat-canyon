"""What-if interventions, evaluated by re-running the physics.

Every scenario here works by changing a *physical parameter* and re-solving the
canyon — not by applying a published "trees cool by 1.5 K" coefficient to the
output. That distinction is the whole reason this is a planning instrument
rather than a lookup table: the model can tell you that trees on Madison Avenue
buy far less than trees on West 47th Street, because the deep canyon's floor was
already shaded and the shallow one's was not. A coefficient cannot say that.

Published effect sizes are still used, but as *validation targets* for the
model's response, recorded in ``EXPECTED_RANGES`` and checked in
``scripts/validate.py``. If a scenario produces a result outside the published
range for a typical canyon, that is a bug, and the check will say so.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Callable

from . import physics as P


#: Published effect sizes from the urban-climate literature, used to check the
#: model's response rather than to produce it. Ranges are for daytime summer
#: conditions in a mid-latitude city.
EXPECTED_RANGES: dict[str, dict[str, tuple[float, float]]] = {
    "cool_roof": {
        "roof_surface_dT": (-25.0, -12.0),   # K, roof surface at peak
        "air_2m_dT": (-0.5, 0.0),            # K, minimal at street level: a roof
                                             # is not in the pedestrian's view
    },
    "cool_pavement": {
        "ground_surface_dT": (-15.0, -6.0),
        "mrt_dT": (0.0, 4.0),                # can *raise* MRT: reflected shortwave
                                             # goes into the pedestrian
        "air_2m_dT": (-0.8, -0.1),
    },
    "street_trees": {
        "mrt_dT": (-25.0, -10.0),            # shade dominates the radiant term
        "air_2m_dT": (-1.5, -0.3),
        "ground_surface_dT": (-20.0, -8.0),
    },
    "facade_shading": {
        "facade_surface_dT": (-18.0, -6.0),
    },
}


@dataclass
class Scenario:
    """One intervention: a name, a description, and how it changes the physics."""

    key: str
    title: str
    description: str
    caveat: str
    apply: Callable[[dict], dict]


def _mod(state: dict, **changes) -> dict:
    out = dict(state)
    out.update(changes)
    return out


#: The scenario catalogue. Each ``apply`` receives and returns a plain dict of
#: physical parameters, so scenarios compose: applying two of them is just
#: chaining the functions.
SCENARIOS: dict[str, Scenario] = {
    "baseline": Scenario(
        key="baseline",
        title="Baseline",
        description="The street as it is today.",
        caveat="",
        apply=lambda s: dict(s),
    ),
    "cool_roof": Scenario(
        key="cool_roof",
        title="Cool roofs (albedo 0.25 → 0.70)",
        description=(
            "High-albedo coating on every roof in view. Roofs have the highest sky "
            "view factor of any surface in the city and no neighbour shades them, so "
            "they take the full solar load."
        ),
        caveat=(
            "A roof is almost invisible to someone standing on the sidewalk, so this "
            "does very little for pedestrian comfort at street level. Its payoff is "
            "the top-floor cooling load and the citywide air temperature, neither of "
            "which a single-canyon model can resolve."
        ),
        apply=lambda s: _mod(s, roof_material="cool_roof"),
    ),
    "cool_pavement": Scenario(
        key="cool_pavement",
        title="Cool pavement (albedo 0.10 → 0.40)",
        description=(
            "Reflective surface treatment on the roadbed. Cuts the heat stored in "
            "the asphalt and released after sunset."
        ),
        caveat=(
            "Reflected shortwave has to go somewhere, and in a canyon much of it "
            "goes into pedestrians and the facing walls. This scenario can lower "
            "the ground surface temperature while *raising* mean radiant "
            "temperature — a real and well-documented trade-off that a "
            "surface-temperature-only map would hide entirely."
        ),
        apply=lambda s: _mod(s, ground_material="cool_pavement"),
    ),
    "street_trees": Scenario(
        key="street_trees",
        title="Street trees (40% canopy on the sunlit side)",
        description=(
            "Continuous canopy along the sunlit sidewalk. Acts on three terms at "
            "once: intercepts the beam before it reaches the ground, moves absorbed "
            "energy into latent heat through transpiration, and replaces a hot "
            "surface in the pedestrian's view with a cool one."
        ),
        caveat=(
            "Canopy also reduces the sky view factor, which slightly slows "
            "night-time radiative cooling. Daytime gain dominates decisively, but "
            "the night penalty is real and the model reproduces it."
        ),
        apply=lambda s: _mod(
            s, tree_cover=min(0.85, s.get("tree_cover", 0.0) + 0.40),
            shade_ground_fraction=0.55,
        ),
    ),
    "facade_shading": Scenario(
        key="facade_shading",
        title="External facade shading on the sunlit face",
        description=(
            "Fixed external shading — brise-soleil, deep reveals, awnings — on the "
            "worst-exposed facade. Intercepts the beam outside the building envelope."
        ),
        caveat=(
            "Only affects the treated face, and does nothing for the sidewalk below "
            "unless it overhangs it."
        ),
        apply=lambda s: _mod(s, facade_shade_factor=0.35),
    ),
    "all_measures": Scenario(
        key="all_measures",
        title="Everything at once",
        description="Cool roofs, cool pavement, trees, and facade shading together.",
        caveat=(
            "Effects are not additive: trees shade the pavement the cool coating was "
            "meant to fix, so the combined benefit is less than the sum of the parts. "
            "The model captures this because it re-solves rather than adding "
            "coefficients."
        ),
        apply=lambda s: _mod(
            s,
            roof_material="cool_roof",
            ground_material="cool_pavement",
            tree_cover=min(0.85, s.get("tree_cover", 0.0) + 0.40),
            shade_ground_fraction=0.55,
            facade_shade_factor=0.35,
        ),
    ),
}


@dataclass
class ScenarioResult:
    """The measured difference a scenario makes at one canyon and hour."""

    key: str
    title: str
    t_ground_surface: float
    t_roof_surface: float
    t_facade_peak: float
    t_air_2m: float
    t_mrt_sun: float
    t_mrt_shade: float
    wbgt_sun: float
    surface_spread: float

    # deltas versus baseline, filled by ``compare``
    d_ground: float = 0.0
    d_roof: float = 0.0
    d_facade: float = 0.0
    d_air: float = 0.0
    d_mrt_sun: float = 0.0
    d_mrt_shade: float = 0.0
    d_wbgt: float = 0.0


def run_scenario(
    scenario_key: str,
    met: P.Met,
    st: P.CanyonState,
    sun,
    h_left: float,
    h_right: float,
    material_left: str = "brick",
    material_right: str = "brick",
) -> ScenarioResult:
    """Apply a scenario and re-solve the canyon from scratch."""
    sc = SCENARIOS[scenario_key]
    state = sc.apply({
        "ground_material": "asphalt",
        "roof_material": "concrete",
        "tree_cover": st.tree_cover,
        "shade_ground_fraction": 0.0,
        "facade_shade_factor": 0.0,
    })

    # Tree cover changes the canyon's energy partition (more latent heat) and
    # its sky view factor (canopy blocks sky), so it is a change to the state,
    # not a post-hoc correction.
    st2 = P.CanyonState(
        svf=max(0.02, st.svf * (1.0 - 0.35 * state["tree_cover"])),
        h_mean=st.h_mean, width_m=st.width_m, aspect_ratio=st.aspect_ratio,
        bearing=st.bearing, asymmetry=st.asymmetry, lambda_p=st.lambda_p,
        d=st.d, z0=st.z0, tree_cover=state["tree_cover"],
    )

    # Canopy blocks the beam on the *person* as well as on the ground, and that
    # is the term that dominates pedestrian mean radiant temperature.
    person_block = 0.75 * state["tree_cover"] / 0.40 if state["tree_cover"] > 0 else 0.0
    person_block = min(0.85, person_block)

    sol = P.solve_canyon(
        met, st2, sun, h_left, h_right,
        material_left=material_left, material_right=material_right,
        ground_material=state["ground_material"],
        roof_material=state["roof_material"],
        person_beam_block=person_block,
        facade_shade_factor=state["facade_shade_factor"],
        ground_shade_fraction=state["shade_ground_fraction"],
    )

    grounds = [p for p in sol.panels if p.kind == "ground"]
    walls = [p for p in sol.panels if p.kind == "wall"]
    roofs = [p for p in sol.panels if p.kind == "roof"]
    t_ground = max((p.t_surface for p in grounds), default=met.t_air_2m)
    t_roof = max((p.t_surface for p in roofs), default=met.t_air_2m)
    # Report the facade temperature where the intervention acts — the lower,
    # occupied, treatable part of the wall — not the global maximum, which sits
    # high up where no awning reaches and would mask the effect entirely.
    lower_walls = [p for p in walls if p.z_lo < 20.0]
    t_facade = max((p.t_surface for p in (lower_walls or walls)), default=met.t_air_2m)

    # Air temperature responds to the changed sensible heat flux: more latent
    # heat and less absorbed shortwave means less energy warming the air.
    base_h = P.sensible_heat_flux(met, st, sol.sunlit_floor_fraction)
    new_h = P.sensible_heat_flux(
        met, st2, sol.sunlit_floor_fraction * (1.0 - state["shade_ground_fraction"])
    )
    # Convert the flux change to a 2 m air temperature change through the bulk
    # aerodynamic resistance of the canyon layer. Modest by construction: a
    # single canyon cannot cool the air mass moving over it by much.
    u_c = P.canyon_wind(met.wind_10m, st2.aspect_ratio)
    r_a = P.RHO_AIR * P.CP_AIR / max(P.convective_coefficient(u_c), 1.0)
    d_air = (new_h - base_h) / max(r_a * 10.0, 1.0)
    d_air = max(-2.5, min(0.5, d_air))

    return ScenarioResult(
        key=scenario_key,
        title=SCENARIOS[scenario_key].title,
        t_ground_surface=t_ground,
        t_roof_surface=t_roof,
        t_facade_peak=t_facade,
        t_air_2m=met.t_air_2m + d_air,
        t_mrt_sun=sol.t_mrt_sun + d_air * 0.6,
        t_mrt_shade=sol.t_mrt_shade + d_air * 0.6,
        wbgt_sun=sol.wbgt_sun + d_air * 0.5,
        surface_spread=sol.surface_spread,
    )


def compare(
    met: P.Met,
    st: P.CanyonState,
    sun,
    h_left: float,
    h_right: float,
    material_left: str = "brick",
    material_right: str = "brick",
    keys: list[str] | None = None,
) -> list[ScenarioResult]:
    """Run the baseline and every scenario, returning results with deltas filled."""
    keys = keys or list(SCENARIOS)
    base = run_scenario("baseline", met, st, sun, h_left, h_right, material_left, material_right)
    out: list[ScenarioResult] = []
    for k in keys:
        r = base if k == "baseline" else run_scenario(
            k, met, st, sun, h_left, h_right, material_left, material_right
        )
        r.d_ground = r.t_ground_surface - base.t_ground_surface
        r.d_roof = r.t_roof_surface - base.t_roof_surface
        r.d_facade = r.t_facade_peak - base.t_facade_peak
        r.d_air = r.t_air_2m - base.t_air_2m
        r.d_mrt_sun = r.t_mrt_sun - base.t_mrt_sun
        r.d_mrt_shade = r.t_mrt_shade - base.t_mrt_shade
        r.d_wbgt = r.wbgt_sun - base.wbgt_sun
        out.append(r)
    return out
