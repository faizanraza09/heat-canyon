# The Urban Canyon, containerised.
#
# The application is Python — FastAPI over a precomputed model, re-solving the
# energy balance when someone tests an intervention. The analyst is Claude Code
# as a library, and `claude-agent-sdk` does not talk to an API: it SPAWNS THE
# `claude` CLI as a subprocess.
#
# That used to mean Node and a global npm install in this image. It does not any
# more, and the reason is worth writing down because it is invisible from the
# requirements file: the SDK ships PLATFORM-SPECIFIC wheels
# (…-py3-none-manylinux_2_17_x86_64.whl, 215 MB unpacked) carrying a standalone
# `claude` binary at claude_agent_sdk/_bundled/claude, and `_find_cli()` in
# _internal/transport/subprocess_cli.py resolves that bundle BEFORE it consults
# PATH. So `pip install claude-agent-sdk` is the whole install, and adding Node
# beside it would only have shadowed a binary that was already there.
#
# Nothing here builds the model. `python -m heatcanyon.cli build` needs the raw
# LiDAR and the NYC footprints — 200 MB of sources that are not in the repo and
# not in this image. The solved fields under web/data/ are built on a
# workstation and shipped as artifacts; see scripts/deploy_hf.py.

FROM python:3.12-slim

# git because the agent's shell is a real shell and a tree it cannot interrogate
# makes a worse analyst; curl for the healthcheck. That is the whole list.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces runs containers as uid 1000 and gives that user nothing
# unless you make it. The agent writes run transcripts under .agent/ and the
# CLI wants a config directory in $HOME, so both have to belong to this user.
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Dependencies first, so an edit to the application does not re-resolve them.
COPY --chown=user:user requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Then the application. web/ is ~190 MB of solved fields and is the bulk of it.
COPY --chown=user:user . .

# Fail the BUILD if the model did not make it into the context, rather than
# letting the container start and 503 on everything that needs data. This is not
# hypothetical: .gcloudignore is gitignore syntax, where a bare `data/` matches
# at any depth and quietly takes `web/data/` with it, and the first deploy did
# exactly that — 189 MB missing, image built clean, container dead on the
# startup probe with the real cause four levels down a stack trace.
RUN test -f web/data/meta.json \
    || (echo "FATAL: web/data/meta.json missing — the solved fields were not in the build context. Check .gcloudignore/.dockerignore." >&2; exit 1) \
    && n=$(find web/data -name '*.bin' | wc -l) \
    && test "$n" -ge 20 \
    || (echo "FATAL: only $n .bin files under web/data; expected 20+. The build context is incomplete." >&2; exit 1) \
    && echo "model present: $n solved-field binaries, $(du -sh web/data | cut -f1)"

# The agent's workspace and the run transcripts the film replays.
RUN mkdir -p /app/.agent/runs && chown -R user:user /app

USER user

# Every path in this application is relative to the repository root — ai.py
# reads web/data, voice.py reads web/data/vo — which is exactly why WORKDIR is
# /app and the process is never started from anywhere else.
#
# HEATCANYON_HOST is the one thing the code will not assume: server.py binds
# loopback unless told otherwise, so a laptop never acquires a public server by
# accident and a container always does.
ENV HEATCANYON_HOST=0.0.0.0 \
    PORT=7860 \
    HEATCANYON_AGENT_AUTH=oauth \
    HEATCANYON_AGENT_WORKSPACE=/app/.agent \
    CLAUDE_CONFIG_DIR=/home/user/.claude \
    CLAUDE_CODE_DISABLE_AUTO_MEMORY=1

# Spend, bounded tighter here than on a laptop, because the difference between a
# laptop and this is that anyone can drive it. The three caps do different jobs
# and none of them substitutes for another: BUDGET_USD stops one runaway turn but
# is invisible to the model, so it cuts mid-tool-call; TASK_BUDGET_TOKENS is a
# countdown the model can see, so it wraps up holding its finding instead of
# being guillotined; SESSION_BUDGET_USD is the only one that bounds the process
# across every visitor, and it is the one that matters on a public URL.
#
# All three are plain environment variables, so they are raised or lowered from
# the Space's settings without a rebuild.
ENV HEATCANYON_AGENT_BUDGET_USD=1.50 \
    HEATCANYON_AGENT_SESSION_BUDGET_USD=15 \
    HEATCANYON_AGENT_TASK_BUDGET_TOKENS=250000 \
    HEATCANYON_AGENT_MAX_CONCURRENT=2 \
    HEATCANYON_AGENT_TIMEOUT_S=600

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:7860/api/health || exit 1

CMD ["python", "-m", "heatcanyon.cli", "serve"]
