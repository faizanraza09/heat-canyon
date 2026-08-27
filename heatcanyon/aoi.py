"""Study-area definitions for the Manhattan canyon-heat build.

One AOI is the unit of everything downstream: the FortyGuard heatmap request,
the NYC footprint query, and the canyon graph. Keeping them in one module means
the polygon that was billed is provably the polygon that was rendered.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Metres per degree at Manhattan's latitude — used everywhere we need a cheap
# local planar approximation instead of a full projection.
LAT0 = 40.7550
M_PER_DEG_LAT = 111_132.0
M_PER_DEG_LON = 84_400.0  # cos(40.755°) * 111_320


@dataclass(frozen=True)
class AOI:
    """A rectangular study area, in WGS84 degrees."""

    key: str
    label: str
    west: float
    south: float
    east: float
    north: float
    notes: str = ""

    # ------------------------------------------------------------------ shape
    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.west, self.south, self.east, self.north)

    @property
    def center(self) -> tuple[float, float]:
        return ((self.west + self.east) / 2.0, (self.south + self.north) / 2.0)

    @property
    def ring(self) -> list[list[float]]:
        """Closed counter-clockwise ring, GeoJSON [lon, lat] order."""
        return [
            [self.west, self.south],
            [self.east, self.south],
            [self.east, self.north],
            [self.west, self.north],
            [self.west, self.south],
        ]

    def polygon_aoi(self) -> dict:
        """The exact FeatureCollection the FortyGuard heatmap endpoint wants."""
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"key": self.key, "label": self.label},
                    "geometry": {"type": "Polygon", "coordinates": [self.ring]},
                }
            ],
        }

    def wkt(self) -> str:
        """WKT POLYGON — the form Socrata's within_polygon() expects."""
        pts = ", ".join(f"{lon} {lat}" for lon, lat in self.ring)
        return f"POLYGON(({pts}))"

    # ------------------------------------------------------------------ size
    @property
    def width_m(self) -> float:
        return (self.east - self.west) * M_PER_DEG_LON

    @property
    def height_m(self) -> float:
        return (self.north - self.south) * M_PER_DEG_LAT

    @property
    def area_km2(self) -> float:
        return self.width_m * self.height_m / 1e6

    @property
    def area_mi2(self) -> float:
        return self.area_km2 / 2.58999

    def tile_count(self, granularity_m: int) -> int:
        """Rough tile count at a given granularity — our pre-flight credit check."""
        return int(self.width_m / granularity_m) * int(self.height_m / granularity_m)

    def describe(self) -> str:
        return (
            f"{self.label} [{self.key}]\n"
            f"  bbox    {self.west:.4f}, {self.south:.4f} -> {self.east:.4f}, {self.north:.4f}\n"
            f"  extent  {self.width_m:,.0f} m x {self.height_m:,.0f} m\n"
            f"  area    {self.area_km2:.2f} km^2 ({self.area_mi2:.2f} mi^2)\n"
            f"  tiles   ~{self.tile_count(100):,} at 100 m / ~{self.tile_count(60):,} at 60 m"
        )


# --------------------------------------------------------------------- catalog

#: Primary study area. Midtown Manhattan, roughly W 30th to W 54th and
#: 2nd Ave to 9th Ave. Chosen because it packs the widest height contrast in
#: the city into one AOI — Empire State, Chrysler, Rockefeller and Hudson Yards
#: towers sitting directly against five-storey walk-ups — which is exactly the
#: asymmetric-canyon geometry the physics engine is built to resolve. Also
#: comfortably inside the 10 mi^2 heatmap cap.
MIDTOWN = AOI(
    key="midtown",
    label="Midtown Manhattan",
    west=-73.9950,
    south=40.7440,
    east=-73.9700,
    north=40.7640,
    notes="Empire State / Bryant Park / Grand Central / Rockefeller. Extreme height contrast.",
)

#: Secondary: the Financial District, where Manhattan's narrowest and deepest
#: canyons are (Wall, Broad, Nassau — pre-grid streets under 12 m wide with
#: 150 m towers, H/W well past 10). Kept as a second target because the
#: symmetric-deep-canyon regime is physically different from Midtown's.
FIDI = AOI(
    key="fidi",
    label="Financial District",
    west=-74.0150,
    south=40.7020,
    east=-74.0020,
    north=40.7130,
    notes="Pre-grid street pattern. Narrowest, deepest canyons in North America.",
)

CATALOG: dict[str, AOI] = {a.key: a for a in (MIDTOWN, FIDI)}
DEFAULT = MIDTOWN


def get(key: str = "midtown") -> AOI:
    if key not in CATALOG:
        raise KeyError(f"Unknown AOI {key!r}. Known: {sorted(CATALOG)}")
    return CATALOG[key]


if __name__ == "__main__":
    for a in CATALOG.values():
        print(a.describe())
        print()
