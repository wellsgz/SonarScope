package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"sonarscope/backend/internal/model"
)

type Store struct {
	pool *pgxpool.Pool
}

type MonitorFilters struct {
	VLANs      []string
	Switches   []string
	Ports      []string
	GroupNames []string
}

type ProbeTarget struct {
	EndpointID int64  `json:"endpoint_id"`
	IP         string `json:"ip"`
	Hostname   string `json:"hostname"`
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) EnsureDefaultSettings(ctx context.Context, defaults model.Settings) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO app_settings(id, ping_interval_sec, icmp_payload_bytes, auto_refresh_sec)
		VALUES (TRUE, $1, $2, $3)
		ON CONFLICT (id) DO NOTHING
	`, defaults.PingIntervalSec, defaults.ICMPPayloadSize, defaults.AutoRefreshSec)
	return err
}

func (s *Store) GetSettings(ctx context.Context) (model.Settings, error) {
	settings := model.Settings{}
	err := s.pool.QueryRow(ctx, `
		SELECT ping_interval_sec, icmp_payload_bytes, auto_refresh_sec
		FROM app_settings
		WHERE id = TRUE
	`).Scan(&settings.PingIntervalSec, &settings.ICMPPayloadSize, &settings.AutoRefreshSec)
	if err != nil {
		return model.Settings{}, err
	}
	return settings, nil
}

func (s *Store) UpdateSettings(ctx context.Context, settings model.Settings) error {
	cmd, err := s.pool.Exec(ctx, `
		UPDATE app_settings
		SET ping_interval_sec = $1,
			icmp_payload_bytes = $2,
			auto_refresh_sec = $3,
			updated_at = now()
		WHERE id = TRUE
	`, settings.PingIntervalSec, settings.ICMPPayloadSize, settings.AutoRefreshSec)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return errors.New("settings row not found")
	}
	return nil
}

func (s *Store) InventoryByIP(ctx context.Context) (map[string]model.InventoryEndpoint, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, host(ip), mac, vlan, switch_name, port, description, status, zone, fw_lb, hostname, updated_at
		FROM inventory_endpoint
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := map[string]model.InventoryEndpoint{}
	for rows.Next() {
		var endpoint model.InventoryEndpoint
		if err := rows.Scan(
			&endpoint.ID,
			&endpoint.IP,
			&endpoint.MAC,
			&endpoint.VLAN,
			&endpoint.SwitchName,
			&endpoint.Port,
			&endpoint.Description,
			&endpoint.Status,
			&endpoint.Zone,
			&endpoint.FWLB,
			&endpoint.Hostname,
			&endpoint.UpdatedAt,
		); err != nil {
			return nil, err
		}
		result[endpoint.IP] = endpoint
	}
	return result, rows.Err()
}

func (s *Store) ApplyImport(ctx context.Context, rows []model.ImportCandidate) (int, int, []string) {
	added := 0
	updated := 0
	errorsOut := make([]string, 0)

	for _, row := range rows {
		switch row.Action {
		case model.ImportAdd:
			cmd, err := s.pool.Exec(ctx, `
				INSERT INTO inventory_endpoint(ip, mac, vlan, switch_name, port, description, status, zone, fw_lb, hostname, updated_at)
				VALUES ($1::inet, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
				ON CONFLICT (ip) DO NOTHING
			`, row.IP, row.MAC, row.VLAN, row.SwitchName, row.Port, row.Description, row.Status, row.Zone, row.FWLB, row.Hostname)
			if err != nil {
				errorsOut = append(errorsOut, fmt.Sprintf("%s: %v", row.RowID, err))
				continue
			}
			if cmd.RowsAffected() == 0 {
				errorsOut = append(errorsOut, fmt.Sprintf("%s: endpoint with IP %s already exists", row.RowID, row.IP))
				continue
			}
			added++
		case model.ImportUpdate:
			cmd, err := s.pool.Exec(ctx, `
				UPDATE inventory_endpoint
				SET mac = $2,
					vlan = $3,
					switch_name = $4,
					port = $5,
					description = $6,
					status = $7,
					zone = $8,
					fw_lb = $9,
					hostname = $10,
					updated_at = now()
				WHERE ip = $1::inet
			`, row.IP, row.MAC, row.VLAN, row.SwitchName, row.Port, row.Description, row.Status, row.Zone, row.FWLB, row.Hostname)
			if err != nil {
				errorsOut = append(errorsOut, fmt.Sprintf("%s: %v", row.RowID, err))
				continue
			}
			if cmd.RowsAffected() == 0 {
				errorsOut = append(errorsOut, fmt.Sprintf("%s: endpoint with IP %s not found", row.RowID, row.IP))
				continue
			}
			updated++
		}
	}

	return added, updated, errorsOut
}

func (s *Store) ListGroups(ctx context.Context) ([]model.Group, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT g.id,
		       g.name,
		       g.description,
		       g.created_at,
		       g.updated_at,
		       COALESCE(array_agg(gm.endpoint_id) FILTER (WHERE gm.endpoint_id IS NOT NULL), '{}') AS endpoint_ids
		FROM group_def g
		LEFT JOIN group_member gm ON gm.group_id = g.id
		GROUP BY g.id
		ORDER BY g.name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := []model.Group{}
	for rows.Next() {
		var g model.Group
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt, &g.UpdatedAt, &g.EndpointIDs); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

func (s *Store) CreateGroup(ctx context.Context, name string, description string, endpointIDs []int64) (model.Group, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Group{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	group := model.Group{}
	err = tx.QueryRow(ctx, `
		INSERT INTO group_def(name, description)
		VALUES ($1, $2)
		RETURNING id, name, description, created_at, updated_at
	`, name, description).Scan(&group.ID, &group.Name, &group.Description, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return model.Group{}, err
	}

	endpointIDs = uniqueInt64(endpointIDs)
	for _, endpointID := range endpointIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_member(group_id, endpoint_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, group.ID, endpointID); err != nil {
			return model.Group{}, err
		}
	}
	group.EndpointIDs = endpointIDs

	if err := tx.Commit(ctx); err != nil {
		return model.Group{}, err
	}

	return group, nil
}

func (s *Store) UpdateGroup(ctx context.Context, id int64, name string, description string, endpointIDs []int64) (model.Group, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Group{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	group := model.Group{}
	cmd, err := tx.Exec(ctx, `
		UPDATE group_def
		SET name = $2,
			description = $3,
			updated_at = now()
		WHERE id = $1
	`, id, name, description)
	if err != nil {
		return model.Group{}, err
	}
	if cmd.RowsAffected() == 0 {
		return model.Group{}, pgx.ErrNoRows
	}

	if _, err := tx.Exec(ctx, `DELETE FROM group_member WHERE group_id = $1`, id); err != nil {
		return model.Group{}, err
	}

	endpointIDs = uniqueInt64(endpointIDs)
	for _, endpointID := range endpointIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_member(group_id, endpoint_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, id, endpointID); err != nil {
			return model.Group{}, err
		}
	}

	err = tx.QueryRow(ctx, `
		SELECT id, name, description, created_at, updated_at
		FROM group_def
		WHERE id = $1
	`, id).Scan(&group.ID, &group.Name, &group.Description, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return model.Group{}, err
	}
	group.EndpointIDs = endpointIDs

	if err := tx.Commit(ctx); err != nil {
		return model.Group{}, err
	}

	return group, nil
}

func (s *Store) DeleteGroup(ctx context.Context, id int64) error {
	cmd, err := s.pool.Exec(ctx, `DELETE FROM group_def WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) ListProbeTargets(ctx context.Context, scope string, groupIDs []int64) ([]ProbeTarget, error) {
	query := `
		SELECT DISTINCT ie.id, host(ie.ip), ie.hostname
		FROM inventory_endpoint ie
	`
	args := []any{}

	switch scope {
	case "all":
		query += ` ORDER BY ie.id`
	case "groups":
		if len(groupIDs) == 0 {
			return nil, errors.New("group_ids required for groups scope")
		}
		query += `
			JOIN group_member gm ON gm.endpoint_id = ie.id
			WHERE gm.group_id = ANY($1)
			ORDER BY ie.id
		`
		args = append(args, uniqueInt64(groupIDs))
	default:
		return nil, errors.New("invalid scope")
	}

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	targets := []ProbeTarget{}
	for rows.Next() {
		var t ProbeTarget
		if err := rows.Scan(&t.EndpointID, &t.IP, &t.Hostname); err != nil {
			return nil, err
		}
		targets = append(targets, t)
	}
	return targets, rows.Err()
}

func (s *Store) RecordPingResult(ctx context.Context, result model.PingResult) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	status := "Request Timeout"
	if result.Success {
		status = "Succeeded"
	} else if result.ErrorCode != "" {
		status = result.ErrorCode
	}

	var latencyValue any
	if result.LatencyMs != nil {
		latencyValue = *result.LatencyMs
	}

	var ttlValue any
	if result.TTL != nil {
		ttlValue = *result.TTL
	}

	replyIP := derefString(result.ReplyIP)

	if _, err := tx.Exec(ctx, `
		INSERT INTO ping_raw(ts, endpoint_id, success, latency_ms, reply_ip, ttl, error_code, payload_bytes)
		VALUES ($1::timestamptz, $2::bigint, $3::boolean, $4::double precision, NULLIF($5, '')::inet, $6::int, $7::text, $8::int)
		ON CONFLICT (ts, endpoint_id) DO NOTHING
	`, result.Timestamp, result.EndpointID, result.Success, latencyValue, replyIP, ttlValue, result.ErrorCode, result.PayloadBytes); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO endpoint_stats_current(
			endpoint_id,
			last_failed_on,
			last_success_on,
			success_count,
			failed_count,
			consecutive_failed_count,
			max_consecutive_failed_count,
			max_consecutive_failed_count_time,
			failed_pct,
			total_sent_ping,
			last_ping_status,
			last_ping_latency,
			average_latency,
			reply_ip_address,
			updated_at
		)
		VALUES (
			$1::bigint,
			CASE WHEN $2::boolean = FALSE THEN $3::timestamptz ELSE NULL END,
			CASE WHEN $2::boolean = TRUE THEN $3::timestamptz ELSE NULL END,
			CASE WHEN $2::boolean = TRUE THEN 1 ELSE 0 END,
			CASE WHEN $2::boolean = FALSE THEN 1 ELSE 0 END,
			CASE WHEN $2::boolean = FALSE THEN 1 ELSE 0 END,
			CASE WHEN $2::boolean = FALSE THEN 1 ELSE 0 END,
			CASE WHEN $2::boolean = FALSE THEN $3::timestamptz ELSE NULL END,
			CASE WHEN $2::boolean = FALSE THEN 100 ELSE 0 END,
			1,
			$4::text,
			$5::double precision,
			$5::double precision,
			NULLIF($6, '')::inet,
			now()
		)
		ON CONFLICT (endpoint_id) DO UPDATE SET
			last_failed_on = CASE WHEN $2::boolean = FALSE THEN $3::timestamptz ELSE endpoint_stats_current.last_failed_on END,
			last_success_on = CASE WHEN $2::boolean = TRUE THEN $3::timestamptz ELSE endpoint_stats_current.last_success_on END,
			success_count = endpoint_stats_current.success_count + CASE WHEN $2::boolean = TRUE THEN 1 ELSE 0 END,
			failed_count = endpoint_stats_current.failed_count + CASE WHEN $2::boolean = FALSE THEN 1 ELSE 0 END,
			consecutive_failed_count = CASE WHEN $2::boolean = FALSE THEN endpoint_stats_current.consecutive_failed_count + 1 ELSE 0 END,
			max_consecutive_failed_count = GREATEST(
				endpoint_stats_current.max_consecutive_failed_count,
				CASE WHEN $2::boolean = FALSE THEN endpoint_stats_current.consecutive_failed_count + 1 ELSE endpoint_stats_current.max_consecutive_failed_count END
			),
			max_consecutive_failed_count_time = CASE
				WHEN $2::boolean = FALSE AND endpoint_stats_current.consecutive_failed_count + 1 > endpoint_stats_current.max_consecutive_failed_count THEN $3::timestamptz
				ELSE endpoint_stats_current.max_consecutive_failed_count_time
			END,
			total_sent_ping = endpoint_stats_current.total_sent_ping + 1,
			failed_pct = (
				(endpoint_stats_current.failed_count + CASE WHEN $2::boolean = FALSE THEN 1 ELSE 0 END)::DOUBLE PRECISION /
				(endpoint_stats_current.total_sent_ping + 1)::DOUBLE PRECISION
			) * 100,
			last_ping_status = $4::text,
			last_ping_latency = $5::double precision,
			average_latency = CASE
				WHEN $2::boolean = TRUE AND $5 IS NOT NULL THEN
					(
						(COALESCE(endpoint_stats_current.average_latency, 0) * endpoint_stats_current.success_count) + $5::double precision
					) / (endpoint_stats_current.success_count + 1)
				ELSE endpoint_stats_current.average_latency
			END,
			reply_ip_address = NULLIF($6, '')::inet,
			updated_at = now()
	`, result.EndpointID, result.Success, result.Timestamp, status, latencyValue, replyIP); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) ListMonitorEndpoints(ctx context.Context, filters MonitorFilters) ([]model.MonitorEndpoint, error) {
	query := `
		SELECT
			ie.id,
			ie.hostname,
			es.last_failed_on,
			host(ie.ip) AS ip_address,
			ie.mac,
			COALESCE(host(es.reply_ip_address), NULL) AS reply_ip_address,
			es.last_success_on,
			COALESCE(es.success_count, 0) AS success_count,
			COALESCE(es.failed_count, 0) AS failed_count,
			COALESCE(es.consecutive_failed_count, 0) AS consecutive_failed_count,
			COALESCE(es.max_consecutive_failed_count, 0) AS max_consecutive_failed_count,
			es.max_consecutive_failed_count_time,
			COALESCE(es.failed_pct, 0) AS failed_pct,
			COALESCE(es.total_sent_ping, 0) AS total_sent_ping,
			COALESCE(es.last_ping_status, 'unknown') AS last_ping_status,
			es.last_ping_latency,
			es.average_latency,
			ie.vlan,
			ie.switch_name,
			ie.port,
			COALESCE(array_remove(array_agg(DISTINCT gd.name), NULL), '{}') AS groups
		FROM inventory_endpoint ie
		LEFT JOIN endpoint_stats_current es ON es.endpoint_id = ie.id
		LEFT JOIN group_member gm ON gm.endpoint_id = ie.id
		LEFT JOIN group_def gd ON gd.id = gm.group_id
		WHERE 1=1
	`

	args := []any{}
	if len(filters.VLANs) > 0 {
		query += fmt.Sprintf(" AND ie.vlan = ANY($%d)", len(args)+1)
		args = append(args, filters.VLANs)
	}
	if len(filters.Switches) > 0 {
		query += fmt.Sprintf(" AND ie.switch_name = ANY($%d)", len(args)+1)
		args = append(args, filters.Switches)
	}
	if len(filters.Ports) > 0 {
		query += fmt.Sprintf(" AND ie.port = ANY($%d)", len(args)+1)
		args = append(args, filters.Ports)
	}
	if len(filters.GroupNames) > 0 {
		query += fmt.Sprintf(`
			AND EXISTS (
				SELECT 1
				FROM group_member gm2
				JOIN group_def gd2 ON gd2.id = gm2.group_id
				WHERE gm2.endpoint_id = ie.id
				  AND gd2.name = ANY($%d)
			)
		`, len(args)+1)
		args = append(args, filters.GroupNames)
	}

	query += `
		GROUP BY ie.id, ie.hostname, es.last_failed_on, ie.ip, ie.mac, es.reply_ip_address,
			es.last_success_on, es.success_count, es.failed_count, es.consecutive_failed_count,
			es.max_consecutive_failed_count, es.max_consecutive_failed_count_time, es.failed_pct,
			es.total_sent_ping, es.last_ping_status, es.last_ping_latency, es.average_latency,
			ie.vlan, ie.switch_name, ie.port
		ORDER BY ie.ip
	`

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []model.MonitorEndpoint{}
	for rows.Next() {
		var item model.MonitorEndpoint
		if err := rows.Scan(
			&item.EndpointID,
			&item.Hostname,
			&item.LastFailedOn,
			&item.IPAddress,
			&item.MACAddress,
			&item.ReplyIPAddress,
			&item.LastSuccessOn,
			&item.SuccessCount,
			&item.FailedCount,
			&item.ConsecutiveFailedCount,
			&item.MaxConsecutiveFailed,
			&item.MaxConsecutiveFailedAt,
			&item.FailedPct,
			&item.TotalSentPing,
			&item.LastPingStatus,
			&item.LastPingLatency,
			&item.AverageLatency,
			&item.VLAN,
			&item.Switch,
			&item.Port,
			&item.Groups,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) QueryTimeSeries(ctx context.Context, endpointIDs []int64, start time.Time, end time.Time, rollup string) ([]model.TimeSeriesPoint, error) {
	if len(endpointIDs) == 0 {
		return []model.TimeSeriesPoint{}, nil
	}
	view := "ping_1m"
	if rollup == "1h" {
		view = "ping_1h"
	}

	query := fmt.Sprintf(`
		SELECT endpoint_id, bucket, loss_rate, avg_latency_ms, max_latency_ms, sent_count, fail_count
		FROM %s
		WHERE endpoint_id = ANY($1)
		  AND bucket BETWEEN $2 AND $3
		ORDER BY bucket
	`, view)

	rows, err := s.pool.Query(ctx, query, endpointIDs, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	series := []model.TimeSeriesPoint{}
	for rows.Next() {
		var p model.TimeSeriesPoint
		if err := rows.Scan(&p.EndpointID, &p.Bucket, &p.LossRate, &p.AvgLatencyMs, &p.MaxLatencyMs, &p.SentCount, &p.FailCount); err != nil {
			return nil, err
		}
		series = append(series, p)
	}
	return series, rows.Err()
}

func (s *Store) ListDistinctFilters(ctx context.Context) (map[string][]string, error) {
	out := map[string][]string{
		"vlan":   {},
		"switch": {},
		"port":   {},
		"group":  {},
	}

	if vals, err := scanDistinctText(ctx, s.pool, `SELECT DISTINCT vlan FROM inventory_endpoint WHERE vlan <> '' ORDER BY vlan`); err == nil {
		out["vlan"] = vals
	} else {
		return nil, err
	}
	if vals, err := scanDistinctText(ctx, s.pool, `SELECT DISTINCT switch_name FROM inventory_endpoint WHERE switch_name <> '' ORDER BY switch_name`); err == nil {
		out["switch"] = vals
	} else {
		return nil, err
	}
	if vals, err := scanDistinctText(ctx, s.pool, `SELECT DISTINCT port FROM inventory_endpoint WHERE port <> '' ORDER BY port`); err == nil {
		out["port"] = vals
	} else {
		return nil, err
	}
	if vals, err := scanDistinctText(ctx, s.pool, `SELECT name FROM group_def ORDER BY name`); err == nil {
		out["group"] = vals
	} else {
		return nil, err
	}

	return out, nil
}

func scanDistinctText(ctx context.Context, pool *pgxpool.Pool, query string) ([]string, error) {
	rows, err := pool.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	values := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		values = append(values, strings.TrimSpace(v))
	}
	return values, rows.Err()
}

func uniqueInt64(values []int64) []int64 {
	seen := map[int64]struct{}{}
	out := make([]int64, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
