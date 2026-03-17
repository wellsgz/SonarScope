# SonarScope

Endpoint reachability monitoring platform. Ingests inventory spreadsheets, runs ICMP probes at configurable intervals, stores raw + aggregated probe data in TimescaleDB, and exposes dashboards via WebSocket-driven React UI.

## Claude Behavior

Claude acts strictly as planner and reviewer. Never write or edit code. Never exit plan mode. Only produce plans, analysis, and code reviews.

## Tech Stack

- **Backend**: Go 1.22, chi/v5 router, pgx/v5, gorilla/websocket, excelize/v2
- **Frontend**: React 18, TypeScript 5.6 (strict), Vite, TanStack Query + Table, ECharts, Tailwind CSS 3
- **Database**: PostgreSQL 16 + TimescaleDB (hypertables, continuous aggregates, compression)
- **Infra**: Docker Compose (dev + prod), Caddy reverse proxy, GHCR images

## Project Layout

```
backend/
  cmd/sonarscope-api/       # main.go entry point
  internal/
    api/                     # HTTP handlers (server.go has routes)
    config/                  # env-based config with validation
    db/                      # pgx connection pool
    importer/                # CSV/XLSX parsing + diff classification
    model/                   # domain types (types.go)
    probe/                   # ICMP engine with fan-out scheduling
    store/                   # SQL data access layer
    telemetry/               # WebSocket hub for live updates
    util/                    # HTTP response helpers
  migrations/                # numbered SQL migrations (001-006)

frontend/
  src/
    api/client.ts            # API client with timeout handling
    components/              # reusable UI (layout, monitor, inventory)
    hooks/                   # useTheme, useMonitorSocket, useTimeRange
    pages/                   # MonitorPage, InventoryPage, GroupsPage, SettingsPage
    styles/                  # CSS tokens, base, layout, component styles
    types/                   # api.ts (API types), ui.ts (UI types)

docs/
  api.md                     # full API endpoint reference
  architecture.md            # system design overview
  frontend-style.md          # typography/spacing rules
```

## Development Commands

```bash
make backend-test            # run Go tests
make backend-run             # run API locally (needs Postgres)
make frontend-dev            # Vite dev server on :5173
make up-dev                  # full Docker Compose dev stack
make down-dev                # stop dev stack
```

## Verifying Changes

- **Backend**: `cd backend && go build ./...` to check compilation, `make backend-test` to run tests
- **Frontend**: `cd frontend && npx tsc --noEmit` to type-check, `cd frontend && npx vite build` to verify build

## Code Conventions

### Backend (Go)
- Standard Go conventions (gofmt, exported = PascalCase, unexported = camelCase)
- Handler methods live on `*Server` in `internal/api/`
- All DB operations use `context.Context`
- Store layer returns domain models, not raw SQL rows
- Error handling: explicit returns, no panics in handlers
- snake_case for JSON field names and database columns

### Frontend (React/TypeScript)
- PascalCase for component files and exports
- camelCase for hooks, utilities, variables
- Use typography/spacing tokens from `styles/tokens.css` -- no ad-hoc px values
- Prefer class-based Tailwind styles over inline `style={}` attributes
- React Query for all server state (no manual fetch + useState)
- Custom hooks for cross-cutting concerns (theme, websocket, time)

## Architecture Essentials

### API Routes
All routes under `/api`. Key groups: `/api/inventory/*`, `/api/groups/*`, `/api/probes/*`, `/api/settings/`, `/api/monitor/*`. WebSocket at `/ws/monitor`. Health check at `/healthz`. See `docs/api.md` for full reference.

### Database Schema
Key tables: `inventory_endpoint` (IP unique), `group_def`/`group_member` (groups), `ping_raw` (TimescaleDB hypertable), `ping_1m`/`ping_1h` (continuous aggregates), `endpoint_stats_current` (materialized live stats), `app_settings` (singleton), `custom_field_config` (slots 1-3).

Retention: raw=30d (compressed after 7d), 1m=12mo, 1h=24mo.

### Key Constraints
- Probing must be stopped before import-apply (409 Conflict otherwise)
- Delete jobs are singleton (409 if one is already running)
- Groups enforce single membership per endpoint
- Custom fields have 3 fixed slots

### Proxy Config
Vite dev server proxies `/api` and `/healthz` to `localhost:8080`, `/ws` to `ws://localhost:8080`. Production uses Caddy.
