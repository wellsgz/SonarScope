# SonarScope API (v1)

## Inventory Import Preview

`POST /api/inventory/import-preview`

- Multipart field: `file` (`.csv`, `.xlsx`, `.xls`, `.xlsm`)
- Returns `preview_id` and row-level classification.

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
  "auto_refresh_sec": 10
}
```

## Monitoring

- `GET /api/monitor/endpoints?vlan=100,200&switch=sw-a&port=1/1&group=DB-Core`
- `GET /api/monitor/endpoints-page?vlan=100&group=DB-Core&page=1&page_size=100&sort_by=failed_count&sort_dir=desc&hostname=web&ip_list=10.0.0.1,10.0.0.2`
- `GET /api/monitor/timeseries?endpoint_ids=1001,1002&start=2026-02-08-00-00-00&end=2026-02-08-01-00-00`
- `GET /api/monitor/filter-options`

## WebSocket

`GET /ws/monitor`

Event examples:

```json
{ "type": "probe_update", "endpoint_id": 1001, "ip": "10.0.0.10", "status": "succeeded", "latency_ms": 3.1 }
```

```json
{ "type": "probe_error", "message": "persist ping failed: ..." }
```
