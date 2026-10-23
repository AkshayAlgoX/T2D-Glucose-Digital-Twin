# ==============================================================================
# Hugging Face Space Dockerfile: Unified Next.js + FastAPI Single Container
# Hardware: CPU basic (2 vCPU / 16 GB RAM) | SDK: docker | Port: 7860
# ==============================================================================

FROM python:3.12-slim-bookworm

ARG REPO=https://github.com/AkshayAlgoX/T2D-Glucose-Digital-Twin.git
ARG REF=deploy/hf-space

# Install Node.js 22 LTS, git, git-lfs, and system utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    git-lfs \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && git lfs install \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with UID 1000 for Hugging Face Spaces runtime sandbox
RUN useradd -m -u 1000 app && mkdir -p /home/app/twin && chown -R app:app /home/app

USER app
ENV HOME=/home/app
ENV PATH="/home/app/.local/bin:${PATH}"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production
ENV PORT=7860
ENV HOSTNAME=0.0.0.0
ENV BACKEND_URL=http://127.0.0.1:8000

WORKDIR /home/app

# Clone repo and fetch model weights via Git LFS
RUN git clone "$REPO" twin \
    && cd twin \
    && (git checkout "$REF" 2>/dev/null || (git fetch origin "$REF" && git checkout "$REF")) \
    && git lfs pull --include "runs/pr_tft_ablation_arm_d/**"

WORKDIR /home/app/twin

# Ensure deployment entrypoint exists even if checking out an earlier raw commit
RUN if [ ! -f deploy/entrypoint.sh ]; then \
    mkdir -p deploy && \
    printf '#!/usr/bin/env bash\nset -eo pipefail\nPORT="${PORT:-7860}"\nHOSTNAME="${HOSTNAME:-0.0.0.0}"\nBACKEND_HOST="127.0.0.1"\nBACKEND_PORT="8000"\nRUN_DIR="${RUN_DIR:-runs/pr_tft_ablation_arm_d}"\nexport BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"\nexport PORT\nexport HOSTNAME\ncleanup() {\n  kill -TERM $FASTAPI_PID $NEXT_PID 2>/dev/null || true\n  wait 2>/dev/null || true\n}\ntrap cleanup SIGTERM SIGINT EXIT\npython -B backend/serve_pr_tft.py --run-dir "${RUN_DIR}" --host "${BACKEND_HOST}" --port "${BACKEND_PORT}" &\nFASTAPI_PID=$!\nfor i in $(seq 1 60); do\n  if python -c "import urllib.request; urllib.request.urlopen(\"${BACKEND_URL}/v1/health\")" 2>/dev/null; then break; fi\n  sleep 1\ndone\nnpx next start -p "${PORT}" -H "${HOSTNAME}" &\nNEXT_PID=$!\nwait -n "$FASTAPI_PID" "$NEXT_PID"\n' > deploy/entrypoint.sh && \
    chmod +x deploy/entrypoint.sh; \
    fi

# Ensure health proxy route exists
RUN if [ ! -f src/app/v1/health/route.ts ]; then \
    mkdir -p src/app/v1/health && \
    printf 'import { NextResponse } from "next/server";\nexport const dynamic = "force-dynamic";\nexport async function GET() {\n  const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8000";\n  try {\n    const res = await fetch(`${backendUrl}/v1/health`, { headers: { Accept: "application/json" }, cache: "no-store" });\n    if (!res.ok) return NextResponse.json({ status: "error", upstream_status: res.status }, { status: res.status });\n    return NextResponse.json(await res.json());\n  } catch (err: any) {\n    return NextResponse.json({ status: "error", detail: err?.message || "Backend unreachable" }, { status: 502 });\n  }\n}\n' > src/app/v1/health/route.ts; \
    fi

# Install Python backend dependencies
RUN pip install --no-cache-dir --user -r backend/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

# Install Node dependencies including build-time tooling and build Next.js application
RUN npm ci --include=dev
RUN npm run prebuild && npx next build
RUN chmod +x deploy/entrypoint.sh

EXPOSE 7860

CMD ["/bin/bash", "deploy/entrypoint.sh"]
