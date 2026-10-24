#!/usr/bin/env bash
set -eo pipefail

echo "=========================================================="
echo " Starting T2D Glucose Digital Twin (Unified Container)    "
echo "=========================================================="

PORT="${PORT:-7860}"
HOSTNAME="${HOSTNAME:-0.0.0.0}"
BACKEND_HOST="127.0.0.1"
BACKEND_PORT="8000"
RUN_DIR="${RUN_DIR:-runs/pr_tft_ablation_arm_d}"
export BACKEND_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
export PORT
export HOSTNAME

# Memory and CPU optimizations for 1GB Blitz container
export JAX_PLATFORMS=cpu
export OMP_NUM_THREADS=1
export MKL_NUM_THREADS=1
export OPENBLAS_NUM_THREADS=1
export VECLIB_MAXIMUM_THREADS=1
export NUMEXPR_NUM_THREADS=1
export MALLOC_ARENA_MAX=2

cleanup() {
  echo "Received shutdown signal. Stopping child services..."
  if [ -n "$FASTAPI_PID" ] && kill -0 "$FASTAPI_PID" 2>/dev/null; then
    kill -TERM "$FASTAPI_PID" 2>/dev/null || true
  fi
  if [ -n "$NEXT_PID" ] && kill -0 "$NEXT_PID" 2>/dev/null; then
    kill -TERM "$NEXT_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "All services stopped."
}

trap cleanup SIGTERM SIGINT EXIT

echo "[1/3] Starting FastAPI backend on ${BACKEND_HOST}:${BACKEND_PORT}..."
python -B backend/serve_pr_tft.py \
  --run-dir "${RUN_DIR}" \
  --host "${BACKEND_HOST}" \
  --port "${BACKEND_PORT}" &
FASTAPI_PID=$!

echo "[2/3] Waiting for backend readiness at ${BACKEND_URL}/v1/health..."
BACKEND_READY=0
for i in $(seq 1 60); do
  if ! kill -0 "$FASTAPI_PID" 2>/dev/null; then
    echo "ERROR: FastAPI backend process died during startup."
    exit 1
  fi
  if python -c "
import urllib.request, sys
try:
    with urllib.request.urlopen('${BACKEND_URL}/v1/health', timeout=1) as resp:
        sys.exit(0 if resp.status == 200 else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
    echo "Backend is ready and healthy after ${i}s."
    BACKEND_READY=1
    break
  fi
  sleep 1
done

if [ "$BACKEND_READY" -ne 1 ]; then
  echo "ERROR: Backend failed to respond to /v1/health within 60 seconds."
  exit 1
fi

echo "[3/3] Starting Next.js frontend on ${HOSTNAME}:${PORT}..."
NODE_OPTIONS="--max-old-space-size=128" ./node_modules/.bin/next start -p "${PORT}" -H "${HOSTNAME}" &
NEXT_PID=$!

echo "=========================================================="
echo " T2D Glucose Digital Twin is fully initialized and live!  "
echo " Frontend port: ${PORT} | Internal backend: ${BACKEND_PORT}"
echo "=========================================================="

# Wait for any process to exit
wait -n "$FASTAPI_PID" "$NEXT_PID"
EXIT_STATUS=$?

echo "A child process terminated with exit code ${EXIT_STATUS}. Exiting container."
exit "$EXIT_STATUS"
