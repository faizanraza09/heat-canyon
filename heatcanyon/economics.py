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
# of them came from a primary cost database; RSMeans and the NYSERDA programme
# cost data are the two sources that would settle them, and neither is openly
# accessible. Everything below them is trade-press or contractor pricing, mostly
# national rather than New York, which understates New York labour.


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
) -> Money:
    """Put a price on one measure on one building.

    ``kwh_saved_yr`` and ``kw_peak_saved`` come from ``prescribe.Effect``, which
    gets them from a re-solve rather than from a coefficient; this function adds
    no physics and takes them as given, including their ranges. A negative
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

    kwh = _pair(kwh_saved_yr)
    kw = _pair(kw_peak_saved)
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

    saving = _add(energy, demand, ll97)

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
