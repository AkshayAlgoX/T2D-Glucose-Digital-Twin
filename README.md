# T2D Digital Twin - Clinical Workstation

A production-grade, highly-deterministic frontend for the Type 2 Diabetes Digital Twin system. This UI is designed as a strict **Clinical Instrument** intended for research and monitoring, backed by a predictive Transformer (TFT) model and physiological physics bounds.

## Architecture

This frontend is a Next.js application acting as a strict visualization layer for the underlying FastAPI forecasting service. 
- **Zod Contract Validation**: Every response (Forecast, Current, SpikeRisk) and Server-Sent Event (SSE) is strictly validated against `v1` backend schemas to guarantee UI determinism.
- **D3 + SVG Rendering**: High-performance, declarative charts (`ForecastCanvas`, `RiskStrip`) powered by native SVG and D3 scales to ensure sub-pixel accuracy and deterministic layout.
- **Fail-safe Error Boundaries**: Full fallback semantics for stale data, unavailable endpoints, twin-only degraded modes, and schema violations.

## Key Technical Decisions
1. **No Mock Data**: The frontend relies entirely on real inference streams. For layout testing, isolated `design-review` fixtures are used.
2. **Clinical Language**: Adheres strictly to the Opus 5.5 High Audit specifications—no gradients, no 3D effects, and no generic SaaS abstractions.
3. **Collision-Aware Layout**: SVG text labels intelligently avoid boundaries and data points to guarantee clinical readability.
