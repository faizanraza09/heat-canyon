"""Who is asking, how often they may ask, and whether they may see it.

The analyst was served to anybody who could reach the port. Three things
followed from that, and none of them is exotic:

* **one visitor could spend everyone's budget.** ``SESSION_BUDGET_USD`` caps what
  the process spends in total, which bounds the bill and does nothing about who
  spends it — the first script to find ``/api/agent/ask`` empties it and every
  real visitor gets a 402 until somebody restarts the server;
* **the queue was unbounded.** Every request wrote a ``status.json`` and touched
  a frames file before the concurrency ceiling was consulted, so a loop cost
  disk and queue depth with no ceiling at all;
* **every question was public.** ``/api/agent/runs`` returned every run this
  server had ever served, and ``/interrupt-all`` cancelled everybody's work. The
  demo question is "I own 560 Third Avenue, my contractor wants to insulate the
  East 38th Street wall" — people type their own buildings into that box.

WHAT THIS IS AND IS NOT

The bucket is the real control: it is per address, it is always on, and it is
what stops a script. The token is for a deployment that does not want the public
using the analyst at all — share it with reviewers and set
``HEATCANYON_AGENT_TOKEN``. It is NOT a secret once a public page carries it, and
nothing here pretends otherwise.

The client id is scoping, not authentication. A caller can send somebody else's
id and read their transcript. What it buys is that the ordinary case — two
strangers with the same demo open — no longer shows each of them the other's
questions, and that is the whole of what it claims. Real authentication needs an
identity provider, and this application has no accounts.

NO STATE ANYWHERE BUT MEMORY. Buckets live in this process and are lost on
restart, which for a rate limiter is the correct trade: a restart is rare, the
window is minutes, and the alternative is a datastore for a demo.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field

from . import knobs


def token() -> str:
    """The shared secret, or empty for an open deployment (the local default)."""
    return (os.environ.get("HEATCANYON_AGENT_TOKEN") or "").strip()


def rate_per_hour() -> int:
    """Questions one address may start per hour. A real session is a handful."""
    return knobs._i("HEATCANYON_AGENT_RATE_PER_HOUR", 20)


def rate_burst() -> int:
    """And how many of them back to back, before the refill has to catch up."""
    return knobs._i("HEATCANYON_AGENT_RATE_BURST", 4)


def max_queue() -> int:
    """Turns allowed to be waiting. Past this, 429 — the honest answer, rather
    than accepting work nobody is going to get to."""
    return knobs._i("HEATCANYON_AGENT_MAX_QUEUE", 12)


class Refused(RuntimeError):
    """Rejected before any work started. Carries the HTTP status to answer with."""

    def __init__(self, status: int, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


@dataclass
class _Bucket:
    tokens: float
    at: float = field(default_factory=time.monotonic)


#: address -> bucket. Bounded by `_sweep`, so a flood of forged addresses cannot
#: turn the limiter itself into the memory leak.
_BUCKETS: dict[str, _Bucket] = {}
_SWEPT = 0.0


def _sweep(now: float) -> None:
    global _SWEPT
    if now - _SWEPT < 300:
        return
    _SWEPT = now
    full = float(rate_burst())
    for key, b in list(_BUCKETS.items()):
        # A bucket that has had time to refill completely holds no information.
        if b.tokens >= full and now - b.at > 3600:
            _BUCKETS.pop(key, None)
    if len(_BUCKETS) > 50_000:
        _BUCKETS.clear()


def address(request) -> str:
    """The caller's address, as well as it can be known.

    Behind Cloud Run the socket peer is the load balancer, so `X-Forwarded-For`
    is the only place the client appears — its leftmost entry, which is what the
    first proxy saw. That header is trivially forged by anybody talking to the
    origin directly, so this is a rate-limit key and not an identity: forging it
    buys a fresh bucket, which is exactly what a different address would buy.
    Making it harder than that means an allowlist of proxy addresses, which is a
    deployment's job and not this file's.
    """
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd:
        return fwd
    client = getattr(request, "client", None)
    return (getattr(client, "host", None) or "unknown")


def client_id(request) -> str:
    """Which console this is, for scoping a transcript to the person who asked.

    The header where a header can be sent, and `?client=` where one cannot —
    EventSource sets no headers at all, and the transcript stream is an
    EventSource. Falls back to a hash of the address so that a caller which
    sends nothing still gets consistent scoping rather than seeing everything.
    """
    got = (request.headers.get("x-hc-client")
           or request.query_params.get("client") or "").strip()
    if got:
        return got[:64]
    return "ip-" + hashlib.sha256(address(request).encode()).hexdigest()[:16]


def check_token(request) -> None:
    """Refuse unless the caller carries the shared secret, if one is configured."""
    want = token()
    if not want:
        return
    got = (request.headers.get("x-hc-token")
           or request.query_params.get("token") or "").strip()
    # Compared in constant time out of habit rather than need: the value is a
    # deployment's own string, but a timing oracle on a comparison is the kind of
    # thing that is free to avoid and awkward to explain later.
    import hmac
    if not got or not hmac.compare_digest(got, want):
        raise Refused(401, "This analyst is not open to the public. "
                           "Ask whoever deployed it for the access token.")


def check_rate(request) -> None:
    """Spend one token from this address's bucket, or refuse with a wait."""
    now = time.monotonic()
    _sweep(now)
    per_hour = max(1, rate_per_hour())
    burst = max(1, rate_burst())
    key = address(request)
    b = _BUCKETS.get(key)
    if b is None:
        b = _BUCKETS[key] = _Bucket(tokens=float(burst))
    # Refill for the time since the last look, capped at the burst size.
    b.tokens = min(float(burst), b.tokens + (now - b.at) * per_hour / 3600.0)
    b.at = now
    if b.tokens < 1.0:
        wait = int((1.0 - b.tokens) * 3600.0 / per_hour) + 1
        raise Refused(
            429,
            f"That is {per_hour} questions in an hour from this address, which is "
            f"the limit. The analyst spends real money per answer and this is a "
            f"public demo. Try again in {wait} seconds — everything else in the "
            f"application keeps working.",
            retry_after=wait)
    b.tokens -= 1.0


def describe() -> dict:
    """What the console may show about the gate. No secrets, and never the token
    itself — only whether one is required."""
    return {
        "token_required": bool(token()),
        "rate_per_hour": rate_per_hour(),
        "rate_burst": rate_burst(),
        "max_queue": max_queue(),
    }
