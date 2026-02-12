# SonarScope API (v1)

## Inventory Import Preview

`POST /api/inventory/import-preview`

- Multipart field: `file` (`.csv`, `.xlsx`, `.xls`, `.xlsm`)
- Required header: `ip` or `ip_address`
- Optional headers: `hostname`, `mac`/`mac_address`, `vlan`, `switch`/`switch_name`, `port`, `port_type`, `description`, `sorting`, `custom_field_1_value`, `custom_field_2_value`, `custom_field_3_value`
- Comment rows are ignored when the first non-empty cell begins with `#`
- IP-only files are valid for preview/apply
- Returns `preview_id` and row-level classification.

`DELETE /api/inventory/import-preview/{previewID}`

- Best-effort cleanup for a generated preview.
- Returns `404` if preview is already expired or applied.

## Inventory Import Template

`GET /api/inventory/import-template.csv`

- Returns downloadable CSV template with:
  - one commented instruction line for required vs optional columns
  - one header row containing all supported import fields

## Inventory Import Apply

`POST /api/inventory/import-apply`

```json
{
  "preview_id": "<preview-id>",
  "selections": [
    { "row_id": "row-12", "action": "add" },
    { "row_id": "row-14", "action": "update" }
  ]
}
```

- Precondition: probing must be stopped before apply.
- If probing is running, API returns `409 Conflict`:

```json
{
  "error": "probing is running; stop probing before import apply"
}
```

Import apply behavior:
- For new endpoints, blank/missing hostname defaults to IP.
- For updates, blank optional values are treated as no-change (existing stored values are preserved).

## Groups

- `GET /api/groups/`
- `POST /api/groups/`
- `PUT /api/groups/{groupID}`
- `DELETE /api/groups/{groupID}`

Payload for create/update:

```json
{
  "name": "DB-Core",
  "description": "Database core endpoints",
  "endpoint_ids": [1001, 1002, 1003]
}
```

## Probe Control

`POST /api/probes/start`

```json
{
  "scope": "groups",
  "group_ids": [1, 2]
}
```

`POST /api/probes/stop`

## Settings

- `GET /api/settings/`
- `PUT /api/settings/`

```json
{
  "ping_interval_sec": 1,
  "icmp_payload_bytes": 56,
  "icmp_timeout_ms": 500,
  "auto_refresh_sec": 30,
  "custom_fields": [
    { "slot": 1, "enabled": false, "name": "" },
    { "slot": 2, "enabled": false, "name": "" },
    { "slot": 3, "enabled": false, "name": "" }
  ]
}
```

`PUT /api/settings/` accepts partial patch updates. `custom_fields` entries are merged by `slot` (`1..3`).

## Monitoring

- `GET /api/monitor/endpoints?vlan=100,200&switch=sw-a&port=1/1&group=DB-Core`
- `GET /api/monitor/endpoints-page?vlan=100&group=DB-Core&page=1&page_size=100&sort_by=failed_count&sort_dir=desc&hostname=web&mac=AA:BB&custom_1=rack-a&custom_2=critical&custom_3=core&ip_list=10.0.0.1,10.0.0.2`
- `GET /api/monitor/timeseries?endpoint_ids=1001,1002&start=2026-02-08-00-00-00&end=2026-02-08-01-00-00`
- `GET /api/monitor/filter-options`

`sort_by` accepted values for `/api/monitor/endpoints-page`:
- live scope: `last_failed_on`, `last_success_on`, `success_count`, `failed_count`, `consecutive_failed_count`, `max_consecutive_failed_count`, `max_consecutive_failed_count_time`, `failed_pct`, `last_ping_latency`, `average_latency`
- range scope: `last_failed_on`, `last_success_on`, `success_count`, `failed_count`, `failed_pct`, `average_latency`

Monitor endpoint payloads (`/api/monitor/endpoints` and `/api/monitor/endpoints-page`) include:
- `custom_field_1_value`
- `custom_field_2_value`
- `custom_field_3_value`

For `GET /api/monitor/endpoints-page` with `stats_scope=range`:
- `consecutive_failed_count` is the trailing failed streak at the end of the selected time window.
- `max_consecutive_failed_count` is the largest failed streak within the selected window.
- `max_consecutive_failed_count_time` is the timestamp of the last failed probe in that largest streak (latest timestamp on ties).
- If raw per-probe rows are unavailable for the selected window (for example older than raw retention), SonarScope uses deterministic fallback:
  - all-failed aggregate windows (`success_count=0` and `failed_count>0`) => both streak counts equal `total_sent_ping` and time equals `last_failed_on`;
  - otherwise streak counts/time return `0 / 0 / null`.

## Inventory

- `GET /api/inventory/endpoints?vlan=100&group=DB-Core&custom_1=rack-a&custom_2=critical&custom_3=core`
- `GET /api/inventory/endpoints/export.csv?vlan=100&group=DB-Core&custom_1=rack-a&custom_2=critical&custom_3=core`
- `POST /api/inventory/endpoints`
- `PUT /api/inventory/endpoints/{endpointID}`
- `DELETE /api/inventory/endpoints/{endpointID}`

Inventory endpoint payloads include:
- `custom_field_1_value`
- `custom_field_2_value`
- `custom_field_3_value`

Inventory CSV export:
- Query params mirror `GET /api/inventory/endpoints` filters (`vlan`, `switch`, `port`, `group`, `custom_1`, `custom_2`, `custom_3`).
- Response is `text/csv` with attachment filename `inventory-export-<timestamp>.csv`.
- CSV columns follow inventory view order and include enabled/configured custom fields by configured names.

Delete inventory endpoint:
- `DELETE /api/inventory/endpoints/{endpointID}` removes endpoint + group membership + current stats + probe history.
- Returns `409 Conflict` when an inventory delete job is already running.

## WebSocket

`GET /ws/monitor`

Event examples:

```json
{ "type": "probe_update", "endpoint_id": 1001, "ip": "10.0.0.10", "status": "succeeded", "latency_ms": 3.1 }
```

```json
{ "type": "probe_error", "message": "persist ping failed: ..." }
```
