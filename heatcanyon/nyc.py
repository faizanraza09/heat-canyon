"""Free public-data ingest: NYC Open Data, OpenStreetMap, and validation layers.

Every source here is key-free and cached to disk. Field names were verified
against live responses — the Socrata API uses underscored column names that
differ from the shapefile names most documentation quotes, so the constants
below are the authority:

  footprints  5zhs-2jue   height_roof, ground_elevation  (FEET, not metres)
  centerline  inkn-q76z   streetwidth (FEET) — a real measured canyon width
  pluto       64uk-42ks   yearbuilt, numfloors, unitsres, bldgclass
  hvi         4mhf-duep   keyed by ZCTA (zcta20), scored 1-5 as quintiles
  modzcta     pri4-ifjk   geometry for the HVI join
  trees       uvpi-gqnh   2015 street-tree census
  sensors     qdq3-9eqn   street-level air temperature, 2018/19, deg F

The two traps this module handles explicitly: Socrata returns every numeric
column as a JSON *string*, and BBL is text in the footprint layer but a float
in PLUTO, so the join needs a normalised 10-character key.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from . import aoi as aoi_mod

CACHE = Path("data/nyc")
SOCRATA = "https://data.cityofnewyork.us/resource"
UA = "heatcanyon/1.0 (urban heat research; hackathon project)"

DATASETS = {
    "footprints": "5zhs-2jue",
    "centerline": "inkn-q76z",
    "pluto": "64uk-42ks",
    "hvi": "4mhf-duep",
    "modzcta": "pri4-ifjk",
    "trees": "uvpi-gqnh",
    "sensors": "qdq3-9eqn",
    "roadbed": "i36f-5ih7",
    "nta2020": "9nt8-h7nd",
}


# ----------------------------------------------------------------- transport


def _get(url: str, tries: int = 4, timeout: float = 180.0) -> bytes:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001 — retry any transport failure
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed after {tries} tries: {url[:200]}\n  {last}")


def socrata(
    dataset: str,
    fmt: str = "json",
    cache_key: str | None = None,
    refresh: bool = False,
    **params: Any,
) -> Any:
    """Query a Socrata dataset with SoQL params, caching the response to disk."""
    ds = DATASETS.get(dataset, dataset)
    qs = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    url = f"{SOCRATA}/{ds}.{fmt}?{qs}"

    key = cache_key or f"{dataset}_{abs(hash(qs)) % (10**10)}"
    path = CACHE / f"{key}.{fmt}"
    if path.exists() and not refresh:
        return json.loads(path.read_text())

    CACHE.mkdir(parents=True, exist_ok=True)
    body = _get(url)
    data = json.loads(body)
    path.write_text(json.dumps(data))
    return data


# -------------------------------------------------------------------- casting


def num(value: Any, default: float | None = None) -> float | None:
    """Socrata hands back numbers as strings. Cast defensively."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def bbl_key(value: Any) -> str | None:
    """Normalise a BBL to a 10-character string.

    The footprint layer stores BBL as text ("1020660059") while PLUTO stores it
    as a float ("1020660059.00000000"). Without this both joins silently return
    nothing.
    """
    if value in (None, ""):
        return None
    try:
        return str(int(float(value))).zfill(10)
    except (TypeError, ValueError):
        return None


FT_TO_M = 0.3048


# ----------------------------------------------------------------- footprints


def footprints(area: aoi_mod.AOI, refresh: bool = False, pad_deg: float = 0.0015) -> list[dict]:
    """Building footprints intersecting the AOI, heights converted to metres.

    Padded slightly beyond the AOI so buildings that form the far wall of a
    boundary street are present — a canyon needs both sides to be a canyon.

    Returns a list of dicts with a GeoJSON polygon ring plus:
      bin, bbl, base_m (ground elevation), height_m (roof above ground),
      top_m (base + height), year, feature_code
    """
    padded = aoi_mod.AOI(
        key=area.key, label=area.label,
        west=area.west - pad_deg, south=area.south - pad_deg,
        east=area.east + pad_deg, north=area.north + pad_deg,
    )
    raw = socrata(
        "footprints", fmt="geojson", cache_key=f"footprints_{area.key}", refresh=refresh,
        **{
            "$where": f"intersects(the_geom, '{padded.wkt()}')",
            "$limit": "60000",
            "$select": "the_geom,bin,base_bbl,mappluto_bbl,height_roof,"
                       "ground_elevation,construction_year,feature_code,name",
        },
    )
    out: list[dict] = []
    for feat in raw.get("features", []):
        p = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        rings = _outer_rings(geom)
        if not rings:
            continue
        h_ft = num(p.get("height_roof"))
        g_ft = num(p.get("ground_elevation"), 0.0)
        if h_ft is None or h_ft <= 0:
            continue  # 0.2% of Manhattan rows have no height; they'd render flat
        for ring in rings:
            out.append(
                {
                    "bin": p.get("bin"),
                    "bbl": bbl_key(p.get("base_bbl") or p.get("mappluto_bbl")),
                    "name": p.get("name"),
                    "base_m": round((g_ft or 0.0) * FT_TO_M, 2),
                    "height_m": round(h_ft * FT_TO_M, 2),
                    "top_m": round(((g_ft or 0.0) + h_ft) * FT_TO_M, 2),
                    "year": int(num(p.get("construction_year"), 0) or 0) or None,
                    "feature_code": int(num(p.get("feature_code"), 0) or 0),
                    "ring": ring,
                }
            )
    return out


def _outer_rings(geom: dict) -> list[list[list[float]]]:
    """Pull outer rings out of Polygon / MultiPolygon, dropping holes."""
    t = geom.get("type")
    coords = geom.get("coordinates") or []
    if t == "Polygon":
        return [coords[0]] if coords else []
    if t == "MultiPolygon":
        return [poly[0] for poly in coords if poly]
    return []


# ----------------------------------------------------------------- centerline


def centerlines(area: aoi_mod.AOI, refresh: bool = False, pad_deg: float = 0.0015) -> list[dict]:
    """Street centre lines with measured curb-to-curb width in metres.

    ``streetwidth`` is the single most valuable free field in this whole
    project: it makes the canyon aspect ratio H/W a measured quantity rather
    than a guess. Coverage is 83% of Manhattan segments; zero-width rows are
    dropped rather than imputed.
    """
    padded = aoi_mod.AOI(
        key=area.key, label=area.label,
        west=area.west - pad_deg, south=area.south - pad_deg,
        east=area.east + pad_deg, north=area.north + pad_deg,
    )
    raw = socrata(
        "centerline", fmt="geojson", cache_key=f"centerline_{area.key}", refresh=refresh,
        **{
            # No $select: the .json and .geojson endpoints expose different
            # column sets for this dataset, and naming a column absent from one
            # of them 400s the whole query.
            "$where": f"intersects(the_geom, '{padded.wkt()}') AND boroughcode='1'",
            "$limit": "20000",
        },
    )
    out: list[dict] = []
    for feat in raw.get("features", []):
        p = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        lines = _lines(geom)
        w_ft = num(p.get("streetwidth"))
        rw = p.get("rw_type")
        for line in lines:
            if len(line) < 2:
                continue
            out.append(
                {
                    "id": p.get("physicalid"),
                    "name": (p.get("full_street_name") or p.get("stname_label") or p.get("street_name") or "").strip(),
                    "width_m": round(w_ft * FT_TO_M, 2) if w_ft and w_ft > 0 else None,
                    "width_ft": w_ft if w_ft and w_ft > 0 else None,
                    "lanes": num(p.get("number_total_lanes")),
                    "travel_lanes": num(p.get("number_travel_lanes")),
                    "park_lanes": num(p.get("number_park_lanes")),
                    "rw_type": int(num(rw, 0) or 0),
                    "trafdir": p.get("trafdir"),
                    "bike_lane": p.get("bike_lane"),
                    "line": line,
                }
            )
    return out


def _lines(geom: dict) -> list[list[list[float]]]:
    t = geom.get("type")
    coords = geom.get("coordinates") or []
    if t == "LineString":
        return [coords]
    if t == "MultiLineString":
        return list(coords)
    return []


# ---------------------------------------------------------------------- PLUTO


def pluto(area: aoi_mod.AOI, refresh: bool = False, pad_deg: float = 0.002) -> dict[str, dict]:
    """Tax-lot attributes keyed by normalised BBL.

    Filtered by the lot centroid's lat/lon rather than by geometry, because the
    Socrata PLUTO table's geometry column is unusable (declared text, silently
    dropped from $select).
    """
    w, s = area.west - pad_deg, area.south - pad_deg
    e, n = area.east + pad_deg, area.north + pad_deg
    rows = socrata(
        "pluto", fmt="json", cache_key=f"pluto_{area.key}", refresh=refresh,
        **{
            "$where": (
                f"borough='MN' AND latitude > {s} AND latitude < {n} "
                f"AND longitude > {w} AND longitude < {e}"
            ),
            "$limit": "60000",
            "$select": "bbl,address,yearbuilt,yearalter1,numfloors,numbldgs,bldgclass,"
                       "landuse,unitsres,unitstotal,bldgarea,resarea,comarea,lotarea,"
                       "assesstot,ownername,zipcode,latitude,longitude,builtfar,cd",
        },
    )
    out: dict[str, dict] = {}
    for r in rows:
        key = bbl_key(r.get("bbl"))
        if not key:
            continue
        out[key] = {
            "bbl": key,
            "address": (r.get("address") or "").title() or None,
            "year_built": int(num(r.get("yearbuilt"), 0) or 0) or None,
            "year_altered": int(num(r.get("yearalter1"), 0) or 0) or None,
            "floors": num(r.get("numfloors")),
            "buildings_on_lot": num(r.get("numbldgs")),
            "bldg_class": r.get("bldgclass"),
            "land_use": int(num(r.get("landuse"), 0) or 0) or None,
            "units_res": int(num(r.get("unitsres"), 0) or 0),
            "units_total": int(num(r.get("unitstotal"), 0) or 0),
            "bldg_area_sqft": num(r.get("bldgarea")),
            "res_area_sqft": num(r.get("resarea")),
            "lot_area_sqft": num(r.get("lotarea")),
            "assessed_total": num(r.get("assesstot")),
            "owner": (r.get("ownername") or "").title() or None,
            "zipcode": (r.get("zipcode") or "").strip() or None,
            "lat": num(r.get("latitude")),
            "lon": num(r.get("longitude")),
        }
    return out


#: PLUTO land-use codes, for the exposure narrative.
LAND_USE = {
    1: "One & Two Family Buildings",
    2: "Multi-Family Walk-Up Buildings",
    3: "Multi-Family Elevator Buildings",
    4: "Mixed Residential & Commercial",
    5: "Commercial & Office Buildings",
    6: "Industrial & Manufacturing",
    7: "Transportation & Utility",
    8: "Public Facilities & Institutions",
    9: "Open Space & Outdoor Recreation",
    10: "Parking Facilities",
    11: "Vacant Land",
}

#: Land uses where people sleep. Overnight exposure is the lethal kind, so the
#: exposure ranking weights these differently from offices.
RESIDENTIAL_USES = {1, 2, 3, 4}


# ------------------------------------------------------------------------ HVI


def hvi_by_zcta(refresh: bool = False) -> dict[str, int]:
    """Heat Vulnerability Index, 1 (lowest) to 5 (highest), keyed by 2020 ZCTA.

    The HVI is a quintile rank, not a continuous score. It combines surface
    temperature, green space, air-conditioning access, median income and the
    share of Black residents — i.e. it already encodes who is least able to
    cope, which is exactly the weighting an exposure ranking needs.
    """
    rows = socrata("hvi", fmt="json", cache_key="hvi", refresh=refresh, **{"$limit": "500"})
    out: dict[str, int] = {}
    for r in rows:
        z = (r.get("zcta20") or "").strip()
        v = num(r.get("hvi"))
        if z and v is not None:
            out[z] = int(v)
    return out


def modzcta_geometry(refresh: bool = False) -> list[dict]:
    """MODZCTA polygons, with the comma-separated ZCTA list already split."""
    raw = socrata(
        "modzcta", fmt="geojson", cache_key="modzcta", refresh=refresh, **{"$limit": "500"}
    )
    out = []
    for feat in raw.get("features", []):
        p = feat.get("properties") or {}
        zctas = [z.strip() for z in (p.get("zcta") or "").split(",") if z.strip()]
        out.append(
            {
                "modzcta": (p.get("modzcta") or "").strip(),
                "zctas": zctas or ([p.get("modzcta")] if p.get("modzcta") else []),
                "label": p.get("label"),
                "pop_est": num(p.get("pop_est")),
                "geometry": feat.get("geometry"),
            }
        )
    return out


# ---------------------------------------------------------------------- trees


def trees(area: aoi_mod.AOI, refresh: bool = False) -> list[dict]:
    """Living street trees inside the AOI (2015 census). Points, no geometry column."""
    rows = socrata(
        "trees", fmt="json", cache_key=f"trees_{area.key}", refresh=refresh,
        **{
            "$where": (
                f"borocode=1 AND status='Alive' "
                f"AND latitude > {area.south} AND latitude < {area.north} "
                f"AND longitude > {area.west} AND longitude < {area.east}"
            ),
            "$limit": "40000",
            "$select": "tree_id,spc_common,tree_dbh,health,latitude,longitude,curb_loc",
        },
    )
    out = []
    for r in rows:
        lat, lon = num(r.get("latitude")), num(r.get("longitude"))
        if lat is None or lon is None:
            continue
        out.append(
            {
                "id": r.get("tree_id"),
                "species": (r.get("spc_common") or "").title() or None,
                "dbh_in": num(r.get("tree_dbh"), 0.0),
                "health": r.get("health"),
                "lat": lat,
                "lon": lon,
            }
        )
    return out


# -------------------------------------------------------------------- sensors


def sensors(refresh: bool = False, year: str = "2019") -> list[dict]:
    """Distinct Manhattan street-level sensor locations (Hyperlocal Temperature Monitoring).

    84 sensors, cluster-heavy in Harlem — this is the only measured air
    temperature we can validate the horizontal field against, and it is all at
    pedestrian height. Nothing here validates the vertical extrapolation, which
    is stated plainly in the methodology rather than glossed over.
    """
    rows = socrata(
        "sensors", fmt="json", cache_key=f"sensors_locations_{year}", refresh=refresh,
        **{
            "$where": f"borough='Manhattan' AND year='{year}' AND hour=15",
            "$limit": "50000",
            "$select": "sensor_id,latitude,longitude,install_type,ntacode,day,hour,airtemp",
        },
    )
    return rows


def sensor_series(sensor_ids: list[str], year: str = "2019", refresh: bool = False) -> list[dict]:
    """Hourly readings for specific sensors. airtemp is degrees FAHRENHEIT."""
    quoted = ",".join(f"'{s}'" for s in sensor_ids)
    return socrata(
        "sensors", fmt="json",
        cache_key=f"sensors_series_{year}_{abs(hash(quoted)) % 10**8}", refresh=refresh,
        **{
            "$where": f"year='{year}' AND sensor_id in({quoted})",
            "$limit": "200000",
            "$select": "sensor_id,latitude,longitude,day,hour,airtemp,install_type",
            "$order": "sensor_id,day,hour",
        },
    )


F_TO_C = lambda f: (f - 32.0) * 5.0 / 9.0  # noqa: E731


if __name__ == "__main__":
    from . import aoi

    area = aoi.MIDTOWN
    fps = footprints(area)
    cls = centerlines(area)
    print(f"footprints  {len(fps):,}")
    print(f"centerlines {len(cls):,}  ({sum(1 for c in cls if c['width_m']):,} with width)")
