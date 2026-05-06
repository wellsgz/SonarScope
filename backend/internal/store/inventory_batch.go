package store

import (
	"context"
	"fmt"
	"net"
	"strings"

	"sonarscope/backend/internal/model"
)

const inventoryBatchPreviewLimit = 50
const inventoryBatchUnmatchedSampleLimit = 10

func inventoryBatchFieldExpression(field model.InventoryBatchMatchField) (string, error) {
	switch field {
	case model.InventoryBatchMatchFieldHostname:
		return "ie.hostname", nil
	case model.InventoryBatchMatchFieldIPAddress:
		return "host(ie.ip)", nil
	case model.InventoryBatchMatchFieldMACAddress:
		return "ie.mac", nil
	case model.InventoryBatchMatchFieldVLAN:
		return "ie.vlan", nil
	case model.InventoryBatchMatchFieldZone:
		return "ie.zone", nil
	case model.InventoryBatchMatchFieldSwitch:
		return "ie.switch_name", nil
	case model.InventoryBatchMatchFieldPort:
		return "ie.port", nil
	case model.InventoryBatchMatchFieldPortType:
		return "ie.port_type", nil
	case model.InventoryBatchMatchFieldGateway:
		return "host(ie.gateway)", nil
	case model.InventoryBatchMatchFieldMgmtIP:
		return "host(ie.mgmt_ip)", nil
	case model.InventoryBatchMatchFieldSpeed:
		return "ie.speed", nil
	case model.InventoryBatchMatchFieldDuplex:
		return "ie.duplex", nil
	case model.InventoryBatchMatchFieldDescription:
		return "ie.description", nil
	case model.InventoryBatchMatchFieldCustom1:
		return "ie.custom_field_1_value", nil
	case model.InventoryBatchMatchFieldCustom2:
		return "ie.custom_field_2_value", nil
	case model.InventoryBatchMatchFieldCustom3:
		return "ie.custom_field_3_value", nil
	case model.InventoryBatchMatchFieldCustom4:
		return "ie.custom_field_4_value", nil
	case model.InventoryBatchMatchFieldCustom5:
		return "ie.custom_field_5_value", nil
	case model.InventoryBatchMatchFieldCustom6:
		return "ie.custom_field_6_value", nil
	case model.InventoryBatchMatchFieldCustom7:
		return "ie.custom_field_7_value", nil
	case model.InventoryBatchMatchFieldCustom8:
		return "ie.custom_field_8_value", nil
	case model.InventoryBatchMatchFieldCustom9:
		return "ie.custom_field_9_value", nil
	case model.InventoryBatchMatchFieldCustom10:
		return "ie.custom_field_10_value", nil
	default:
		return "", fmt.Errorf("unsupported match field %q", field)
	}
}

func (s *Store) ResolveInventoryBatchMatch(
	ctx context.Context,
	spec model.InventoryBatchMatchSpec,
) (model.InventoryBatchMatchStats, []int64, error) {
	switch spec.Mode {
	case model.InventoryBatchMatchModeCriteria:
		return s.resolveInventoryBatchCriteria(ctx, spec.Field, spec.Regex)
	case model.InventoryBatchMatchModeIPList:
		return s.resolveInventoryBatchIPList(ctx, spec.IPs)
	default:
		return model.InventoryBatchMatchStats{}, nil, fmt.Errorf("unsupported match mode %q", spec.Mode)
	}
}

func (s *Store) ResolveGroupInventoryBatchMatch(
	ctx context.Context,
	groupID int64,
	spec model.InventoryBatchMatchSpec,
) (model.InventoryBatchMatchStats, []int64, error) {
	switch spec.Mode {
	case model.InventoryBatchMatchModeCriteria:
		return s.resolveGroupInventoryBatchCriteria(ctx, groupID, spec.Field, spec.Regex)
	case model.InventoryBatchMatchModeIPList:
		return s.resolveGroupInventoryBatchIPList(ctx, groupID, spec.IPs)
	default:
		return model.InventoryBatchMatchStats{}, nil, fmt.Errorf("unsupported match mode %q", spec.Mode)
	}
}

func (s *Store) resolveInventoryBatchCriteria(
	ctx context.Context,
	field model.InventoryBatchMatchField,
	pattern string,
) (model.InventoryBatchMatchStats, []int64, error) {
	fieldExpr, err := inventoryBatchFieldExpression(field)
	if err != nil {
		return model.InventoryBatchMatchStats{}, nil, err
	}

	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT ie.id
		FROM inventory_endpoint ie
		WHERE COALESCE(%s, '') ~* $1
		ORDER BY ie.id
	`, fieldExpr), pattern)
	if err != nil {
		return model.InventoryBatchMatchStats{}, nil, err
	}
	defer rows.Close()

	endpointIDs := make([]int64, 0)
	for rows.Next() {
		var endpointID int64
		if err := rows.Scan(&endpointID); err != nil {
			return model.InventoryBatchMatchStats{}, nil, err
		}
		endpointIDs = append(endpointIDs, endpointID)
	}
	if err := rows.Err(); err != nil {
		return model.InventoryBatchMatchStats{}, nil, err
	}

	endpointIDs = uniqueInt64(endpointIDs)
	return model.InventoryBatchMatchStats{
		Mode:         model.InventoryBatchMatchModeCriteria,
		MatchedCount: len(endpointIDs),
	}, endpointIDs, nil
}

func (s *Store) resolveGroupInventoryBatchCriteria(
	ctx context.Context,
	groupID int64,
	field model.InventoryBatchMatchField,
	pattern string,
) (model.InventoryBatchMatchStats, []int64, error) {
	fieldExpr, err := inventoryBatchFieldExpression(field)
	if err != nil {
		return model.InventoryBatchMatchStats{}, nil, err
	}

	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT ie.id
		FROM inventory_endpoint ie
		JOIN group_member gm ON gm.endpoint_id = ie.id
		WHERE gm.group_id = $1
		  AND COALESCE(%s, '') ~* $2
		ORDER BY ie.id
	`, fieldExpr), groupID, pattern)
	if err != nil {
		return model.InventoryBatchMatchStats{}, nil, err
	}
	defer rows.Close()

	endpointIDs := make([]int64, 0)
	for rows.Next() {
		var endpointID int64
		if err := rows.Scan(&endpointID); err != nil {
			return model.InventoryBatchMatchStats{}, nil, err
		}
		endpointIDs = append(endpointIDs, endpointID)
	}
	if err := rows.Err(); err != nil {
		return model.InventoryBatchMatchStats{}, nil, err
	}

	endpointIDs = uniqueInt64(endpointIDs)
	return model.InventoryBatchMatchStats{
		Mode:         model.InventoryBatchMatchModeCriteria,
		MatchedCount: len(endpointIDs),
	}, endpointIDs, nil
}

func (s *Store) resolveInventoryBatchIPList(
	ctx context.Context,
	ips []string,
) (model.InventoryBatchMatchStats, []int64, error) {
	submittedCount := 0
	for _, value := range ips {
		if strings.TrimSpace(value) != "" {
			submittedCount++
		}
	}

	uniqueIPs := uniqueStrings(ips)
	validIPs := make([]string, 0, len(uniqueIPs))
	invalidCount := 0
	for _, ip := range uniqueIPs {
		if net.ParseIP(ip) == nil {
			invalidCount++
			continue
		}
		validIPs = append(validIPs, ip)
	}

	matchedIDs := make([]int64, 0, len(validIPs))
	matchedByIP := map[string]struct{}{}
	if len(validIPs) > 0 {
		rows, err := s.pool.Query(ctx, `
			SELECT host(ip) AS ip_address, id
			FROM inventory_endpoint
			WHERE host(ip) = ANY($1)
			ORDER BY id
		`, validIPs)
		if err != nil {
			return model.InventoryBatchMatchStats{}, nil, err
		}
		defer rows.Close()

		for rows.Next() {
			var endpointID int64
			var ip string
			if err := rows.Scan(&ip, &endpointID); err != nil {
				return model.InventoryBatchMatchStats{}, nil, err
			}
			matchedByIP[ip] = struct{}{}
			matchedIDs = append(matchedIDs, endpointID)
		}
		if err := rows.Err(); err != nil {
			return model.InventoryBatchMatchStats{}, nil, err
		}
	}

	unmatched := make([]string, 0)
	for _, ip := range validIPs {
		if _, ok := matchedByIP[ip]; ok {
			continue
		}
		unmatched = append(unmatched, ip)
	}

	matchedIDs = uniqueInt64(matchedIDs)
	stats := model.InventoryBatchMatchStats{
		Mode:            model.InventoryBatchMatchModeIPList,
		SubmittedCount:  submittedCount,
		UniqueCount:     len(uniqueIPs),
		InvalidCount:    invalidCount,
		MatchedCount:    len(matchedIDs),
		UnmatchedCount:  len(unmatched),
		UnmatchedSample: append([]string(nil), unmatched[:minInt(len(unmatched), inventoryBatchUnmatchedSampleLimit)]...),
	}
	return stats, matchedIDs, nil
}

func (s *Store) resolveGroupInventoryBatchIPList(
	ctx context.Context,
	groupID int64,
	ips []string,
) (model.InventoryBatchMatchStats, []int64, error) {
	submittedCount := 0
	for _, value := range ips {
		if strings.TrimSpace(value) != "" {
			submittedCount++
		}
	}

	uniqueIPs := uniqueStrings(ips)
	validIPs := make([]string, 0, len(uniqueIPs))
	invalidCount := 0
	for _, ip := range uniqueIPs {
		if net.ParseIP(ip) == nil {
			invalidCount++
			continue
		}
		validIPs = append(validIPs, ip)
	}

	matchedIDs := make([]int64, 0, len(validIPs))
	matchedByIP := map[string]struct{}{}
	if len(validIPs) > 0 {
		rows, err := s.pool.Query(ctx, `
			SELECT host(ie.ip) AS ip_address, ie.id
			FROM inventory_endpoint ie
			JOIN group_member gm ON gm.endpoint_id = ie.id
			WHERE gm.group_id = $2
			  AND host(ie.ip) = ANY($1)
			ORDER BY ie.id
		`, validIPs, groupID)
		if err != nil {
			return model.InventoryBatchMatchStats{}, nil, err
		}
		defer rows.Close()

		for rows.Next() {
			var endpointID int64
			var ip string
			if err := rows.Scan(&ip, &endpointID); err != nil {
				return model.InventoryBatchMatchStats{}, nil, err
			}
			matchedByIP[ip] = struct{}{}
			matchedIDs = append(matchedIDs, endpointID)
		}
		if err := rows.Err(); err != nil {
			return model.InventoryBatchMatchStats{}, nil, err
		}
	}

	unmatched := make([]string, 0)
	for _, ip := range validIPs {
		if _, ok := matchedByIP[ip]; ok {
			continue
		}
		unmatched = append(unmatched, ip)
	}

	matchedIDs = uniqueInt64(matchedIDs)
	stats := model.InventoryBatchMatchStats{
		Mode:            model.InventoryBatchMatchModeIPList,
		SubmittedCount:  submittedCount,
		UniqueCount:     len(uniqueIPs),
		InvalidCount:    invalidCount,
		MatchedCount:    len(matchedIDs),
		UnmatchedCount:  len(unmatched),
		UnmatchedSample: append([]string(nil), unmatched[:minInt(len(unmatched), inventoryBatchUnmatchedSampleLimit)]...),
	}
	return stats, matchedIDs, nil
}

func (s *Store) ListInventoryEndpointsByIDs(
	ctx context.Context,
	endpointIDs []int64,
	limit int,
) ([]model.InventoryEndpointView, error) {
	endpointIDs = uniqueInt64(endpointIDs)
	if len(endpointIDs) == 0 {
		return []model.InventoryEndpointView{}, nil
	}
	if limit <= 0 {
		limit = inventoryBatchPreviewLimit
	}

	rows, err := s.pool.Query(ctx, `
		SELECT
			ie.id,
				ie.hostname,
				host(ie.ip) AS ip_address,
				ie.mac,
				`+customFieldValueColumns("ie")+`,
				ie.vlan,
				ie.zone,
				ie.switch_name,
				ie.port,
				ie.port_type,
				COALESCE(host(ie.gateway), '') AS gateway,
				COALESCE(host(ie.mgmt_ip), '') AS mgmt_ip,
				ie.speed,
				ie.duplex,
				ie.description,
			COALESCE(array_remove(array_agg(DISTINCT gd.name), NULL), '{}') AS groups,
			ie.is_active,
			ie.updated_at
		FROM inventory_endpoint ie
		LEFT JOIN group_member gm ON gm.endpoint_id = ie.id
		LEFT JOIN group_def gd ON gd.id = gm.group_id
		WHERE ie.id = ANY($1)
			GROUP BY ie.id, ie.hostname, ie.ip, ie.mac, ie.vlan, ie.zone, ie.switch_name, ie.port,
				ie.port_type, ie.gateway, ie.mgmt_ip, ie.speed, ie.duplex, ie.description, ie.is_active, ie.updated_at,
				`+customFieldValueColumns("ie")+`
		ORDER BY ie.ip
		LIMIT $2
	`, endpointIDs, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]model.InventoryEndpointView, 0, minInt(len(endpointIDs), limit))
	for rows.Next() {
		var item model.InventoryEndpointView
		scanTargets := []any{
			&item.EndpointID,
			&item.Hostname,
			&item.IPAddress,
			&item.MACAddress,
		}
		scanTargets = append(scanTargets, inventoryEndpointViewCustomFieldScanTargets(&item)...)
		scanTargets = append(scanTargets,
			&item.VLAN,
			&item.Zone,
			&item.Switch,
			&item.Port,
			&item.PortType,
			&item.Gateway,
			&item.MgmtIP,
			&item.Speed,
			&item.Duplex,
			&item.Description,
			&item.Groups,
			&item.Active,
			&item.UpdatedAt,
		)
		if err := rows.Scan(scanTargets...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ResolveExistingInventoryEndpointIDs(ctx context.Context, endpointIDs []int64) ([]int64, error) {
	endpointIDs = uniqueInt64(endpointIDs)
	if len(endpointIDs) == 0 {
		return []int64{}, nil
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id
		FROM inventory_endpoint
		WHERE id = ANY($1)
		ORDER BY id
	`, endpointIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	existing := make([]int64, 0, len(endpointIDs))
	for rows.Next() {
		var endpointID int64
		if err := rows.Scan(&endpointID); err != nil {
			return nil, err
		}
		existing = append(existing, endpointID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return existing, nil
}

func (s *Store) CountInventoryEndpointsInGroup(ctx context.Context, endpointIDs []int64, groupID int64) (int64, error) {
	endpointIDs = uniqueInt64(endpointIDs)
	if len(endpointIDs) == 0 {
		return 0, nil
	}

	var count int64
	err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM group_member
		WHERE group_id = $2
		  AND endpoint_id = ANY($1)
	`, endpointIDs, groupID).Scan(&count)
	return count, err
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
