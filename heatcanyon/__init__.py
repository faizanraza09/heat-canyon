"""HeatCanyon — 3D street-canyon heat exposure engine for Manhattan.

Layers, bottom to top:

  aoi        study-area definitions (the billed polygon == the rendered polygon)
  fg         cache-first FortyGuard access + credit ledger
  nyc        free NYC Open Data / OSM ingest (footprints, streets, PLUTO, HVI)
  geometry   canyon extraction — street axes, facades, aspect ratio, sky view
  solar      solar position, canyon shading, facade irradiance
  physics    vertical air-temperature profile + facade surface energy balance
  exposure   floor-level exposure scoring and vulnerability-weighted ranking
  scenarios  what-if interventions (albedo, trees, shading)
  ai         the AI analyst engine
  pipeline   orchestration -> web/data/*.json
"""

__version__ = "1.0.0"
