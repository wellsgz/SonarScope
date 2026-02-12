# SonarScope

SonarScope is a web-based endpoint reachability platform for network operations teams. It ingests inventory spreadsheets, builds endpoint groups, runs ICMP probes, stores raw and rolled-up probe data, and exposes dashboards for troubleshooting correlation.

## Repository Layout

- `/backend`: Go API + probe engine + SQL migrations
- `/frontend`: React + TypeScript + Vite dashboard
- `/deploy`: Docker Compose manifests for deployment (GHCR images) and local development (source builds)
- `/docs`: architecture and API notes

## Features Implemented

- Inventory spreadsheet ingestion with preview and incremental diff classification (`add`, `update`, `unchanged`, `invalid`)
- Inventory apply flow with user-selected Add/Update actions
- Group CRUD with endpoint membership
- Probe control API (`start` all/groups, `stop`)
- Global settings API (`ping_interval_sec`, `icmp_payload_bytes`, `icmp_timeout_ms`, `auto_refresh_sec`)
- Persistent storage model for inventory, groups, raw ping events, and current stats
- Monitoring API for upper grid and lower time-series chart
- WebSocket stream for live monitor update events
- Two-pane web UI with filters, quick/custom time range controls, and responsive layout

## Quick Start (Docker)

### Run from GHCR images (deploy mode)

1. Copy deploy variables:

```bash
cp deploy/.env.deploy.example deploy/.env.deploy
```

2. Pull and start:

```bash
cd deploy
docker compose -f docker-compose.yml --env-file .env.deploy up -d
```

### Run from local source (dev mode)

1. Copy dev variables:

```bash
cp deploy/.env.dev.example deploy/.env.dev
```

2. Build and start:

```bash
cd deploy
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --build
```

### Access

- UI: `http://localhost:8088`
- API health: `http://localhost:8088/healthz`

If GHCR packages are private, authenticate first:

```bash
echo <GITHUB_TOKEN> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin
```

For anonymous pulls, set package visibility to public in GitHub Packages.

## Local Backend Run (without Docker)

```bash
cd backend
export DATABASE_URL="postgres://sonarscope:sonarscope@localhost:5432/sonarscope?sslmode=disable"
export MIGRATIONS_DIR="migrations"
export DEFAULT_ICMP_TIMEOUT_MS="500"
go run ./cmd/sonarscope-api
```

Notes:
- ICMP raw sockets require privileges (`CAP_NET_RAW` or root-level permission).
- TimescaleDB extension must be available in PostgreSQL.

## Local Frontend Run

```bash
cd frontend
npm install
npm run dev
```

Set API base URL if needed:

```bash
export VITE_API_BASE_URL="http://localhost:8080"
```

## Core API Endpoints

- `POST /api/inventory/import-preview`
- `POST /api/inventory/import-apply`
- `GET/POST/PUT/DELETE /api/groups`
- `POST /api/probes/start`
- `POST /api/probes/stop`
- `GET/PUT /api/settings`
- `GET /api/monitor/endpoints`
- `GET /api/monitor/timeseries`
- `GET /api/monitor/filter-options`
- `GET /ws/monitor`

See `docs/api.md` for request and response samples.

## Retention Strategy

- `ping_raw`: 30 days (compressed after 7 days)
- `ping_1m`: 12 months retention
- `ping_1h`: 24 months retention

## Status

This repository contains a full v1 implementation scaffold and core logic. Building/running requires dependency download (`go mod`, `npm`) in an environment with external package access.
