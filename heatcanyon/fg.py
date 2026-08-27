"""Cache-first access to the FortyGuard tOS Enterprise API.

Every response is written to ``data/manhattan/`` under a deterministic key
derived from the request itself, so a second run of the pipeline costs zero
credits. Nothing in this project calls the API twice for the same question.

The cache key is a hash of the full request payload, which means changing a
threshold or a granularity correctly misses the cache while re-running the same
analysis correctly hits it.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv

from fortyguard import FortyGuardClient

from . import aoi as aoi_mod

load_dotenv()

CACHE_DIR = Path(os.getenv("HEATCANYON_CACHE", "data/manhattan"))
LEDGER = CACHE_DIR / "_ledger.json"


# --------------------------------------------------------------------- ledger


def _load_ledger() -> dict:
    if LEDGER.exists():
        return json.loads(LEDGER.read_text())
    return {"calls": []}


def _append_ledger(entry: dict) -> None:
    """Record every billed call so the credit spend is auditable after the fact."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ledger = _load_ledger()
    ledger["calls"].append(entry)
    LEDGER.write_text(json.dumps(ledger, indent=2))


def spend_report() -> str:
    ledger = _load_ledger()
    calls = ledger["calls"]
    if not calls:
        return "No billed calls recorded."
    lines = [f"{len(calls)} billed call(s) recorded:"]
    for c in calls:
        lines.append(
            f"  {c.get('at', '?')}  {c.get('endpoint', '?'):<18}"
            f"  {c.get('label', '')}  cost={c.get('credits_delta', '?')}"
        )
    total = sum(c.get("credits_delta") or 0 for c in calls)
    lines.append(f"  {'':>21}{'TOTAL':<18}  {'':<28}cost={total}")
    return "\n".join(lines)


# ---------------------------------------------------------------------- cache


def _key(endpoint: str, payload: dict, label: str) -> str:
    blob = json.dumps({"endpoint": endpoint, "payload": payload}, sort_keys=True)
    digest = hashlib.sha1(blob.encode()).hexdigest()[:12]
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in label)
    return f"{endpoint.strip('/').replace('/', '_')}__{safe}__{digest}"


def cache_path(endpoint: str, payload: dict, label: str) -> Path:
    return CACHE_DIR / f"{_key(endpoint, payload, label)}.json"


@dataclass
class Fetch:
    """One cached API result plus the provenance needed to defend it."""

    endpoint: str
    label: str
    payload: dict
    result: Any
    from_cache: bool
    activity_id: str | None = None
    fetched_at: str | None = None

    @property
    def cached(self) -> bool:
        return self.from_cache


class CachedFortyGuard:
    """Wraps FortyGuardClient with a disk cache and a credit ledger.

    Parameters
    ----------
    allow_live:
        When False, a cache miss raises instead of spending credits. This is the
        default for the web server and any code path a judge might trigger — the
        demo can never burn credits by accident.
    """

    def __init__(self, allow_live: bool = False, verbose: bool = True) -> None:
        self.allow_live = allow_live
        self.verbose = verbose
        self._client: FortyGuardClient | None = None

    @property
    def client(self) -> FortyGuardClient:
        if self._client is None:
            self._client = FortyGuardClient()
        return self._client

    def credits_remaining(self) -> int | None:
        try:
            usage = self.client.fetch_api_key_usage()
            return usage.get("credit_summary", {}).get("total_remaining_credits")
        except Exception:
            return None

    # ----------------------------------------------------------------- core
    def _fetch(
        self,
        endpoint: str,
        payload: dict,
        label: str,
        call: Callable[[], dict],
    ) -> Fetch:
        path = cache_path(endpoint, payload, label)
        if path.exists():
            blob = json.loads(path.read_text())
            if self.verbose:
                print(f"  [cache] {label}  ({path.name})")
            return Fetch(
                endpoint=endpoint,
                label=label,
                payload=payload,
                result=blob["result"],
                from_cache=True,
                activity_id=blob.get("activity_id"),
                fetched_at=blob.get("fetched_at"),
            )

        if not self.allow_live:
            raise RuntimeError(
                f"Cache miss for {label!r} ({path.name}) and allow_live=False. "
                f"Run the pipeline with --live to fetch it once."
            )

        before = self.credits_remaining()
        if self.verbose:
            print(f"  [LIVE]  {label}  (credits before: {before:,})" if before
                  else f"  [LIVE]  {label}")
        t0 = time.monotonic()
        response = call()
        elapsed = time.monotonic() - t0
        after = self.credits_remaining()
        delta = (before - after) if (before is not None and after is not None) else None

        activity_id = response.get("activity_id") if isinstance(response, dict) else None
        result = response.get("result") if isinstance(response, dict) else response
        fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "endpoint": endpoint,
                    "label": label,
                    "payload": payload,
                    "activity_id": activity_id,
                    "fetched_at": fetched_at,
                    "elapsed_s": round(elapsed, 1),
                    "credits_delta": delta,
                    "result": result,
                },
                indent=2,
            )
        )
        _append_ledger(
            {
                "at": fetched_at,
                "endpoint": endpoint,
                "label": label,
                "activity_id": activity_id,
                "elapsed_s": round(elapsed, 1),
                "credits_before": before,
                "credits_after": after,
                "credits_delta": delta,
                "cache_file": path.name,
            }
        )
        if self.verbose:
            print(f"          done in {elapsed:.0f}s  cost={delta}  -> {path.name}")
        return Fetch(
            endpoint=endpoint,
            label=label,
            payload=payload,
            result=result,
            from_cache=False,
            activity_id=activity_id,
            fetched_at=fetched_at,
        )

    # ------------------------------------------------------------- endpoints
    def heatmap(
        self,
        area: "aoi_mod.AOI",
        start_date: str,
        filter_type: int,
        granularity: int = 100,
        start_time: str | None = None,
        end_time: str | None = None,
        end_date: str | None = None,
        analytic_type: str = "tcm",
        threshold: float | None = None,
        direction: str | None = None,
        label: str | None = None,
    ) -> Fetch:
        date_time: dict[str, Any] = {"start_date": start_date, "filter_type": filter_type}
        if start_time is not None:
            date_time["start_time"] = start_time
        if end_time is not None:
            date_time["end_time"] = end_time
        if end_date is not None:
            date_time["end_date"] = end_date
        payload: dict[str, Any] = {
            "polygon_aoi": area.polygon_aoi(),
            "date_time": date_time,
            "granularity": granularity,
            "analytic_type": analytic_type,
        }
        if threshold is not None:
            payload["threshold"] = threshold
        if direction is not None:
            payload["direction"] = direction

        label = label or f"{area.key}_{analytic_type}_{start_date}_g{granularity}"
        return self._fetch(
            "/v1/heatmap",
            payload,
            label,
            lambda: self.client.create_heatmap(
                polygon_aoi=area.polygon_aoi(),
                start_date=start_date,
                filter_type=filter_type,
                granularity=granularity,
                start_time=start_time,
                end_time=end_time,
                end_date=end_date,
                analytic_type=analytic_type,
                threshold=threshold,
                direction=direction,
                verbose=self.verbose,
                timeout=1800.0,
            ),
        )

    def env_params(
        self,
        latitude: float,
        longitude: float,
        temperature: float,
        start_date: str,
        filter_type: int = 3,
        start_time: str | None = None,
        end_time: str | None = None,
        end_date: str | None = None,
        analysis: list[str] | None = None,
        label: str | None = None,
    ) -> Fetch:
        date_time: dict[str, Any] = {"start_date": start_date, "filter_type": filter_type}
        if start_time is not None:
            date_time["start_time"] = start_time
        if end_time is not None:
            date_time["end_time"] = end_time
        if end_date is not None:
            date_time["end_date"] = end_date
        payload: dict[str, Any] = {
            "latitude": latitude,
            "longitude": longitude,
            "temperature": temperature,
            "date_time": date_time,
        }
        if analysis:
            payload["analysis"] = analysis
        label = label or f"env_{latitude:.4f}_{longitude:.4f}_{start_date}"
        return self._fetch(
            "/v1/env_params",
            payload,
            label,
            lambda: self.client.environmental_parameters(
                latitude=latitude,
                longitude=longitude,
                temperature=temperature,
                start_date=start_date,
                filter_type=filter_type,
                start_time=start_time,
                end_time=end_time,
                end_date=end_date,
                analysis=analysis,
                verbose=self.verbose,
                timeout=900.0,
            ),
        )

    def satellite(
        self,
        latitude: float,
        longitude: float,
        start_date: str,
        filter_type: int = 3,
        granularity: int = 100,
        label: str | None = None,
    ) -> Fetch:
        payload = {
            "sat": {"latitude": latitude, "longitude": longitude},
            "date_time": {"start_date": start_date, "filter_type": filter_type},
            "granularity": granularity,
        }
        label = label or f"sat_{latitude:.4f}_{longitude:.4f}_{start_date}"
        return self._fetch(
            "/v1/satellite",
            payload,
            label,
            lambda: self.client.satellite_segmentation(
                latitude=latitude,
                longitude=longitude,
                start_date=start_date,
                filter_type=filter_type,
                granularity=granularity,
                verbose=self.verbose,
                timeout=1200.0,
            ),
        )

    def street_view(
        self,
        latitude: float,
        longitude: float,
        vertical_angle: float = 0.0,
        horizontal_angle: float = 0.0,
        back_view: bool = False,
        label: str | None = None,
    ) -> Fetch:
        payload = {
            "latitude": latitude,
            "longitude": longitude,
            "vertical_angle": vertical_angle,
            "horizontal_angle": horizontal_angle,
            "back_view": back_view,
        }
        label = label or f"sv_{latitude:.4f}_{longitude:.4f}_h{horizontal_angle:.0f}"
        return self._fetch(
            "/v1/streetview",
            payload,
            label,
            lambda: self.client.street_view_segmentation(
                latitude=latitude,
                longitude=longitude,
                vertical_angle=vertical_angle,
                horizontal_angle=horizontal_angle,
                back_view=back_view,
                verbose=self.verbose,
                timeout=1200.0,
            ),
        )


if __name__ == "__main__":
    print(spend_report())
