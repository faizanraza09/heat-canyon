"""Decision currency: the one place every monetary and carbon constant lives.

A dollar figure is the easiest number in this system to over-trust. A reader who
would happily argue with a modelled surface temperature will accept "$41,000 a
year" without asking which tariff, from which year, on which service
classification. That asymmetry is the reason this module exists as a module
rather than as a handful of literals scattered through ``prescribe.py`` and
``portfolio.py``: a stale tariff is a wrong answer that looks right, and the only
defence is to make every constant inspectable, dated, and individually labelled
as sourced or not.

Three decisions shape everything below.

**Every constant carries ``verified``, and the default is False.** The
alternative — shipping a plausible number and letting the reader assume it was
checked — is the failure mode that destroys a project whose entire credibility
rests on its labelling being exact. An honestly flagged unverified constant costs
the reader nothing but a caveat; a confidently wrong one costs them the whole
document. Where a search returned nothing citable the range is widened rather
than narrowed, ``verified`` is False, and the ``note`` says what was looked for
so the next person does not repeat the search.

**Energy and demand are priced separately and must never be folded together.**
Con Edison bills a large building on two meters' worth of arithmetic: cents per
kilowatt-hour for the energy it consumed, and dollars per kilowatt for the single
highest demand it set that month. On SC-9 the demand charge is not the larger
half of the delivery bill, it is almost all of it: 34.50 to 44.05 dollars per
kilowatt-month against 1.54 cents per kilowatt-hour of energy delivery, which at
a 0.5 load factor is about ten cents per kilowatt-hour of demand against one and
a half of energy. A kilowatt of peak clipped for the four summer months is worth
122 to 176 dollars a year; a kilowatt-hour saved is worth twelve to eighteen
cents. Which of the two dominates therefore depends entirely on how peaky the
measure's saving is, and that is a property of the measure the model can
actually compute — so the two are kept apart and both are reported, and the
interface can show which one is carrying the case. Folding them into a blended
cents-per-kWh rate would erase that distinction. It would also double-count,
because an average retail price already contains the utility's demand-charge
revenue spread over kilowatt-hours; that is why ``electricity_usd_kwh`` here is
the *volumetric* rate with the demand component removed, and why
``electricity_all_in_usd_kwh``
sits beside it, clearly labelled, for the cases where a blended figure is what is
wanted.

**Ranges propagate; nothing collapses to a midpoint.** Every arithmetic operation
below is interval arithmetic over ``(lo, hi)`` tuples, so a wider input range can
only produce a wider output range. That is the contract's rule from
``envelope.py`` carried into money, and it matters more here than anywhere else
because the spread on a capex band is often larger than the difference between
two candidate measures. A point estimate would imply a precision the underlying
sources do not have.

``payback_yr`` is ``None`` — not a large number — when a measure does not reliably
pay back. External shading fitted for July also removes solar gain in January, and
for a north-facing wall in a heating-dominated year the annual saving can be
negative. Returning 340 years would let that fact slide past a reader scanning a
table; returning ``None`` forces the interface to say so.
"""

from __future__ import annotations

from dataclasses import dataclass


# --------------------------------------------------------------- the constant


@dataclass(frozen=True)
class Constant:
    """One dated, sourced number, or one dated, sourced range.

    ``value`` is a bare float only where the underlying figure genuinely is a
    point — a statutory penalty rate, a statutory emissions cap — and a
    ``(lo, hi)`` tuple everywhere else. ``verified`` means specifically: this
    value was read off the cited source during this module's authorship, not
    that the author believes it to be about right.
    """

    value: float | tuple[float, float]
    unit: str
    source: str
    as_of: str                 # ISO date, YYYY-MM-DD
    verified: bool = False
    note: str = ""

    @property
    def pair(self) -> tuple[float, float]:
        """The value as an interval, so callers never branch on its type."""
        if isinstance(self.value, tuple):
            return (float(self.value[0]), float(self.value[1]))
        return (float(self.value), float(self.value))


# ------------------------------------------------------------- the constants
#
# Sourcing notes, recorded once here rather than repeated in every ``note``:
#
#   * Con Edison PSC No. 10 Electricity, Service Classification No. 9 (General -
#     Large), Rate I, leaf 445 revision 22, initial effective date 2026-02-01,
#     issued in compliance with the PSC order in Case 25-E-0072 dated
#     2026-01-22. Downloaded and read directly on 2026-08-29 from
#     coned.com/-/media/files/coned/documents/rates/electric/historical/psc-10/
#     tariff/sc-202602.pdf. SC-9 is the right classification for the Midtown
#     stock this study covers: it applies wherever the customer's requirements
#     exceed 10 kW, which every building in the AOI does.
#   * EIA Electric Power Monthly, Table 5.6.A, data for June 2026, released
#     2026-08-26.
#   * EPA eGRID2023 (Rev 2, produced 2025-03-27, published June 2025), Summary
#     Table 1, subregion NYCW = NPCC NYC/Westchester.
#   * NYC Administrative Code sections 28-320.3.1, 28-320.3.1.1, 28-320.3.2 and
#     28-320.6, read on 2026-08-29, cross-checked against the NYC Accelerator
#     LL97 page and the DOB LL97 page the same day.
#
# The capex bands are the weak half of this table and are labelled as such. None
# of them came from a primary cost database. Everything below them is trade-press
# or contractor pricing, mostly national rather than New York, which understates
# New York labour.
#
# WHAT WAS SEARCHED, ON 2026-08-31, SO THE NEXT PERSON DOES NOT REPEAT IT
#
# The two sources that would settle these are RSMeans with the New York City cost
# index, and the NYSERDA programme cost data. Neither is openly accessible. The
# openly accessible candidates were checked and none carries commercial retrofit
# unit costs:
#
#   * NREL ComStock, the DOE commercial building stock model. Has a dedicated
#     measure document for window replacement, window film, exterior wall
#     insulation, roof insulation and secondary windows -- and NO COST DATA in
#     any of them. Each says the outputs support an economic analysis "if cost
#     information ... is available", and the window-film document goes further:
#     "it is unclear what exact format the cost information will be". ComStock
#     is an energy model, not a cost model. It did settle two PERFORMANCE
#     constants, which is why it is cited on `u_wall_retrofit_w_m2k` and
#     `u_glass_retrofit_w_m2k`.
#   * New York State Technical Reference Manual v11. A SAVINGS manual: it gives
#     kWh, kW and therms per 100 square feet by facility type and city, plus
#     coincidence factors, and its only cost content is methodology for how a
#     programme administrator should treat incremental cost. No unit costs. It
#     did independently corroborate the heating penalty; see
#     `heating_usd_kwh_thermal`.
#   * NREL's National Residential Efficiency Measures Database gives window
#     replacement at 46.00 USD/sf, 495 USD/m2, broken out as labour plus material
#     -- but RESIDENTIAL, and for a punched window rather than a curtain-wall
#     unit. It brackets the bottom of `capex_usd_m2_glazing_retrofit` and says
#     nothing about the top, which is where curtain-wall work lives.
#
# So these bands stay unverified on purpose, and the honest summary is that free
# sources can settle what a retrofit ACHIEVES and cannot settle what it COSTS.


CONSTANTS: dict[str, Constant] = {

    # ---- electricity: the volumetric half

    "electricity_usd_kwh": Constant(
        value=(0.125, 0.180),
        unit="USD/kWh",
        source=(
            "Derived: EIA Electric Power Monthly Table 5.6.A (June 2026) New York "
            "State average retail price, 23.56 c/kWh commercial, less the "
            "demand-charge component implied by Con Edison PSC No. 10 SC-9 Rate I"
        ),
        as_of="2026-06-30",
        verified=False,
        note=(
            "TODO: verify against the Con Edison Zone J Market Supply Charge "
            "statement for the month being priced, plus the SC-9 energy delivery "
            "charge (0.0143 USD/kWh high tension, 0.0154 USD/kWh low tension) and "
            "the volumetric adjustments under General Rule 26. This is the "
            "VOLUMETRIC rate only: the demand charge is priced separately and "
            "adding an average retail price on top of it would double-count. The "
            "band is wide on purpose. The supply half of a Con Edison bill is a "
            "monthly market price tracking the NYISO Zone J locational price, not "
            "a tariff constant, so no single sourced figure exists. The endpoints "
            "are arrived at by taking the verified all-in New York commercial "
            "average of 23.56 c/kWh and removing the demand-charge recovery that "
            "average already contains: SC-9 Rate I works out to 24.25 USD/kW per "
            "month high tension and 37.68 USD/kW per month low tension averaged "
            "over the year, which at a 0.4 to 0.6 annual load factor is 5.5 to "
            "12.9 c/kWh, and the EIA commercial average also folds in small SC-2 "
            "customers who pay no demand charge at all, so the true share sits "
            "toward the low end of that. 23.56 less 5.5 to 10.3 gives 13.3 to "
            "18.1 c/kWh, rounded outward to the band above."
        ),
    ),

    "electricity_all_in_usd_kwh": Constant(
        value=(0.2356, 0.2949),
        unit="USD/kWh",
        source=(
            "EIA Electric Power Monthly Table 5.6.A, Average Price of Electricity "
            "to Ultimate Customers by End-Use Sector by State, June 2026 "
            "(released 2026-08-26): New York commercial 23.56 c/kWh, residential "
            "29.49 c/kWh"
        ),
        as_of="2026-06-30",
        verified=True,
        note=(
            "Total revenue divided by total kilowatt-hours, so it already "
            "contains the utility's demand-charge revenue. Carried for reference "
            "and for occupancies with no demand meter (an individually metered "
            "apartment on SC-1); NEVER add this to demand_usd_kw_month. A June "
            "figure and a state-wide one: New York City delivery rates run above "
            "the state average, so if this band is wrong it is low."
        ),
    ),

    # ---- electricity: the demand half, which is what peak shaving moves

    "demand_usd_kw_month": Constant(
        value=(30.41, 44.05),
        unit="USD/kW/month",
        source=(
            "Con Edison PSC No. 10 Electricity, SC-9 (General - Large) Rate I, "
            "leaf 445 rev. 22, effective 2026-02-01, Case 25-E-0072: demand "
            "delivery charge per kW of maximum demand for June, July, August and "
            "September, 30.41 USD/kW high tension to 44.05 USD/kW low tension"
        ),
        as_of="2026-02-01",
        verified=True,
        note=(
            "Summer months only. The same tariff charges 21.17-34.50 USD/kW for "
            "the other eight months, which a cooling-peak measure does not touch. "
            "The range is the high-tension / low-tension spread, and which end a "
            "given building sits at depends on its service voltage, which PLUTO "
            "does not carry. A building large enough for SC-9 Rate II "
            "(time-of-day, mandatory above 1,500 kW) faces a different and lower "
            "per-kW structure; prescriptions for the largest towers in the AOI "
            "will overstate the demand saving on this constant."
        ),
    ),

    "demand_months_billed_yr": Constant(
        value=4.0,
        unit="months/year",
        source=(
            "Con Edison PSC No. 10 SC-9 Rate I: the summer demand rate applies to "
            "the months of June, July, August and September"
        ),
        as_of="2026-02-01",
        verified=True,
        note=(
            "A cooling-peak reduction is assumed to be realised in each of the "
            "four summer billing months and in none of the other eight. That is "
            "the conservative reading: a facade measure does reduce the shoulder "
            "months' peak somewhat, but the annual maximum demand in those months "
            "is often set by a non-cooling load, so crediting it would be "
            "optimistic."
        ),
    ),

    # ---- the load-to-bill conversion
    #
    # THE ONE CONSTANT WITHOUT WHICH EVERY FIGURE BELOW IS WRONG BY ITS OWN
    # VALUE.
    #
    # `loads.py` reports a THERMAL cooling load: `q_cond` is U*A*dT and `q_sol`
    # is SHGC*I*A, both heat flows in watts, and its own comment says the figure
    # is "what a machine would have to remove to hold the setpoint". A chiller
    # removing a kilowatt-hour of heat does not buy a kilowatt-hour of
    # electricity to do it; it buys one over its coefficient of performance.
    # Nothing in this module or in `loads.py` performed that division, so every
    # dollar, every tonne and every LL97 figure this table has ever produced was
    # a thermal quantity priced at an electrical tariff -- too generous by the
    # whole COP. It surfaced only when the heating side was priced, because heat
    # delivered by a boiler IS about one for one with its fuel and the two
    # halves stopped agreeing.

    "cooling_cop": Constant(
        value=(2.5, 4.0),
        unit="kWh of heat removed per kWh of electricity",
        source="No citable figure found for this stock; reasoned from equipment class",
        as_of="2026-08-31",
        verified=False,
        note=(
            "TODO: verify against the LL84 benchmarking disclosure for these BINs, "
            "which reports electricity and floor area and would bound the system "
            "COP directly. This is a SEASONAL SYSTEM COP, not an equipment rating: "
            "a centrifugal chiller is rated 4.5-6.0 at design conditions and a "
            "building does not run at design conditions, so pumps, cooling-tower "
            "fans, distribution and part-load operation are all inside this band "
            "and are why its top end is well below any nameplate. The low end is "
            "packaged direct-expansion, which much of the smaller stock in this "
            "AOI actually has. The band is deliberately wide and it is "
            "MONOTONE THE OTHER WAY from most of this table: a HIGHER COP means "
            "LESS electricity per unit of heat and therefore a SMALLER saving, so "
            "the pessimistic end of every priced benefit pairs the low thermal "
            "figure with the HIGH COP. Applied to the energy, demand, carbon and "
            "LL97 terms alike, because all four are billed or counted on "
            "electricity and none of them on heat."
        ),
    ),

    # ---- heat, for the winter side of a solar-control measure
    #
    # Every other price in this table is electricity, because everything else
    # this project costs is a cooling load. A solar-control measure is the one
    # family with a heating-season COST — it rejects January's beam as
    # efficiently as July's — and until now that cost was reported in prose and
    # never priced, which let a measure whose winter penalty outweighs its
    # summer benefit show a positive net saving.

    "heating_usd_kwh_thermal": Constant(
        value=(0.040, 0.160),
        unit="USD per kWh of DELIVERED HEAT",
        source=(
            "No citable PRICE found; reasoned from two published fuel prices. The "
            "GAS BASIS is confirmed: New York State Technical Reference Manual "
            "v11 (Joint Utilities, filed 2023-10-06) prices the window-film "
            "measure's heating penalty in THERMS and restricts the measure to "
            "buildings with gas heat, so gas is the fuel a New York solar-control "
            "penalty is actually charged against"
        ),
        as_of="2026-08-31",
        verified=False,
        note=(
            "THAT THIS PENALTY EXISTS AND IS LARGE IS NOW EXTERNALLY CONFIRMED; "
            "only the price per kilowatt-hour is not.\n\n"
            "The New York State TRM's Window-Film measure is applicable, in its "
            "own words, to 'buildings with electric AC and gas heat only', 'due "
            "to negative impacts on space heating'. The State's own regulator "
            "restricts the measure because of the effect this constant prices. "
            "Its worked example -- a small office in New York City, film on "
            "single-pane clear glass -- gives +592 kWh of electricity and MINUS "
            "58.3 therms per 100 square feet of glazing per year. That is 184 kWh "
            "of extra heat per square metre of glass against 64 kWh of "
            "electricity saved, so in thermal terms the penalty is 0.72 to 1.15 "
            "times the cooling benefit across a 2.5-4.0 coefficient of "
            "performance. This project's own model, by a completely independent "
            "route, gives 0.72 to 1.09 for the same ratio. Two methods agreeing "
            "to that degree is the strongest corroboration anything in this table "
            "has, and it also brackets `cooling_cop`.\n\n"
            "TODO: verify against the Con Edison steam tariff (PSC No. 4 Steam) "
            "for the rate class, and against the firm gas rate for the "
            "building's own service classification. THE DENOMINATOR IS DELIVERED "
            "HEAT, not fuel: the plant's seasonal efficiency is folded into this "
            "band deliberately, because splitting it would need a second "
            "unverified constant and the product of two guesses is not more "
            "trustworthy than one wide band. The band spans the two fuels the "
            "Midtown stock actually uses and it is wide because which one a "
            "given building burns is NOT KNOWN to this model. A gas boiler at "
            "1.00-1.80 USD/therm and 0.75-0.85 seasonal efficiency is 0.040 to "
            "0.082 USD per delivered kWh; Con Edison district steam at 30-45 USD "
            "per Mlb, where an Mlb is about 293 kWh of heat, is 0.10 to 0.15 and "
            "is the reason the upper end is where it is. An all-electric "
            "building on a heat pump would sit BELOW this band at a COP above "
            "two, so a measure priced here is penalised harder than an "
            "electrified building would actually be — which is the conservative "
            "direction for a measure whose winter cost is the argument against "
            "it. THE CARBON OF THAT HEAT IS NOT NETTED: burning gas to replace "
            "rejected solar gain emits, and LL97 prices fuel combustion on its "
            "own coefficients, neither of which is in this table. The dollar "
            "penalty is priced; the carbon penalty is stated and not priced."
        ),
    ),

    # ---- how much of the rejected winter sun the boiler actually has to replace
    #
    # NOT ALL OF IT, AND ASSUMING ALL OF IT IS WHAT MADE EVERY GLAZING MEASURE
    # READ "NEVER".
    #
    # `loads.py` can say how much solar a measure stops admitting in the heating
    # season. It cannot say how much of that the building WANTED. A deep-plan
    # Midtown office at 09:00 in January is already rejecting heat from its
    # lighting, its people and its equipment; sun landing on a sunlit perimeter
    # is partly surplus and on the wrong day is a cooling load. Charging the
    # heating plant for every kilowatt-hour of it is the pessimistic extreme, and
    # it is the assumption that was silently in force: a low-SHGC unit came back
    # as never paying back, on a penalty computed as though a boiler made good
    # every joule the glass turned away.
    #
    # Split by occupancy because the two ends of the stock genuinely differ. An
    # office has large internal gains and daytime-only occupancy, so its
    # utilisation is low. A dwelling has small gains, and its heating hours run
    # into the evening when there is no sun to have rejected, but its perimeter
    # IS its habitable room, so more of what does arrive is wanted.
    #
    # This constant can only make a solar-control measure look BETTER, which is
    # exactly why it is flagged hard: it was added after the winter penalty made
    # the catalogue look unpayable, and a reader is entitled to know that a
    # number which relieves the answer arrived after the answer.

    "heating_utilisation_residential": Constant(
        value=(0.50, 0.90),
        unit="fraction of rejected heating-season solar that raises heating demand",
        source="No citable figure found",
        as_of="2026-08-31",
        verified=False,
        note=(
            "TODO: verify against a dynamic simulation, which is the only thing "
            "that can answer it properly — the quantity is the overlap between "
            "hours with solar on the facade and hours with the heating plant "
            "actually calling, and no static rule recovers that. High end of the "
            "stock's range because a dwelling's internal gains are small and its "
            "perimeter is its living space; short of 1.0 because residential "
            "heating demand peaks in the evening and overnight, when there is no "
            "solar gain to have rejected."
        ),
    ),

    "heating_utilisation_office": Constant(
        value=(0.20, 0.60),
        unit="fraction of rejected heating-season solar that raises heating demand",
        source="No citable figure found",
        as_of="2026-08-31",
        verified=False,
        note=(
            "TODO: verify by simulation; see the residential note. Lowest in the "
            "table because this is the internally-load-dominated case: lighting, "
            "occupants and equipment over a deep plate mean a Midtown office is "
            "frequently in cooling on a sunny January afternoon, and solar "
            "rejected then costs the heating plant nothing at all. The band stays "
            "wide because the perimeter zone of the same building, on the same "
            "afternoon, may well be heating."
        ),
    ),

    "heating_utilisation_retail": Constant(
        value=(0.15, 0.55),
        unit="fraction of rejected heating-season solar that raises heating demand",
        source="No citable figure found",
        as_of="2026-08-31",
        verified=False,
        note=(
            "TODO: verify by simulation; see the residential note. Below office: "
            "retail lighting power density is the highest in the stock and much "
            "of the floor area is in cooling year-round. Ground-floor retail in "
            "this AOI is also the most shaded part of any elevation, so the "
            "quantity being scaled is small before this is applied."
        ),
    ),

    "heating_utilisation_other": Constant(
        value=(0.25, 0.85),
        unit="fraction of rejected heating-season solar that raises heating demand",
        source="No citable figure found",
        as_of="2026-08-31",
        verified=False,
        note=(
            "TODO: verify by simulation; see the residential note. The widest "
            "band in this group and deliberately so: 'other' is where an "
            "unclassified use lands, and the honest answer for a building whose "
            "use is unknown is a band that spans the two cases either side of it."
        ),
    ),

    # ---- carbon

    "grid_kg_co2e_kwh": Constant(
        value=(0.3927, 0.4436),
        unit="kg CO2e/kWh",
        source=(
            "EPA eGRID2023 Rev 2 Summary Table 1, subregion NYCW (NPCC "
            "NYC/Westchester): total output rate 865.7 lb CO2e/MWh, non-baseload "
            "output rate 978.0 lb CO2e/MWh"
        ),
        as_of="2023-12-31",
        verified=True,
        note=(
            "Low end is the average (total output) rate, high end the "
            "non-baseload rate, which is eGRID's published proxy for the marginal "
            "generator. A cooling measure removes load at the summer afternoon "
            "peak, when the marginal unit in Zone J is a gas peaker, so the "
            "non-baseload end is the more appropriate one for this study and the "
            "average end is carried as the conservative bound. eGRID2023 carries "
            "2023 generation, so this is the oldest constant in the table; NYCW's "
            "resource mix is 98.2 per cent gas, which changes slowly, but the "
            "figure should be refreshed when eGRID2024 publishes."
        ),
    ),

    # ---- Local Law 97
    #
    # This is the constant where staleness would be actively damaging, so it is
    # the one that was sourced hardest. The penalty rate, the compliance-period
    # boundaries and every cap below were read from the code text on 2026-08-29
    # and cross-checked the same day against the City's own NYC Accelerator page
    # and the DOB Local Law 97 page, whose Covered Buildings List was published
    # in March 2026. The law is live, the first compliance period is running, and
    # the first reports (covering calendar 2024) were filed by 2025-05-01.

    "ll97_penalty_usd_tco2e": Constant(
        value=268.0,
        unit="USD/tCO2e/year over the limit",
        source=(
            "NYC Administrative Code 28-320.6; confirmed against the City's NYC "
            "Accelerator Local Law 97 page, read 2026-08-29"
        ),
        as_of="2026-08-29",
        verified=True,
        note=(
            "The statute reads 'not more than' this amount, so it is a maximum "
            "civil penalty rather than an automatic charge, and the good-faith-"
            "effort and 320.7 financial-constraint pathways can mitigate it. Any "
            "penalty-avoided figure computed from this constant is therefore an "
            "upper bound on a liability the owner may or may not face, and must "
            "be presented as one. Assessed annually, every year the building "
            "stays over its cap. Rent-regulated buildings enter reporting from "
            "2026-01-01 with a first report due 2027-05-01, so the covered set is "
            "still expanding."
        ),
    ),

    "ll97_coefficient_kg_co2e_kwh": Constant(
        value=(0.143068, 0.288962),
        unit="kg CO2e/kWh",
        source=(
            "NYC Administrative Code 28-320.3.1.1: 0.000288962 tCO2e/kWh for "
            "utility electricity, calendar years 2024 through 2029"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "The high end, the 2024-2029 coefficient, is verified from the code "
            "text. TODO: verify the low end. 0.000143068 tCO2e/kWh is widely "
            "reported as the 2030-2034 electricity coefficient, but 28-320.3.2.1 "
            "as written leaves the 2030 coefficients to be developed by the "
            "commissioner by rule, and the rule was not located. The range is "
            "carried as a range deliberately: a measure with a twenty-year life "
            "straddles both compliance periods, and the grid coefficient roughly "
            "halves between them, so the penalty a measure avoids is genuinely "
            "not a single number. This coefficient is a policy instrument, not a "
            "physical emissions factor, and differs from grid_kg_co2e_kwh by "
            "design; do not substitute one for the other."
        ),
    ),

    "ll97_cap_kg_co2e_sf_residential": Constant(
        value=6.75,
        unit="kg CO2e/sf/year",
        source=(
            "NYC Administrative Code 28-320.3.1, occupancy group R-2, calendar "
            "years 2024 through 2029: 0.00675 tCO2e/sf"
        ),
        as_of="2026-08-29",
        verified=True,
        note=(
            "FIRST compliance period, 2024-2029, only. The second period, "
            "2030-2034 (28-320.3.2), cuts R-2 to 0.00407 tCO2e/sf, a 40 per cent "
            "reduction, and on 2024 benchmarking data roughly 57 per cent of "
            "covered properties are projected to exceed the 2030 limits against "
            "under 10 per cent exceeding the current ones. A measure being priced "
            "in 2026 will spend most of its life against the 2030 cap, so a "
            "prescription that clears only the current cap is not a compliance "
            "strategy."
        ),
    ),

    "ll97_cap_kg_co2e_sf_office": Constant(
        value=8.46,
        unit="kg CO2e/sf/year",
        source=(
            "NYC Administrative Code 28-320.3.1, occupancy group B (general), "
            "calendar years 2024 through 2029: 0.00846 tCO2e/sf"
        ),
        as_of="2026-08-29",
        verified=True,
        note=(
            "2030-2034 limit for the same group is 0.00453 tCO2e/sf. Group B "
            "space used as a civic administrative facility for emergency response, "
            "a non-production laboratory or an ambulatory health care facility "
            "carries a far higher limit (0.02381 tCO2e/sf) which this key does not "
            "represent; PLUTO's land-use codes cannot distinguish those uses."
        ),
    ),

    "ll97_cap_kg_co2e_sf_retail": Constant(
        value=11.81,
        unit="kg CO2e/sf/year",
        source=(
            "NYC Administrative Code 28-320.3.1, occupancy group M, calendar "
            "years 2024 through 2029: 0.01181 tCO2e/sf"
        ),
        as_of="2026-08-29",
        verified=True,
        note="2030-2034 limit for the same group is 0.00403 tCO2e/sf.",
    ),

    "ll97_cap_kg_co2e_sf_other": Constant(
        value=8.46,
        unit="kg CO2e/sf/year",
        source=(
            "NYC Administrative Code 28-320.3.1, occupancy group B (general), "
            "used here as the stand-in for buildings this study cannot classify"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify by classifying the building. This is a stated "
            "assumption, not a reading of the law: LL97 assigns limits by "
            "occupancy group and a building whose group is unknown has no "
            "determinate cap. Group B is used because it is the modal "
            "non-residential group in Midtown and sits mid-table. The true limit "
            "spans 0.00426 (S, U) to 0.02381 (H, I-2, I-3) tCO2e/sf, a factor of "
            "five and a half, so an LL97 figure for an unclassified building "
            "should be treated as indicative only."
        ),
    ),

    # ---- discounting and people

    "discount_rate": Constant(
        value=(0.02, 0.08),
        unit="real, per year",
        source=(
            "Low end: OMB Circular A-94 Appendix C, 2026 real discount rates "
            "(30-year, 2.0 per cent), M-26-09 / 91 FR, March 2026. High end: "
            "assumed private-owner hurdle rate, unsourced"
        ),
        as_of="2026-03-11",
        verified=False,
        note=(
            "TODO: verify the upper end. A range rather than a point because the "
            "two ends answer different questions and the project should not "
            "silently pick one. At 2 per cent real the question is 'is this worth "
            "doing for the city', which is the right frame for a public "
            "programme and the frame portfolio.py's cost curve assumes. At 8 per "
            "cent it is 'will a co-op board approve it', which is the frame that "
            "determines whether it actually happens. Measures with long lives "
            "look very different under the two, and that difference is a real "
            "finding rather than noise to be averaged away."
        ),
    ),

    "household_size": Constant(
        value=(1.94, 2.02),
        unit="persons per occupied unit",
        source=(
            "US Census Bureau, ACS 2024 1-year estimates, table B25010 "
            "(Average Household Size of Occupied Housing Units by Tenure), "
            "New York County, NY: total 1.96 +/- 0.02, renter-occupied 1.94 "
            "+/- 0.03, owner-occupied 2.02 +/- 0.06"
        ),
        as_of="2024-12-31",
        verified=True,
        note=(
            "The range is the renter/owner spread rather than the margin of "
            "error, because tenure is the split that matters here: the ranking's "
            "vulnerability term already leans on rented pre-war stock, and the "
            "renter figure is the relevant one for most of the buildings the "
            "portfolio will surface. Manhattan is the smallest-household county "
            "in the state; using a citywide or national figure would inflate "
            "person-hours by roughly a third."
        ),
    ),

    # ---- capex bands, per square metre of TREATED area
    #
    # Every one of these is unverified. The ranges are wide because the honest
    # spread is wide: the same measure on a scaffold-accessible low-rise and on
    # the thirtieth floor of a Midtown tower differ by more than the band below,
    # and none of the sources found were New York specific.

    "capex_usd_m2_external_shading": Constant(
        value=(110.0, 330.0),
        unit="USD/m2 of treated facade",
        source="No citable figure found",
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify against RSMeans with the New York City cost index, or "
            "against NYC Accelerator retrofit case studies. Searched for "
            "installed cost per square metre of fixed external louvre and "
            "brise-soleil retrofit; the trade literature describes the systems "
            "but publishes no pricing. Note the denominator: this is per square "
            "metre of TREATED FACADE, not per square metre of louvre. A "
            "horizontal shelf above a punched window shades a facade band several "
            "times its own area, which is why the band sits an order of magnitude "
            "below curtain-wall unit pricing; an earlier draft priced it as "
            "though the two were comparable and produced a 1,000-year payback on "
            "the module's own worked example, which is how the error surfaced. "
            "European retrofit guidance puts solar shading near 50-150 EUR per "
            "square metre of window, which at a 0.4 window-to-wall ratio is 20-60 "
            "EUR per square metre of facade; the band above is roughly three to "
            "five times that, and the multiple is the allowance for New York "
            "labour and swing-stage access. Facade access "
            "in Midtown — swing stage, sidewalk shed, DOB permitting — is a large "
            "fixed cost this per-square-metre form hides, so small treated areas "
            "will be badly underpriced."
        ),
    ),

    "capex_usd_m2_operable_shading": Constant(
        value=(200.0, 650.0),
        unit="USD/m2 of treated facade",
        source="No citable figure found",
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify. Searched for external motorised blind and screen "
            "retrofit pricing; nothing citable. Set above the fixed-shading band "
            "because operable systems add motors, controls, wind sensors and a "
            "maintenance obligation that fixed louvres do not have. Operable "
            "shading is the measure selected where winter sun matters, so its "
            "cost premium over fixed shading is exactly the price of not "
            "incurring a heating penalty; that trade-off should be shown, not "
            "buried."
        ),
    ),

    "capex_usd_m2_glazing_retrofit": Constant(
        value=(500.0, 1700.0),
        unit="USD/m2 of glazed area",
        source=(
            "Trade press only: commercial window replacement reported at 50-150 "
            "USD/sf installed (538-1,615 USD/m2), high-performance insulated "
            "glass units at 25-80 USD/sf for glass alone"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify against a primary cost database. Contractor marketing "
            "pages, national rather than New York, and mixed between storefront "
            "and curtain-wall work, which are not the same job. This band is per "
            "square metre of GLAZED area, not of facade, which is why it is much "
            "the largest in the table; at a 0.4 window-to-wall ratio it is "
            "200-680 USD per square metre of facade. Upper end raised above the "
            "quoted range for New York labour and for curtain-wall unit "
            "replacement, where the wall itself has to come apart."
        ),
    ),

    "capex_usd_m2_cool_facade_coating": Constant(
        value=(40.0, 180.0),
        unit="USD/m2 of treated facade",
        source=(
            "Extrapolated from reported commercial roof coating pricing of "
            "1.50-7.00 USD/sf (16-75 USD/m2)"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify. No facade-specific coating pricing was found. The band "
            "sits well above the roof-coating figures because the coating "
            "material is the small half of a facade job: surface preparation and "
            "vertical access dominate, and a masonry facade may need repointing "
            "first. Raising facade albedo also raises the reflected shortwave "
            "reaching the building opposite, which physics.py models and which "
            "prescribe.py must consider before recommending it in a narrow "
            "canyon."
        ),
    ),

    "capex_usd_m2_exterior_insulation": Constant(
        value=(150.0, 600.0),
        unit="USD/m2 of treated wall",
        source=(
            "Trade press only: EIFS reported at 9.20-14.80 USD/sf installed "
            "(99-159 USD/m2) for new work, 30-50 USD/sf (323-538 USD/m2) where "
            "existing fabric must be opened up"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify against RSMeans with the New York City cost index. "
            "National residential pricing; the retrofit case is the relevant one "
            "and it is the upper figure. Exterior insulation on a landmarked or "
            "contributing pre-war facade may be prohibited outright, which is a "
            "constraint prescribe.py has to apply and no cost band can express."
        ),
    ),

    "capex_usd_m2_cool_roof": Constant(
        value=(15.0, 80.0),
        unit="USD/m2 of roof",
        source=(
            "Trade press only: commercial roof coating reported at 1.50-7.00 "
            "USD/sf (16-75 USD/m2)"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify. National contractor pricing. Note that the NYC "
            "CoolRoofs programme installs at no cost for eligible buildings, so "
            "for a subset of the ranked list the correct capex is zero and the "
            "binding constraint is programme eligibility rather than money; the "
            "prescription should route to the programme before it quotes a price."
        ),
    ),

    "capex_usd_m2_green_roof": Constant(
        value=(190.0, 650.0),
        unit="USD/m2 of roof",
        source=(
            "Trade press only: green roof installation in New York City reported "
            "at 18-60 USD/sf (194-646 USD/m2), with an informal practitioner "
            "survey giving an average near 26 USD/sf"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify. New York specific, which is better than most of this "
            "block, but the sources are green-roof contractors. Partly offset by "
            "the New York State green roof property tax abatement, 5.23 USD/sf "
            "generally and 15.00 USD/sf in priority areas, capped at 200,000 USD "
            "— that abatement is not netted off here, so the capex shown is "
            "gross. Local Law 92/94 already requires a sustainable roofing zone "
            "on major roof work, which changes the counterfactual: on a building "
            "already re-roofing, the marginal cost is the difference between a "
            "green roof and a cool roof, not the full figure above."
        ),
    ),

    "capex_usd_m2_night_purge": Constant(
        value=(10.0, 60.0),
        unit="USD/m2 of served floor area",
        source="No citable figure found",
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify. Searched for night purge and free-cooling control "
            "retrofit costs; nothing citable. Band assumes actuated relief "
            "dampers, a control sequence and BMS integration on an existing air "
            "system, and assumes such a system exists — a naturally ventilated "
            "pre-war walk-up has no ductwork to purge through and the measure "
            "becomes a window-opening protocol at near-zero capex and near-zero "
            "reliability. The physics gate matters more than the cost here: "
            "prescribe.py excludes this measure entirely where sky view factor "
            "gives no night recovery, because no amount of fan runs against a "
            "canyon that cannot radiate."
        ),
    ),

    "capex_usd_m2_heat_pump": Constant(
        value=(200.0, 600.0),
        unit="USD/m2 of served floor area",
        source="No citable figure found",
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify against NYSERDA and NYC Accelerator programme cost "
            "data. Searched for per-floor split-system and packaged heat-pump "
            "retrofit costs in multifamily and small commercial stock; nothing "
            "citable at this resolution. Excludes any electrical service upgrade, "
            "which in pre-war Manhattan stock is frequently the largest single "
            "line item and can exceed the equipment cost. This is the one measure "
            "in the catalogue that reduces indoor exposure directly rather than "
            "reducing envelope load, so it is the measure that matters most where "
            "night recovery is absent, and its cost band being the least "
            "trustworthy is a real weakness of this table."
        ),
    ),

    "capex_usd_m2_window_film": Constant(
        value=(75.0, 250.0),
        unit="USD/m2 of glazed area",
        source=(
            "Trade press only: commercial window film reported at 7-22 USD/sf "
            "(75-237 USD/m2), rising to 18-25 USD/sf for premium films and "
            "difficult access"
        ),
        as_of="2026-08-29",
        verified=False,
        note=(
            "TODO: verify. Window-tinting contractor pricing. Cheapest measure in "
            "the catalogue and the one with the shortest lead time, which is why "
            "it earns its place, but it cuts daylight and winter solar gain with "
            "no seasonal discrimination at all — unlike operable shading, a film "
            "cannot be retracted in January. The winter penalty is therefore "
            "structural to this measure and prescribe.py must report it."
        ),
    ),

    # ---- measure performance, as against measure cost
    #
    # The only constant in this table that is a PROPERTY of a specified retrofit
    # rather than a price. It sits here because `price` is not where it is used
    # — `prescribe` needs it to compute the effect — but it is dated, banded and
    # flagged on exactly the same terms as everything else, and this is the
    # module whose whole job is that nothing of the sort lives as a literal.

    "u_wall_retrofit_w_m2k": Constant(
        value=(0.25, 0.45),
        unit="W/m2K, opaque build-up",
        source=(
            "ASHRAE, Achieving Zero Energy: Advanced Energy Design Guide for Small "
            "to Medium Office Buildings, overall assembly target for climate zone "
            "4, which is New York City: R-16 hr-ft2-F/Btu, i.e. 0.355 W/m2K. Read "
            "on 2026-08-31 off NREL ComStock's exterior-wall-insulation measure "
            "documentation, Table 2, at "
            "github.com/NatLabRockies/ComStock.github.io "
            "docs/upgrade_measures/env_ext_wall_insulation.md"
        ),
        as_of="2026-08-31",
        verified=False,
        note=(
            "THE ANCHOR IS SOURCED AND THE WIDTH IS NOT, WHICH IS WHY THIS IS "
            "STILL FALSE. ASHRAE's zone-4 target of R-16 is 0.355 W/m2K and lands "
            "almost exactly at this band's midpoint, from a DOE national-lab "
            "publication that is openly readable -- so the centre of this band is "
            "no longer a guess. The width still is: a real build-up varies with "
            "substrate, thickness and thermal bridging, and 0.25 to 0.45 is a "
            "judgment about that spread rather than a figure read off anything. "
            "ComStock's own measure adds XPS at R-5 per inch to reach the target, "
            "so zone 4 needs of the order of an inch over an already-insulated "
            "wall and appreciably more over uninsulated masonry.\n\n"
            "TODO: verify the BAND, not the anchor -- a set of real New York "
            "build-ups with stated substrates and thicknesses would replace a "
            "judgment about spread with a measured one. And note what nothing "
            "here models: the binding constraint on this measure in this AOI is "
            "not the physics but whether the landmarks process will permit a "
            "build-up on a street-facing elevation at all. "
            "Compare against `loads.py`'s assemblies, which "
            "carry 1.0-2.2 W/m2K for the opaque wall, so this is a three- to "
            "eight-fold improvement and the largest single fabric change in the "
            "catalogue. It applies to the SPANDREL ONLY: exterior insulation "
            "stops at the sight line, the glass keeps its own U-value, and on a "
            "curtain wall where the glass carries nine tenths of the assembly's "
            "conductance that is most of the wall left untouched. This is the "
            "reason the measure is prescribed on masonry."
        ),
    ),

    "u_glass_retrofit_w_m2k": Constant(
        value=(1.3, 2.0),
        unit="W/m2K, glass element",
        source=(
            "ASHRAE Advanced Energy Design Guide target assembly U-factor for "
            "climate zone 4A, which is New York City: 0.34 Btu/h-ft2-F, i.e. 1.93 "
            "W/m2K. Read on 2026-08-31 off NREL ComStock's window-replacement "
            "measure documentation, Table 6, at "
            "github.com/NatLabRockies/ComStock.github.io "
            "docs/upgrade_measures/env_ext_window_replacement.md"
        ),
        as_of="2026-08-31",
        verified=False,
        note=(
            "SAME STANDING AS THE WALL BAND ABOVE: the anchor is sourced, the "
            "width is judgment. ASHRAE's zone-4A target is 1.93 W/m2K and sits "
            "just inside the top of this band -- and it is an ASSEMBLY U-factor, "
            "frame included, where this constant is the GLASS ELEMENT to match "
            "the assembly's own `u_glass`. On an aluminium-framed commercial unit "
            "the frame is the weak point, so the glass behind a 1.93 assembly is "
            "better than 1.93, which is why the band reaches down to 1.3 rather "
            "than sitting on the published figure.\n\n"
            "TODO: verify the band against NFRC-rated whole-window U-factors "
            "for a curtain-wall unit, which would pin the frame contribution "
            "this band currently spans by judgment. The same ComStock table gives "
            "the zone-4A stock BASELINE at 0.81 Btu/h-ft2-F, 4.60 W/m2K, which "
            "falls inside `loads.py`'s 3.0-5.9 for an early aluminium curtain "
            "wall and is the only independent check that table has had. "
            "Compare against the assemblies in `loads.py`, which carry 3.0-5.9 "
            "W/m2K for an early aluminium curtain wall — so this is a two- to four-fold "
            "improvement, and the conduction saving it implies is roughly half "
            "the total benefit of a glazing swap on a high window-to-wall "
            "elevation. The band is the GLASS ELEMENT to match the assembly's "
            "own `u_glass`, which is why it does not reach the 0.8-1.1 a triple "
            "unit would give: a triple-glazed curtain-wall retrofit is a "
            "different measure at a different price and is not what "
            "`capex_usd_m2_glazing_retrofit` was priced for. A thermally broken "
            "frame is assumed and not verified; an unbroken aluminium frame "
            "would sit at the top of this band or above it."
        ),
    ),

    # ---- measure lifetimes
    #
    # Lifetimes matter as much as capex for anything discounted, and the whole
    # block is unverified. ASHRAE Applications Handbook chapter 38 (Owning and
    # Operating Costs) publishes median service lives for HVAC equipment and is
    # the source that would settle the mechanical entries; it is not openly
    # accessible. Envelope lifetimes are bounded above by the building's own
    # capital cycle rather than by the component, which is why several bands top
    # out at 40 years and none goes higher.

    "measure_life_years_external_shading": Constant(
        value=(25.0, 40.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: an aluminium fixed array outlives its "
             "coating and is limited by the facade's capital cycle, not by the "
             "louvres.",
    ),
    "measure_life_years_operable_shading": Constant(
        value=(15.0, 25.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed shorter than fixed shading because the "
             "motors and controls, not the blades, set the life.",
    ),
    "measure_life_years_glazing_retrofit": Constant(
        value=(25.0, 35.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: insulated glass unit seal failure sets the "
             "lower bound, frame life the upper.",
    ),
    "measure_life_years_cool_facade_coating": Constant(
        value=(8.0, 15.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: coatings weather and soil, and a soiled "
             "high-albedo surface loses much of its benefit well before it "
             "visibly fails. The performance life is shorter than the physical "
             "life and this band is meant to be the performance life.",
    ),
    "measure_life_years_exterior_insulation": Constant(
        value=(30.0, 40.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: a permanent fabric alteration, limited by "
             "the building's capital cycle.",
    ),
    "measure_life_years_cool_roof": Constant(
        value=(10.0, 20.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: as for the facade coating, with soiling "
             "worse on a horizontal surface and reflectance loss steepest in the "
             "first three years.",
    ),
    "measure_life_years_green_roof": Constant(
        value=(30.0, 40.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: the waterproofing membrane under the "
             "assembly sets the life, and it is protected by what sits on it.",
    ),
    "measure_life_years_night_purge": Constant(
        value=(10.0, 20.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify against ASHRAE service-life data. Assumed: controls "
             "and actuators, which are replaced on a shorter cycle than the air "
             "system they sit on.",
    ),
    "measure_life_years_heat_pump": Constant(
        value=(15.0, 20.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify against ASHRAE Applications Handbook ch. 38 median "
             "service lives.",
    ),
    "measure_life_years_window_film": Constant(
        value=(8.0, 15.0), unit="years", source="No citable figure found",
        as_of="2026-08-29", verified=False,
        note="TODO: verify. Assumed: manufacturer warranties on commercial "
             "solar-control film commonly run about ten years, and the film is "
             "the shortest-lived item in the catalogue.",
    ),
}


#: The measures this module can price. Kept as an explicit tuple rather than
#: derived from the CONSTANTS keys so that a missing lifetime or a missing capex
#: band fails loudly at import-check time rather than silently pricing a measure
#: at zero.
MEASURE_KEYS: tuple[str, ...] = (
    "external_shading",
    "operable_shading",
    "glazing_retrofit",
    "cool_facade_coating",
    "exterior_insulation",
    "cool_roof",
    "green_roof",
    "night_purge",
    "heat_pump",
    "window_film",
)


#: The measures whose capex band is denominated in GLAZED area rather than in
#: gross facade area, derived from the bands' own ``unit`` strings so the two
#: can never drift apart.
#:
#: This distinction was silently lost for a while and it is worth saying why it
#: matters. ``prescribe.py`` sizes a facade measure by the treated envelope
#: area, which is the right denominator for a louvre, a coating or insulation —
#: those are fitted to the wall. A glazing swap and a film are fitted to the
#: glass, and the trade pricing behind both bands is quoted per square metre of
#: glass. Multiplying a per-glass rate by a whole-facade area overstates the
#: capex by 1/WWR: a third again at the 0.75 window-to-wall ratio of a curtain
#: wall, and nearly three times over on a punched-window elevation at 0.35. On
#: 560 3 Avenue it turned a $2.3M-$7.8M job into a $3.1M-$10.4M one and pushed
#: the simple payback past eight centuries, which is how it surfaced.
CAPEX_ON_GLAZED_AREA: frozenset[str] = frozenset(
    key[len("capex_usd_m2_"):]
    for key, c in CONSTANTS.items()
    if key.startswith("capex_usd_m2_") and "glazed area" in c.unit
)


#: Public programmes a prescription can cite, by measure. These are citations,
#: not numbers, and they carry no cost: the point of naming them is that a
#: measure with a programme behind it has a different lead time and a different
#: politics from one an owner funds alone. Mirrors the register of
#: ``exposure.recommend()``, which already cites these in prose.
PROGRAMMES: dict[str, tuple[str, ...]] = {
    "external_shading": ("NYC Accelerator (free building-performance advice)",),
    "operable_shading": ("NYC Accelerator (free building-performance advice)",),
    "glazing_retrofit": ("NYC Accelerator", "NYSERDA multifamily programmes"),
    "cool_facade_coating": ("NYC Accelerator",),
    "exterior_insulation": ("NYC Accelerator", "NYSERDA multifamily programmes"),
    "cool_roof": (
        "NYC CoolRoofs (free installation for eligible buildings)",
        "Local Law 92/94 sustainable roofing zone requirement on major roof work",
    ),
    "green_roof": (
        "Local Law 92/94 sustainable roofing zone requirement on major roof work",
        "NYS green roof property tax abatement (5.23 USD/sf, 15.00 USD/sf in "
        "priority areas, capped at 200,000 USD)",
    ),
    "night_purge": ("NYC Accelerator",),
    "heat_pump": (
        "NYSERDA / Clean Heat programmes",
        "HEAP Cooling Assistance Component (NY State) for occupant-level cooling",
    ),
    "window_film": ("NYC Accelerator",),
}


#: LL97 occupancy keys accepted by :func:`price`, mapped onto the CONSTANTS key
#: holding that occupancy's cap. Mirrors ``envelope.Occupancy.key``.
#: Heating utilisation by occupancy, keyed exactly as ``_OCCUPANCY_CAPS`` is so
#: the two cannot disagree about what an occupancy key is.
_OCCUPANCY_HEATING_UTILISATION: dict[str, str] = {
    "residential": "heating_utilisation_residential",
    "office": "heating_utilisation_office",
    "retail": "heating_utilisation_retail",
    "other": "heating_utilisation_other",
}


_OCCUPANCY_CAPS: dict[str, str] = {
    "residential": "ll97_cap_kg_co2e_sf_residential",
    "office": "ll97_cap_kg_co2e_sf_office",
    "retail": "ll97_cap_kg_co2e_sf_retail",
    "other": "ll97_cap_kg_co2e_sf_other",
}


# ------------------------------------------------------- interval arithmetic
#
# Small, explicit, and local rather than pulled from a library, because the
# whole point of the range discipline is that a reader can check it. Four
# functions, each two lines, each doing exactly what interval arithmetic says.


def _pair(x: float | tuple[float, float] | list) -> tuple[float, float]:
    """Coerce a scalar or a two-element sequence to an ordered interval."""
    if isinstance(x, (tuple, list)):
        lo, hi = float(x[0]), float(x[1])
        return (lo, hi) if lo <= hi else (hi, lo)
    v = float(x)
    return (v, v)


def _mul(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    """Interval product, over all four endpoint combinations.

    The naive ``(a0*b0, a1*b1)`` is wrong the moment either interval straddles
    zero, which happens here whenever a measure's annual energy saving is
    negative at one end of its range and positive at the other — precisely the
    shading-with-a-winter-penalty case the module exists to represent honestly.
    """
    c = (a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1])
    return (min(c), max(c))


def _add(*terms: tuple[float, float]) -> tuple[float, float]:
    """Interval sum."""
    return (sum(t[0] for t in terms), sum(t[1] for t in terms))


def _sub(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    """Interval difference. Note the crossed endpoints: the worst case for
    ``a - b`` is the lowest ``a`` against the highest ``b``."""
    return (a[0] - b[1], a[1] - b[0])


def _annuity_factor(rate: float, years: float) -> float:
    """Present value of one unit received at the end of each of ``years`` years.

    Written out rather than imported so the discounting convention is visible:
    end-of-period, no escalation on the saving, no residual value at the end of
    the measure's life. Escalating the energy saving with a forecast tariff would
    be a second unsourced assumption stacked on an already unverified rate, and
    it would flatter every measure.
    """
    if years <= 0:
        return 0.0
    if abs(rate) < 1e-12:
        return float(years)
    return (1.0 - (1.0 + rate) ** (-years)) / rate


# ------------------------------------------------------------------- the money


@dataclass
class Money:
    """What a measure costs and what it returns, every figure a range.

    ``ll97_usd_yr`` is a penalty *avoided*, and it is an upper bound: it assumes
    the building is over its cap, which most currently are not, and it prices
    against a statutory maximum that the good-faith-effort pathways can mitigate.
    The interface must never present it as revenue.
    """

    energy_usd_yr: tuple[float, float]
    demand_usd_yr: tuple[float, float]
    carbon_t_yr: tuple[float, float]
    ll97_usd_yr: tuple[float, float]
    capex_usd: tuple[float, float]
    payback_yr: tuple[float, float] | None
    npv_usd: tuple[float, float]
    basis: str

    #: The heating-season COST of a solar-control measure, positive, already
    #: subtracted from ``annual_saving_usd``. Its own line because a measure
    #: whose January outweighs its July is a finding, and folding it into a net
    #: figure is how that finding disappears.
    winter_usd_yr: tuple[float, float] = (0.0, 0.0)

    #: The heating-season BENEFIT of a fabric measure, positive, already added to
    #: ``annual_saving_usd``. The opposite of the line above and kept apart from
    #: it for the same reason: one measure family pays in winter and another is
    #: charged for it, and a single net column would let a reader believe the two
    #: were the same quantity with a sign.
    heating_usd_yr: tuple[float, float] = (0.0, 0.0)

    #: Everything above, restated so the caller can show the arithmetic.
    annual_saving_usd: tuple[float, float] = (0.0, 0.0)
    measure_life_years: tuple[float, float] = (0.0, 0.0)
    discount_rate: tuple[float, float] = (0.0, 0.0)
    ll97_cap_kg_co2e_sf: float | None = None
    programme: tuple[str, ...] = ()
    constants_used: tuple[str, ...] = ()
    unverified_used: tuple[str, ...] = ()


def price(
    *,
    measure_key: str,
    area_m2: float,
    kwh_saved_yr: float | tuple[float, float],
    kw_peak_saved: float | tuple[float, float],
    occupancy: str | object,
    gross_floor_m2: float | None = None,
    glazed_m2: float | None = None,
    winter_kwh_thermal: float | tuple[float, float] | None = None,
    heating_kwh_saved: float | tuple[float, float] | None = None,
) -> Money:
    """Put a price on one measure on one building.

    ``kwh_saved_yr`` and ``kw_peak_saved`` come from ``prescribe.Effect``, which
    gets them from a re-solve rather than from a coefficient. They are THERMAL
    quantities — a cooling load, the heat a plant has to move — and they are
    divided by ``cooling_cop`` here to get the electricity that is actually
    billed. That division is the one piece of physics this function does, and it
    is here because it was missing everywhere: for as long as this table has
    existed it priced a thermal kilowatt-hour at an electrical tariff, which
    overstated every saving by the whole coefficient of performance. Ranges are
    taken as given otherwise. A negative
    ``kwh_saved_yr`` — a measure whose winter heating penalty outweighs its
    summer benefit — is a legitimate input and is priced as a loss rather than
    clamped to zero.

    The saving has three components and they are kept apart all the way through,
    because they are owed to different parties and they are not equally certain:
    the energy saving is the owner's, the demand saving is the owner's and is
    usually larger, and the LL97 penalty avoided is a liability that exists only
    if the building is over its cap. ``Money`` carries all three so the interface
    can show which one is carrying the case.

    ``occupancy`` accepts either an ``envelope.Occupancy`` (anything with a
    ``.key``) or the bare key string, so this module can be imported and used
    without ``envelope.py`` being present. That is deliberate: the constants
    table is useful on its own and should not be held hostage to the rest of the
    decision layer building.

    ``area_m2`` is the treated envelope area and is the denominator for every
    band except the two in ``CAPEX_ON_GLAZED_AREA``, which are quoted per square
    metre of glass and take ``glazed_m2`` instead. Passing ``glazed_m2`` for a
    measure priced on facade area is harmless — it is ignored. Omitting it for
    one priced on glass is not harmless, so the fallback to ``area_m2`` says so
    in ``basis`` rather than quietly overstating the job by 1/WWR; a caller that
    has the glazed area and does not pass it will see the caveat in the brief.
    """
    if measure_key not in MEASURE_KEYS:
        raise KeyError(
            f"unknown measure {measure_key!r}; economics.py prices only "
            f"{', '.join(MEASURE_KEYS)}"
        )

    occ_key = getattr(occupancy, "key", occupancy)
    if occ_key not in _OCCUPANCY_CAPS:
        occ_key = "other"

    used: list[str] = []

    def take(key: str) -> tuple[float, float]:
        used.append(key)
        return CONSTANTS[key].pair

    # THERMAL IN, ELECTRICAL OUT. See `cooling_cop`.
    #
    # Everything this function is handed by `prescribe.Effect` is a cooling LOAD
    # -- heat the plant has to move -- and everything below prices ELECTRICITY.
    # The division is here rather than in the caller because this is the module
    # whose job is that no conversion constant lives as a literal, and because
    # three callers reach `price` and only one arrangement stops them each
    # dividing by a different number.
    #
    # Crossed endpoints, deliberately: a HIGH coefficient of performance means
    # LESS electricity for the same heat and therefore a SMALLER saving, so the
    # pessimistic corner is the low thermal figure over the high COP. Writing
    # this the obvious way round would narrow every band by pairing each
    # extreme with its own favourable partner.
    cop = take("cooling_cop")
    th_kwh = _pair(kwh_saved_yr)
    th_kw = _pair(kw_peak_saved)
    kwh = (th_kwh[0] / cop[1], th_kwh[1] / cop[0])
    kw = (th_kw[0] / cop[1], th_kw[1] / cop[0])
    area = _pair(area_m2)

    energy = _mul(kwh, take("electricity_usd_kwh"))

    # Demand is priced only on the summer months the tariff charges the summer
    # rate for. Multiplying by twelve would roughly triple the apparent benefit
    # of every peak-shaving measure in the catalogue.
    demand = _mul(_mul(kw, take("demand_usd_kw_month")),
                  take("demand_months_billed_yr"))

    carbon_kg = _mul(kwh, take("grid_kg_co2e_kwh"))
    carbon_t = (carbon_kg[0] / 1000.0, carbon_kg[1] / 1000.0)

    ll97_t = _mul(kwh, take("ll97_coefficient_kg_co2e_kwh"))
    ll97 = _mul((ll97_t[0] / 1000.0, ll97_t[1] / 1000.0),
                take("ll97_penalty_usd_tco2e"))

    cap_key = _OCCUPANCY_CAPS[occ_key]
    used.append(cap_key)
    cap = float(CONSTANTS[cap_key].pair[0])

    # The denominator the band is actually quoted in. See CAPEX_ON_GLAZED_AREA.
    capex_area, capex_area_note = area, ""
    if measure_key in CAPEX_ON_GLAZED_AREA:
        if glazed_m2 is not None and float(glazed_m2) > 0.0:
            capex_area = _pair(float(glazed_m2))
        else:
            capex_area_note = (
                "; capex priced on gross facade area because no glazed area was "
                "supplied, and this band is quoted per square metre of glass, so "
                "the capital cost is an over-estimate by one over the "
                "window-to-wall ratio"
            )
    capex = _mul(capex_area, take(f"capex_usd_m2_{measure_key}"))
    life = take(f"measure_life_years_{measure_key}")
    rate = take("discount_rate")

    # The heating-season penalty, netted OFF the saving and reported separately.
    #
    # A solar-control measure rejects January's beam as efficiently as July's,
    # and on a heating-dominated elevation that can outweigh the summer benefit
    # outright. Reporting only a net figure would hide the one fact a reader
    # needs; reporting only the summer side, which is what this did before,
    # produced a saving no owner would actually see. The pessimistic corner
    # pairs the largest heat loss with the dearest heat.
    winter = (0.0, 0.0)
    if winter_kwh_thermal is not None:
        wk = _pair(winter_kwh_thermal)
        heat = take("heating_usd_kwh_thermal")
        # Not all of the rejected sun was wanted. See the constant.
        util = take(_OCCUPANCY_HEATING_UTILISATION[occ_key])
        winter = (abs(wk[0]) * heat[0] * util[0],
                  abs(wk[1]) * heat[1] * util[1])

    # STRAIGHT SUBTRACTION, NOT `_sub`, AND THE REASON IS CORRELATION.
    #
    # `_sub` crosses its endpoints — lowest `a` against highest `b` — which is
    # right whenever the two intervals move independently, and it is how `npv`
    # below subtracts a capex band from a saving band. It is WRONG here. Both
    # halves of this expression are driven by the SAME transmitted-solar figure
    # at the SAME corner of the assembly table: index 0 of the summer saving and
    # index 0 of the winter penalty are both the low-SHGC, low-U reading. A
    # crossed pairing therefore prices the smallest summer benefit against the
    # largest winter cost, which is the low corner of the assembly and the high
    # corner of the same assembly at once, and no building is both.
    #
    # It is not a small difference. On the worked case at 560 3 Avenue the
    # crossed form gave -41,340 USD/yr and reported that a glazing swap never
    # pays back; per corner it gives +22,853 to +185,451 and a payback of twelve
    # to three hundred and forty years. The first of those is not a pessimistic
    # reading, it is an arithmetically impossible one, and it had every glazing
    # measure in the build saying "never" for a reason that was in this line.
    #
    # The tariff constants still cross, and should: heat price and electricity
    # price are independent of the envelope and of each other, so each corner
    # already carries its own worst tariff.
    # The heating-season BENEFIT of a fabric measure: heat the plant no longer
    # has to make good. No utilisation factor, unlike the solar penalty above --
    # that factor exists because rejected sun may be heat the building did not
    # want, and a conduction loss the fabric stops was unambiguously heat it was
    # paying for. Its carbon is not netted for the same reason the penalty's is
    # not: no fuel-combustion coefficient is in this table.
    heating = (0.0, 0.0)
    if heating_kwh_saved is not None:
        hk = _pair(heating_kwh_saved)
        heat = take("heating_usd_kwh_thermal")
        heating = (abs(hk[0]) * heat[0], abs(hk[1]) * heat[1])

    summer = _add(energy, demand, ll97, heating)
    _net = (summer[0] - winter[0], summer[1] - winter[1])
    # ORDERED, like every other interval this module builds -- `_mul` ends on
    # `(min(c), max(c))` for the same reason. Subtracting per corner does NOT
    # preserve ordering: where the winter penalty grows faster between the two
    # corners than the summer benefit does, the high corner's net comes out
    # BELOW the low corner's and the interval inverts. An inverted interval then
    # divides into `capex[0] / saving[1]` and produces a NEGATIVE payback, which
    # is what a glazing measure on one of 560 3 Avenue's smaller elevations
    # reported: -114 to 1,715 years. A payback cannot be negative; the pair was
    # simply the wrong way round.
    saving = (min(_net), max(_net))

    # Payback is None unless the measure pays back at BOTH ends of its range.
    # The alternative — reporting the optimistic end and letting the pessimistic
    # end run to infinity — would put a small, confident-looking number next to a
    # measure that may never pay for itself, which is the specific failure this
    # module is built to avoid.
    payback: tuple[float, float] | None = None
    if saving[0] > 0.0:
        payback = (capex[0] / saving[1], capex[1] / saving[0])

    # The annuity factor is decreasing in the rate and increasing in the life,
    # so the pessimistic factor pairs the high rate with the short life.
    af = (_annuity_factor(rate[1], life[0]), _annuity_factor(rate[0], life[1]))
    npv = _sub(_mul(saving, af), capex)

    oldest = min(CONSTANTS[k].as_of for k in used)
    unverified = tuple(sorted({k for k in used if not CONSTANTS[k].verified}))
    basis = (
        f"assumed: priced from the economics constants table; "
        f"oldest constant as of {oldest}; "
        f"{len(unverified)} of {len(set(used))} constants used are unverified"
        f"{capex_area_note}"
    )

    return Money(
        energy_usd_yr=energy,
        demand_usd_yr=demand,
        carbon_t_yr=carbon_t,
        ll97_usd_yr=ll97,
        winter_usd_yr=winter,
        heating_usd_yr=heating,
        capex_usd=capex,
        payback_yr=payback,
        npv_usd=npv,
        basis=basis,
        annual_saving_usd=saving,
        measure_life_years=life,
        discount_rate=rate,
        ll97_cap_kg_co2e_sf=cap,
        programme=PROGRAMMES.get(measure_key, ()),
        constants_used=tuple(sorted(set(used))),
        unverified_used=unverified,
    )


# ------------------------------------------------------------------ the table


def constants_table() -> list[dict]:
    """The whole table as plain dicts, for the interface and for ``validate``.

    Every row carries ``verified``, so a caller can count the unverified ones
    without knowing anything about this module — which is what
    ``scripts/validate.py`` does, printing the count as an explicitly unvalidated
    item in the same way it already prints the year's unvalidated
    bias-correction seasonality.

    ``value`` is emitted as a float or a two-element list rather than a tuple so
    the result is JSON-serialisable as it stands, and ``lo``/``hi`` are repeated
    alongside so a template can render a range without type-switching.
    """
    rows: list[dict] = []
    for key in sorted(CONSTANTS):
        c = CONSTANTS[key]
        lo, hi = c.pair
        rows.append({
            "key": key,
            "value": [lo, hi] if isinstance(c.value, tuple) else float(c.value),
            "lo": lo,
            "hi": hi,
            "is_range": isinstance(c.value, tuple),
            "unit": c.unit,
            "source": c.source,
            "as_of": c.as_of,
            "verified": bool(c.verified),
            "note": c.note,
        })
    return rows


def unverified_count() -> int:
    """How many constants are not yet sourced. Printed by ``validate``."""
    return sum(1 for c in CONSTANTS.values() if not c.verified)


def as_of() -> str:
    """The oldest ``as_of`` in the table: the date the whole table is only as
    fresh as. Shown in the interface beside any dollar figure."""
    return min(c.as_of for c in CONSTANTS.values())
