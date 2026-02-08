# SonarScope Architecture

## Components

1. Web UI (`frontend`)
- React + TypeScript + Vite
- TanStack Table (upper pane)
- ECharts (lower pane)
- React Query polling + WebSocket-driven refresh

2. API + Probe Engine (`backend`)
- Go HTTP API
- ICMP probe scheduler with worker pool and jitter
- Import preview/apply workflow
- Group and settings management

3. Database
- PostgreSQL 16 + TimescaleDB
- Hypertable for raw ping events
- Continuous aggregates for 1-minute and 1-hour rollups

## Data Flow

1. Spreadsheet import:
- UI uploads CSV/XLSX to `/api/inventory/import-preview`
- Backend parses rows and classifies against inventory
- UI selects rows/actions and posts to `/api/inventory/import-apply`

2. Probing:
- UI starts probe session (`all` or group scope)
- Engine resolves targets and executes ICMP probes
- Raw events inserted into `ping_raw`
- Current counters updated in `endpoint_stats_current`
- Events broadcast over `/ws/monitor`

3. Monitoring:
- Upper pane queries `/api/monitor/endpoints`
- Lower pane queries `/api/monitor/timeseries`
- Filters applied server-side (VLAN, switch, port, group)

## Scale Notes

- 10,000 endpoints at 1-second intervals can generate high packets-per-second and write load.
- Use interval >1s where practical.
- Tune `PROBE_WORKERS`, DB connection pool, and Timescale chunk/compression settings for production.
