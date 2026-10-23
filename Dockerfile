# ==============================================================================
# Dockerfile: T2D Glucose Digital Twin Unified Container (Next.js + FastAPI)
# Hugging Face Space (Docker SDK, CPU basic: 2 vCPU / 16 GB)
# ==============================================================================

FROM python:3.12-slim-bookworm AS runner

# Install Node.js 22 LTS, curl, ca-certificates, and build tools
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

# Create standard non-root user (Hugging Face Spaces runs as user 1000)
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

WORKDIR /home/app/twin

# Install Python backend dependencies first (cached layer)
COPY --chown=app:app backend/requirements.txt backend/
RUN pip install --no-cache-dir --user -r backend/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

# Install Node.js dependencies including build-time tooling
COPY --chown=app:app package.json package-lock.json ./
RUN npm ci --include=dev

# Copy repository sources and pre-generated model artifacts
COPY --chown=app:app . .

# Build Next.js production application
RUN npm run prebuild && npx next build

# Ensure entrypoint is executable
RUN chmod +x deploy/entrypoint.sh

# Expose default Hugging Face Spaces port
EXPOSE 7860

# Launch both FastAPI backend and Next.js frontend via supervisor script
CMD ["/bin/bash", "deploy/entrypoint.sh"]
