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

const noGroupName = "no group"

var (
	ErrReservedGroupName  = errors.New(`group name "no group" is reserved`)
	ErrSystemGroupMutable = errors.New("system group cannot be modified")
)

type MonitorFilters struct {
	VLANs      []string
	Switches   []string
	Ports      []string
	GroupNames []string
}

type MonitorPageQuery struct {
	Filters    MonitorFilters
	Hostname   string
	MAC        string
	IPList     []string
	Page       int
	PageSize   int
	SortBy     string
	SortDir    string
	StatsScope string
	Start      time.Time
	End        time.Time
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
		INSERT INTO app_settings(id, ping_interval_sec, icmp_payload_bytes, icmp_timeout_ms, auto_refresh_sec)
		VALUES (TRUE, $1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING
	`, defaults.PingIntervalSec, defaults.ICMPPayloadSize, defaults.ICMPTimeoutMs, defaults.AutoRefreshSec)
	return err
}

func (s *Store) GetSettings(ctx context.Context) (model.Settings, error) {
	settings := model.Settings{}
	err := s.pool.QueryRow(ctx, `
		SELECT ping_interval_sec, icmp_payload_bytes, icmp_timeout_ms, auto_refresh_sec
		FROM app_settings
		WHERE id = TRUE
	`).Scan(&settings.PingIntervalSec, &settings.ICMPPayloadSize, &settings.ICMPTimeoutMs, &settings.AutoRefreshSec)
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
			icmp_timeout_ms = $3,
			auto_refresh_sec = $4,
			updated_at = now()
		WHERE id = TRUE
	`, settings.PingIntervalSec, settings.ICMPPayloadSize, settings.ICMPTimeoutMs, settings.AutoRefreshSec)
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
		SELECT id, host(ip), mac, vlan, switch_name, port, port_type, description, hostname, updated_at
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
			&endpoint.PortType,
			&endpoint.Description,
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
				INSERT INTO inventory_endpoint(ip, mac, vlan, switch_name, port, port_type, description, hostname, updated_at)
				VALUES ($1::inet, $2, $3, $4, $5, $6, $7, $8, now())
				ON CONFLICT (ip) DO NOTHING
			`, row.IP, row.MAC, row.VLAN, row.SwitchName, row.Port, row.PortType, row.Description, row.Hostname)
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
					port_type = $6,
					description = $7,
					hostname = $8,
					updated_at = now()
				WHERE ip = $1::inet
			`, row.IP, row.MAC, row.VLAN, row.SwitchName, row.Port, row.PortType, row.Description, row.Hostname)
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
		       g.is_system,
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
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.IsSystem, &g.CreatedAt, &g.UpdatedAt, &g.EndpointIDs); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

func (s *Store) CreateGroup(ctx context.Context, name string, description string, endpointIDs []int64) (model.Group, error) {
	if isNoGroupName(name) {
		return model.Group{}, ErrReservedGroupName
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Group{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	group := model.Group{}
	err = tx.QueryRow(ctx, `
		INSERT INTO group_def(name, description)
		VALUES ($1, $2)
		RETURNING id, name, description, is_system, created_at, updated_at
	`, strings.TrimSpace(name), description).Scan(&group.ID, &group.Name, &group.Description, &group.IsSystem, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return model.Group{}, err
	}

	endpointIDs = uniqueInt64(endpointIDs)
	for _, endpointID := range endpointIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_member(group_id, endpoint_id)
			VALUES ($1, $2)
			ON CONFLICT (endpoint_id) DO UPDATE
			SET group_id = EXCLUDED.group_id
			WHERE group_member.group_id IS DISTINCT FROM EXCLUDED.group_id
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

	var isSystem bool
	if err := tx.QueryRow(ctx, `SELECT is_system FROM group_def WHERE id = $1`, id).Scan(&isSystem); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Group{}, pgx.ErrNoRows
		}
		return model.Group{}, err
	}
	if isSystem {
		return model.Group{}, ErrSystemGroupMutable
	}
	if isNoGroupName(name) {
		return model.Group{}, ErrReservedGroupName
	}

	currentEndpointIDs := make([]int64, 0)
	rows, err := tx.Query(ctx, `SELECT endpoint_id FROM group_member WHERE group_id = $1`, id)
	if err != nil {
		return model.Group{}, err
	}
	for rows.Next() {
		var endpointID int64
		if err := rows.Scan(&endpointID); err != nil {
			rows.Close()
			return model.Group{}, err
		}
		currentEndpointIDs = append(currentEndpointIDs, endpointID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return model.Group{}, err
	}
	rows.Close()

	group := model.Group{}
	cmd, err := tx.Exec(ctx, `
		UPDATE group_def
		SET name = $2,
			description = $3,
			updated_at = now()
		WHERE id = $1
	`, id, strings.TrimSpace(name), description)
	if err != nil {
		return model.Group{}, err
	}
	if cmd.RowsAffected() == 0 {
		return model.Group{}, pgx.ErrNoRows
	}

	endpointIDs = uniqueInt64(endpointIDs)
	for _, endpointID := range endpointIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_member(group_id, endpoint_id)
			VALUES ($1, $2)
			ON CONFLICT (endpoint_id) DO UPDATE
			SET group_id = EXCLUDED.group_id
			WHERE group_member.group_id IS DISTINCT FROM EXCLUDED.group_id
		`, id, endpointID); err != nil {
			return model.Group{}, err
		}
	}

	noGroupID, err := getNoGroupIDTx(ctx, tx)
	if err != nil {
		return model.Group{}, err
	}
	removeEndpointIDs := subtractEndpointIDs(currentEndpointIDs, endpointIDs)
	for _, endpointID := range removeEndpointIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO group_member(group_id, endpoint_id)
			VALUES ($1, $2)
			ON CONFLICT (endpoint_id) DO UPDATE
			SET group_id = EXCLUDED.group_id
			WHERE group_member.group_id IS DISTINCT FROM EXCLUDED.group_id
		`, noGroupID, endpointID); err != nil {
			return model.Group{}, err
		}
	}

	err = tx.QueryRow(ctx, `
		SELECT id, name, description, is_system, created_at, updated_at
		FROM group_def
		WHERE id = $1
	`, id).Scan(&group.ID, &group.Name, &group.Description, &group.IsSystem, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return model.Group{}, err
	}
	group.EndpointIDs = endpointIDs

	if err := tx.Commit(ctx); err != nil {
		return model.Group{}, err
	}

	return group, nil
}

func (s *Store) GetGroupByID(ctx context.Context, id int64) (model.Group, error) {
	group := model.Group{}
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, description, is_system, created_at, updated_at
		FROM group_def
		WHERE id = $1
	`, id).Scan(&group.ID, &group.Name, &group.Description, &group.IsSystem, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return model.Group{}, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT endpoint_id
		FROM group_member
		WHERE group_id = $1
		ORDER BY endpoint_id
	`, id)
	if err != nil {
		return model.Group{}, err
	}
	defer rows.Close()

	endpointIDs := make([]int64, 0)
	for rows.Next() {
		var endpointID int64
		if err := rows.Scan(&endpointID); err != nil {
			return model.Group{}, err
		}
		endpointIDs = append(endpointIDs, endpointID)
	}
	if err := rows.Err(); err != nil {
		return model.Group{}, err
	}
	group.EndpointIDs = endpointIDs
	return group, nil
}

func (s *Store) GetGroupByNameCI(ctx context.Context, name string) (model.Group, error) {
	group := model.Group{}
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, description, is_system, created_at, updated_at
		FROM group_def
		WHERE lower(name) = lower($1)
		ORDER BY id
		LIMIT 1
	`, strings.TrimSpace(name)).Scan(&group.ID, &group.Name, &group.Description, &group.IsSystem, &group.CreatedAt, &group.UpdatedAt)
	if err != nil {
		return model.Group{}, err
	}
	return s.GetGroupByID(ctx, group.ID)
}

func (s *Store) GetNoGroup(ctx context.Context) (model.Group, error) {
	return s.GetGroupByNameCI(ctx, noGroupName)
}

func (s *Store) ResolveEndpointIDsByIPs(ctx context.Context, ips []string) ([]int64, error) {
	ips = uniqueStrings(ips)
	if len(ips) == 0 {
		return []int64{}, nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id
		FROM inventory_endpoint
		WHERE host(ip) = ANY($1)
		ORDER BY id
	`, ips)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	endpointIDs := make([]int64, 0, len(ips))
	for rows.Next() {
		var endpointID int64
		if err := rows.Scan(&endpointID); err != nil {
			return nil, err
		}
		endpointIDs = append(endpointIDs, endpointID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return uniqueInt64(endpointIDs), nil
}

func (s *Store) AddEndpointsToGroup(ctx context.Context, groupID int64, endpointIDs []int64) (int64, error) {
	endpointIDs = uniqueInt64(endpointIDs)
	if len(endpointIDs) == 0 {
		return 0, nil
	}

	cmd, err := s.pool.Exec(ctx, `
		INSERT INTO group_member(group_id, endpoint_id)
		SELECT $1, unnest($2::bigint[])
		ON CONFLICT (endpoint_id) DO UPDATE
		SET group_id = EXCLUDED.group_id
		WHERE group_member.group_id IS DISTINCT FROM EXCLUDED.group_id
	`, groupID, endpointIDs)
	if err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
}

func (s *Store) DeleteGroup(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var isSystem bool
	if err := tx.QueryRow(ctx, `SELECT is_system FROM group_def WHERE id = $1`, id).Scan(&isSystem); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pgx.ErrNoRows
		}
		return err
	}
	if isSystem {
		return ErrSystemGroupMutable
	}

	noGroupID, err := getNoGroupIDTx(ctx, tx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE group_member SET group_id = $1 WHERE group_id = $2`, noGroupID, id); err != nil {
		return err
	}

	cmd, err := tx.Exec(ctx, `DELETE FROM group_def WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}

	if err := tx.Commit(ctx); err != nil {
		return err
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
			ie.port_type,
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
			ie.vlan, ie.switch_name, ie.port, ie.port_type
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
			&item.PortType,
			&item.Groups,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ListMonitorEndpointsPage(ctx context.Context, query MonitorPageQuery) ([]model.MonitorEndpoint, int64, error) {
	whereClause, args := buildMonitorWhereClause(query.Filters, query.Hostname, query.MAC, query.IPList)

	countSQL := `SELECT COUNT(*) FROM inventory_endpoint ie` + whereClause
	var totalItems int64
	if err := s.pool.QueryRow(ctx, countSQL, args...).Scan(&totalItems); err != nil {
		return nil, 0, err
	}

	if query.StatsScope == "range" {
		items, err := s.listMonitorEndpointsPageRange(ctx, query, whereClause, args)
		if err != nil {
			return nil, 0, err
		}
		return items, totalItems, nil
	}

	items, err := s.listMonitorEndpointsPageLive(ctx, query, whereClause, args)
	if err != nil {
		return nil, 0, err
	}
	return items, totalItems, nil
}

func (s *Store) listMonitorEndpointsPageLive(ctx context.Context, query MonitorPageQuery, whereClause string, args []any) ([]model.MonitorEndpoint, error) {
	sortExpression, err := monitorSortExpression(query.SortBy)
	if err != nil {
		return nil, err
	}

	orderClause := "ie.ip ASC"
	if sortExpression != "" {
		orderClause = fmt.Sprintf("%s %s NULLS LAST, ie.ip ASC", sortExpression, strings.ToUpper(query.SortDir))
	}

	itemsSQL := `
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
			ie.port_type,
			COALESCE(array_remove(array_agg(DISTINCT gd.name), NULL), '{}') AS groups
		FROM inventory_endpoint ie
		LEFT JOIN endpoint_stats_current es ON es.endpoint_id = ie.id
		LEFT JOIN group_member gm ON gm.endpoint_id = ie.id
		LEFT JOIN group_def gd ON gd.id = gm.group_id
	` + whereClause + `
		GROUP BY ie.id, ie.hostname, es.last_failed_on, ie.ip, ie.mac, es.reply_ip_address,
			es.last_success_on, es.success_count, es.failed_count, es.consecutive_failed_count,
			es.max_consecutive_failed_count, es.max_consecutive_failed_count_time, es.failed_pct,
			es.total_sent_ping, es.last_ping_status, es.last_ping_latency, es.average_latency,
			ie.vlan, ie.switch_name, ie.port, ie.port_type
		ORDER BY ` + orderClause + `
		LIMIT $%d OFFSET $%d
	`

	limitPos := len(args) + 1
	offsetPos := len(args) + 2
	itemsSQL = fmt.Sprintf(itemsSQL, limitPos, offsetPos)
	itemsArgs := append(append([]any{}, args...), query.PageSize, (query.Page-1)*query.PageSize)

	rows, err := s.pool.Query(ctx, itemsSQL, itemsArgs...)
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
			&item.PortType,
			&item.Groups,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}

	return items, rows.Err()
}

func (s *Store) listMonitorEndpointsPageRange(ctx context.Context, query MonitorPageQuery, whereClause string, args []any) ([]model.MonitorEndpoint, error) {
	sortExpression, err := monitorRangeSortExpression(query.SortBy)
	if err != nil {
		return nil, err
	}

	orderClause := "ie.ip ASC"
	if sortExpression != "" {
		orderClause = fmt.Sprintf("%s %s NULLS LAST, ie.ip ASC", sortExpression, strings.ToUpper(query.SortDir))
	}

	viewName := "ping_1m"
	if query.End.Sub(query.Start) > 48*time.Hour {
		viewName = "ping_1h"
	}

	startPos := len(args) + 1
	endPos := len(args) + 2
	limitPos := len(args) + 3
	offsetPos := len(args) + 4

	itemsSQL := fmt.Sprintf(`
		WITH range_stats AS (
			SELECT
				endpoint_id,
				MAX(CASE WHEN (sent_count - fail_count) > 0 THEN bucket END) AS last_success_on,
				MAX(CASE WHEN fail_count > 0 THEN bucket END) AS last_failed_on,
				SUM(sent_count)::BIGINT AS total_sent_ping,
				SUM(fail_count)::BIGINT AS failed_count,
				SUM(sent_count - fail_count)::BIGINT AS success_count,
				CASE
					WHEN SUM(sent_count) > 0
						THEN (SUM(fail_count)::DOUBLE PRECISION / SUM(sent_count)::DOUBLE PRECISION) * 100
					ELSE 0
				END AS failed_pct,
				CASE
					WHEN SUM(GREATEST(sent_count - fail_count, 0)) > 0
						THEN
							SUM(COALESCE(avg_latency_ms, 0) * GREATEST(sent_count - fail_count, 0)::DOUBLE PRECISION) /
							NULLIF(SUM(GREATEST(sent_count - fail_count, 0)), 0)::DOUBLE PRECISION
					ELSE NULL
				END AS average_latency
			FROM %s
			WHERE bucket >= $%d AND bucket <= $%d
			GROUP BY endpoint_id
		)
		SELECT
			ie.id,
			ie.hostname,
			rs.last_failed_on,
			host(ie.ip) AS ip_address,
			ie.mac,
			NULL::text AS reply_ip_address,
			rs.last_success_on,
			COALESCE(rs.success_count, 0) AS success_count,
			COALESCE(rs.failed_count, 0) AS failed_count,
			0::BIGINT AS consecutive_failed_count,
			0::BIGINT AS max_consecutive_failed_count,
			NULL::timestamptz AS max_consecutive_failed_count_time,
			COALESCE(rs.failed_pct, 0) AS failed_pct,
			COALESCE(rs.total_sent_ping, 0) AS total_sent_ping,
			CASE
				WHEN COALESCE(rs.total_sent_ping, 0) > 0 THEN 'Range Aggregate'
				ELSE 'No Data'
			END AS last_ping_status,
			NULL::double precision AS last_ping_latency,
			rs.average_latency,
			ie.vlan,
			ie.switch_name,
			ie.port,
			ie.port_type,
			COALESCE(array_remove(array_agg(DISTINCT gd.name), NULL), '{}') AS groups
		FROM inventory_endpoint ie
		LEFT JOIN range_stats rs ON rs.endpoint_id = ie.id
		LEFT JOIN group_member gm ON gm.endpoint_id = ie.id
		LEFT JOIN group_def gd ON gd.id = gm.group_id
		%s
		GROUP BY ie.id, ie.hostname, ie.ip, ie.mac, ie.vlan, ie.switch_name, ie.port, ie.port_type,
			rs.last_failed_on, rs.last_success_on, rs.success_count, rs.failed_count, rs.failed_pct,
			rs.total_sent_ping, rs.average_latency
		ORDER BY %s
		LIMIT $%d OFFSET $%d
	`, viewName, startPos, endPos, whereClause, orderClause, limitPos, offsetPos)

	itemsArgs := append(append([]any{}, args...), query.Start, query.End, query.PageSize, (query.Page-1)*query.PageSize)

	rows, err := s.pool.Query(ctx, itemsSQL, itemsArgs...)
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
			&item.PortType,
			&item.Groups,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}

	return items, rows.Err()
}

func (s *Store) ListInventoryEndpoints(ctx context.Context, filters MonitorFilters) ([]model.InventoryEndpointView, error) {
	query := `
		SELECT
			ie.id,
			ie.hostname,
			host(ie.ip) AS ip_address,
			ie.mac,
			ie.vlan,
			ie.switch_name,
			ie.port,
			ie.port_type,
			ie.description,
			COALESCE(array_remove(array_agg(DISTINCT gd.name), NULL), '{}') AS groups,
			ie.updated_at
		FROM inventory_endpoint ie
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
		GROUP BY ie.id, ie.hostname, ie.ip, ie.mac, ie.vlan, ie.switch_name, ie.port,
			ie.port_type, ie.description, ie.updated_at
		ORDER BY ie.ip
	`

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []model.InventoryEndpointView{}
	for rows.Next() {
		var item model.InventoryEndpointView
		if err := rows.Scan(
			&item.EndpointID,
			&item.Hostname,
			&item.IPAddress,
			&item.MACAddress,
			&item.VLAN,
			&item.Switch,
			&item.Port,
			&item.PortType,
			&item.Description,
			&item.Groups,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateInventoryEndpoint(ctx context.Context, endpointID int64, patch model.InventoryEndpointUpdate) (model.InventoryEndpointView, error) {
	cmd, err := s.pool.Exec(ctx, `
		UPDATE inventory_endpoint
		SET hostname = $2,
			mac = $3,
			vlan = $4,
			switch_name = $5,
			port = $6,
			port_type = $7,
			description = $8,
			updated_at = now()
		WHERE id = $1
	`, endpointID, patch.Hostname, patch.MACAddress, patch.VLAN, patch.Switch, patch.Port, patch.PortType, patch.Description)
	if err != nil {
		return model.InventoryEndpointView{}, err
	}
	if cmd.RowsAffected() == 0 {
		return model.InventoryEndpointView{}, pgx.ErrNoRows
	}

	return s.GetInventoryEndpointByID(ctx, endpointID)
}

func (s *Store) GetInventoryEndpointByID(ctx context.Context, endpointID int64) (model.InventoryEndpointView, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT
			ie.id,
			ie.hostname,
			host(ie.ip) AS ip_address,
			ie.mac,
			ie.vlan,
			ie.switch_name,
			ie.port,
			ie.port_type,
			ie.description,
			COALESCE(array_remove(array_agg(DISTINCT gd.name), NULL), '{}') AS groups,
			ie.updated_at
		FROM inventory_endpoint ie
		LEFT JOIN group_member gm ON gm.endpoint_id = ie.id
		LEFT JOIN group_def gd ON gd.id = gm.group_id
		WHERE ie.id = $1
		GROUP BY ie.id, ie.hostname, ie.ip, ie.mac, ie.vlan, ie.switch_name, ie.port,
			ie.port_type, ie.description, ie.updated_at
	`, endpointID)

	var item model.InventoryEndpointView
	if err := row.Scan(
		&item.EndpointID,
		&item.Hostname,
		&item.IPAddress,
		&item.MACAddress,
		&item.VLAN,
		&item.Switch,
		&item.Port,
		&item.PortType,
		&item.Description,
		&item.Groups,
		&item.UpdatedAt,
	); err != nil {
		return model.InventoryEndpointView{}, err
	}
	return item, nil
}

func (s *Store) DeleteInventoryEndpointsByGroup(ctx context.Context, groupID int64) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM group_def WHERE id = $1)`, groupID).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 0, pgx.ErrNoRows
	}

	cmd, err := tx.Exec(ctx, `
		DELETE FROM inventory_endpoint ie
		USING group_member gm
		WHERE gm.group_id = $1
		  AND gm.endpoint_id = ie.id
	`, groupID)
	if err != nil {
		return 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
}

func (s *Store) DeleteAllInventoryEndpoints(ctx context.Context) (int64, error) {
	cmd, err := s.pool.Exec(ctx, `DELETE FROM inventory_endpoint`)
	if err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
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

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func buildMonitorWhereClause(filters MonitorFilters, hostname string, mac string, ipList []string) (string, []any) {
	var query strings.Builder
	query.WriteString(" WHERE 1=1")

	args := []any{}
	if len(filters.VLANs) > 0 {
		query.WriteString(fmt.Sprintf(" AND ie.vlan = ANY($%d)", len(args)+1))
		args = append(args, filters.VLANs)
	}
	if len(filters.Switches) > 0 {
		query.WriteString(fmt.Sprintf(" AND ie.switch_name = ANY($%d)", len(args)+1))
		args = append(args, filters.Switches)
	}
	if len(filters.Ports) > 0 {
		query.WriteString(fmt.Sprintf(" AND ie.port = ANY($%d)", len(args)+1))
		args = append(args, filters.Ports)
	}
	if len(filters.GroupNames) > 0 {
		query.WriteString(fmt.Sprintf(`
			AND EXISTS (
				SELECT 1
				FROM group_member gm2
				JOIN group_def gd2 ON gd2.id = gm2.group_id
				WHERE gm2.endpoint_id = ie.id
				  AND gd2.name = ANY($%d)
			)
		`, len(args)+1))
		args = append(args, filters.GroupNames)
	}

	if len(ipList) > 0 {
		query.WriteString(fmt.Sprintf(" AND ie.ip = ANY($%d::inet[])", len(args)+1))
		args = append(args, ipList)
	} else {
		if hostname != "" {
			query.WriteString(fmt.Sprintf(" AND ie.hostname ILIKE $%d", len(args)+1))
			args = append(args, "%"+hostname+"%")
		}
		if mac != "" {
			query.WriteString(fmt.Sprintf(" AND replace(replace(replace(lower(ie.mac), ':', ''), '-', ''), ' ', '') LIKE $%d", len(args)+1))
			args = append(args, "%"+normalizeMACSearchTerm(mac)+"%")
		}
	}

	return query.String(), args
}

func monitorSortExpression(sortBy string) (string, error) {
	switch sortBy {
	case "":
		return "", nil
	case "last_success_on":
		return "es.last_success_on", nil
	case "success_count":
		return "COALESCE(es.success_count, 0)", nil
	case "failed_count":
		return "COALESCE(es.failed_count, 0)", nil
	case "consecutive_failed_count":
		return "COALESCE(es.consecutive_failed_count, 0)", nil
	case "max_consecutive_failed_count":
		return "COALESCE(es.max_consecutive_failed_count, 0)", nil
	case "max_consecutive_failed_count_time":
		return "es.max_consecutive_failed_count_time", nil
	case "failed_pct":
		return "COALESCE(es.failed_pct, 0)", nil
	case "last_ping_latency":
		return "es.last_ping_latency", nil
	case "average_latency":
		return "es.average_latency", nil
	default:
		return "", fmt.Errorf("invalid sort_by")
	}
}

func monitorRangeSortExpression(sortBy string) (string, error) {
	switch sortBy {
	case "":
		return "", nil
	case "last_success_on",
		"success_count",
		"failed_count",
		"failed_pct",
		"average_latency":
		return sortBy, nil
	default:
		return "", fmt.Errorf("invalid sort_by")
	}
}

func normalizeMACSearchTerm(value string) string {
	replacer := strings.NewReplacer(":", "", "-", "", " ", "", "\t", "", "\n", "", "\r", "")
	return replacer.Replace(strings.ToLower(strings.TrimSpace(value)))
}

func isNoGroupName(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), noGroupName)
}

func subtractEndpointIDs(current []int64, next []int64) []int64 {
	if len(current) == 0 {
		return nil
	}
	nextSet := make(map[int64]struct{}, len(next))
	for _, endpointID := range next {
		nextSet[endpointID] = struct{}{}
	}
	removed := make([]int64, 0)
	for _, endpointID := range current {
		if _, keep := nextSet[endpointID]; !keep {
			removed = append(removed, endpointID)
		}
	}
	return uniqueInt64(removed)
}

func getNoGroupIDTx(ctx context.Context, tx pgx.Tx) (int64, error) {
	var noGroupID int64
	if err := tx.QueryRow(ctx, `
		SELECT id
		FROM group_def
		WHERE lower(name) = lower($1)
		ORDER BY id
		LIMIT 1
	`, noGroupName).Scan(&noGroupID); err != nil {
		return 0, err
	}
	return noGroupID, nil
}
