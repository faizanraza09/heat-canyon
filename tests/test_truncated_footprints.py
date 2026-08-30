"""The gate that tells a truncated footprint from a neighbour's flank returns.

`refine_dsm` clamps every upward disagreement between the LiDAR and the
footprint table to the table, and for almost every building that is right: a
tower's flank returns land, in plan, inside its low neighbour's polygon, which
is what once made a 1924 brownstone read 106 m. The clamp removes that whole
class of error in one line.

It also removes something real. Where a footprint is joined to the
infrastructure lot beneath it — Midtown has a run of these over the Grand
Central and Penn rail yards — the city records a height for the podium, and the
table is simply short of the building. The MetLife Building is carried at 47.9 m
against an actual 246 m, so two hundred metres of facade is never solved and
never coloured, which reads on screen as the data layer having failed on that
tower rather than as the city record being wrong.

`interior` separates the two, and these tests are what say so. Bleed arrives at
the footprint *edge*, where a neighbour overhangs; a truncated footprint stands
above the table across its whole area. Measured on the real AOI:

    MetLife           45.6% of interior cells above table + tol
    450 Lexington     89.4%
    230 Park Avenue    2.2%   (correct height, tower next door)
    Grand Central      1.9%   (correct height, towers all around)

A twenty-fold separation, so the threshold is not delicate. The two tests below
are that measurement in miniature, one case each way.
"""

import numpy as np
import pytest

from heatcanyon import geometry as G
from heatcanyon import lidar


def _scene(lidar_top_for):
    """A 24x24 grid holding two 8x8 buildings, and the Surface over it.

    `lidar_top_for(bid, i, j, interior)` returns the cloud's highest hit for one
    cell, so each test can describe the *shape* of the disagreement it is about
    rather than restating the whole grid.
    """
    ny = nx = 24
    bid = np.full((ny, nx), -1, dtype=np.int32)
    bid[2:10, 2:10] = 0        # the tall one
    bid[14:22, 2:10] = 1       # its low neighbour

    buildings = [
        {"bin": "TALL", "base_m": 0.0, "height_m": 48.0, "year": 1963},
        {"bin": "LOW", "base_m": 0.0, "height_m": 20.0, "year": 1924},
    ]
    flat = np.zeros((ny, nx), dtype=np.float32)
    for i in range(ny):
        for j in range(nx):
            if bid[i, j] >= 0:
                flat[i, j] = buildings[bid[i, j]]["height_m"]

    top = np.full((ny, nx), np.nan, dtype=np.float32)
    count = np.zeros((ny, nx), dtype=np.int32)
    for i in range(ny):
        for j in range(nx):
            b = bid[i, j]
            if b < 0:
                continue
            interior = all(
                0 <= i + dy < ny and 0 <= j + dx < nx and bid[i + dy, j + dx] == b
                for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            )
            top[i, j] = lidar_top_for(b, i, j, interior)
            count[i, j] = 12          # comfortably past min_returns per building

    dsm = G.DSM(height=flat, building_id=bid, res=3.0, x0=0.0, y0=0.0)
    surf = lidar.Surface(top=top, ground=np.zeros((ny, nx), dtype=np.float32),
                         count=count, res=3.0, x0=0.0, y0=0.0,
                         n_points=int(count.sum()), n_nodes=1)
    return dsm, surf, buildings


def test_a_truncated_footprint_is_repaired_from_the_cloud():
    """The MetLife case: the cloud stands above the table across the whole plan."""
    def top(b, i, j, interior):
        return 250.0 if b == 0 else 20.0

    dsm, surf, buildings = _scene(top)
    _, report = lidar.refine_dsm(dsm, surf, buildings, log=lambda *a: None)

    assert report.n_truncation_repaired == 1
    repair = report.truncation_repairs[0]
    assert repair["bin"] == "TALL"
    assert repair["was_m"] == pytest.approx(48.0, abs=0.5)
    # Raised to the cloud's own 98th percentile, not to some invented figure.
    assert repair["now_m"] == pytest.approx(250.0, abs=2.0)

    # And written back to the record, because facade panels, floor counts and
    # every per-building score read `height_m` rather than the raster. A taller
    # lid with a short record beside it would leave the geometry and the physics
    # disagreeing about the same building.
    assert buildings[0]["height_m"] == pytest.approx(250.0, abs=2.0)
    assert buildings[0]["top_m"] == pytest.approx(250.0, abs=2.0)
    assert buildings[0]["height_src"] == "lidar_truncation_repair"
    # The neighbour is untouched.
    assert buildings[1]["height_m"] == pytest.approx(20.0)


def test_a_neighbours_flank_returns_do_not_raise_a_low_building():
    """The brownstone case: the disagreement is confined to the footprint edge.

    This is the one the clamp exists for, and the one a naive
    `max(table, lidar)` would get wrong — which is exactly why the gate counts
    interior cells rather than all of them.
    """
    def top(b, i, j, interior):
        if b == 0:
            return 48.0
        # The low building reads its true height everywhere except its rim,
        # where the tall neighbour's flank returns land.
        return 20.0 if interior else 200.0

    dsm, surf, buildings = _scene(top)
    _, report = lidar.refine_dsm(dsm, surf, buildings, log=lambda *a: None)

    assert report.n_truncation_repaired == 0
    assert buildings[1]["height_m"] == pytest.approx(20.0)
    assert "height_src" not in buildings[1]


def test_the_threshold_sits_well_clear_of_both_measured_populations():
    """The real separation is 2% against 46%, so the default must sit between.

    Pinned because the default is the only thing standing between "repairs
    MetLife" and "repairs every building beside a tower", and a later tweak to
    it should have to argue with this test first.
    """
    import inspect
    default = inspect.signature(lidar.refine_dsm).parameters["truncated_frac"].default
    assert 0.05 < default < 0.40


def test_a_height_pluto_can_vouch_for_is_never_rewritten():
    """The condition that separates a repair from a wrecking ball.

    Learned expensively. Without it the gate fired on 864 of 5,329 footprints,
    and checked against PLUTO's own floor count — an independent record the
    point cloud knows nothing about — the *old* height was closer to
    `floors x 3.2 m` in 88% of the cases PLUTO could adjudicate. Worse for
    bigger repairs, not better: 92% at 40 m and above. The gate was confidently
    rewriting buildings that were already right.

    What PLUTO can adjudicate is the whole point. A BBL carrying a floor count
    is one whose join to the tax lot worked, and a working join is itself
    evidence that `height_roof` describes this building. The truncated ones are
    the opposite case by construction — joined to the viaduct or rail yard
    underneath, which has no floors. MetLife and 450 Lexington both report
    `floors = None` for exactly that reason.
    """
    def top(b, i, j, interior):
        return 250.0 if b == 0 else 20.0

    dsm, surf, buildings = _scene(top)
    # Identical LiDAR evidence to the repair test above — but this time the
    # city has a floor count for the tall one, so the table height stands.
    _, report = lidar.refine_dsm(dsm, surf, buildings,
                                 height_trusted=[True, True],
                                 log=lambda *a: None)

    assert report.n_truncation_repaired == 0
    assert buildings[0]["height_m"] == pytest.approx(48.0)


def test_a_parapet_sized_disagreement_is_not_a_truncation():
    """Rooftop plant clears the tolerance; it is not a missing two hundred metres.

    The first run repaired 251 buildings by 6-12 m — water tanks, stair
    bulkheads, parapets. Their interiors really do read above the table height,
    so the interior test alone passes them, but adding 6 m to a 22 m building is
    a 27% height error that changes its facade area and its physics.
    """
    def top(b, i, j, interior):
        # The tall one stands 8 m over its table height across the whole roof:
        # real structure, far too small to be a truncated footprint.
        return 48.0 + 8.0 if b == 0 else 20.0

    dsm, surf, buildings = _scene(top)
    _, report = lidar.refine_dsm(dsm, surf, buildings,
                                 height_trusted=[False, False],
                                 log=lambda *a: None)

    assert report.n_truncation_repaired == 0
    assert buildings[0]["height_m"] == pytest.approx(48.0)
