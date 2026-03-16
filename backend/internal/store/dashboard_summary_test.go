package store

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"sonarscope/backend/internal/model"
)

func TestBuildDashboardSummaryQueryLiveUsesEndpointStatsCurrent(t *testing.T) {
	query := MonitorPageQuery{
		StatsScope: "live",
	}
	sql, args := buildDashboardSummaryQuery(query, " WHERE ie.vlan = $1", []any{"10"})

	if !strings.Contains(sql, "LEFT JOIN endpoint_stats_current es") {
		t.Fatalf("expected live summary query to use endpoint_stats_current: %s", sql)
	}
	if strings.Contains(sql, "FROM ping_1m") || strings.Contains(sql, "FROM ping_1h") {
		t.Fatalf("expected live summary query to avoid range rollups: %s", sql)
	}
	if !strings.Contains(sql, "UNION ALL") {
		t.Fatalf("expected combined summary query to use UNION ALL: %s", sql)
	}

	wantArgs := []any{"10"}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestBuildDashboardSummaryQueryRangeUsesPing1m(t *testing.T) {
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(24 * time.Hour)
	query := MonitorPageQuery{
		StatsScope: "range",
		Start:      start,
		End:        end,
	}
	sql, args := buildDashboardSummaryQuery(query, " WHERE ie.vlan = $1", []any{"10"})

	if !strings.Contains(sql, "FROM ping_1m") {
		t.Fatalf("expected short range summary query to use ping_1m: %s", sql)
	}
	if strings.Contains(sql, "FROM ping_1h") {
		t.Fatalf("expected short range summary query to avoid ping_1h: %s", sql)
	}

	wantArgs := []any{"10", start, end}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestBuildDashboardSummaryQueryRangeUsesPing1h(t *testing.T) {
	start := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(72 * time.Hour)
	query := MonitorPageQuery{
		StatsScope: "range",
		Start:      start,
		End:        end,
	}
	sql, args := buildDashboardSummaryQuery(query, "", nil)

	if !strings.Contains(sql, "FROM ping_1h") {
		t.Fatalf("expected long range summary query to use ping_1h: %s", sql)
	}

	wantArgs := []any{start, end}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestDashboardSummaryFromQueryRows(t *testing.T) {
	tests := []struct {
		name    string
		rows    []dashboardSummaryQueryRow
		want    model.DashboardUnreachableSummary
		wantErr string
	}{
		{
			name: "live summary with multiple switches",
			rows: []dashboardSummaryQueryRow{
				{RowType: "summary", TotalUnreachable: 5, TotalSwitchCount: 2},
				{RowType: "switch", SwitchName: "core-a", UnreachableCount: 3},
				{RowType: "switch", SwitchName: "core-b", UnreachableCount: 2},
			},
			want: model.DashboardUnreachableSummary{
				TotalUnreachable: 5,
				TotalSwitchCount: 2,
				BySwitch: []model.SwitchUnreachableCount{
					{SwitchName: "core-a", UnreachableCount: 3},
					{SwitchName: "core-b", UnreachableCount: 2},
				},
			},
		},
		{
			name: "range summary includes unassigned switch bucket",
			rows: []dashboardSummaryQueryRow{
				{RowType: "summary", TotalUnreachable: 4, TotalSwitchCount: 2},
				{RowType: "switch", SwitchName: "Unassigned", UnreachableCount: 3},
				{RowType: "switch", SwitchName: "edge-01", UnreachableCount: 1},
			},
			want: model.DashboardUnreachableSummary{
				TotalUnreachable: 4,
				TotalSwitchCount: 2,
				BySwitch: []model.SwitchUnreachableCount{
					{SwitchName: "Unassigned", UnreachableCount: 3},
					{SwitchName: "edge-01", UnreachableCount: 1},
				},
			},
		},
		{
			name: "summary with more than ten switches preserves top ten and total switch count",
			rows: []dashboardSummaryQueryRow{
				{RowType: "summary", TotalUnreachable: 36, TotalSwitchCount: 12},
				{RowType: "switch", SwitchName: "sw-01", UnreachableCount: 6},
				{RowType: "switch", SwitchName: "sw-02", UnreachableCount: 5},
				{RowType: "switch", SwitchName: "sw-03", UnreachableCount: 4},
				{RowType: "switch", SwitchName: "sw-04", UnreachableCount: 4},
				{RowType: "switch", SwitchName: "sw-05", UnreachableCount: 3},
				{RowType: "switch", SwitchName: "sw-06", UnreachableCount: 3},
				{RowType: "switch", SwitchName: "sw-07", UnreachableCount: 3},
				{RowType: "switch", SwitchName: "sw-08", UnreachableCount: 3},
				{RowType: "switch", SwitchName: "sw-09", UnreachableCount: 2},
				{RowType: "switch", SwitchName: "sw-10", UnreachableCount: 2},
			},
			want: model.DashboardUnreachableSummary{
				TotalUnreachable: 36,
				TotalSwitchCount: 12,
				BySwitch: []model.SwitchUnreachableCount{
					{SwitchName: "sw-01", UnreachableCount: 6},
					{SwitchName: "sw-02", UnreachableCount: 5},
					{SwitchName: "sw-03", UnreachableCount: 4},
					{SwitchName: "sw-04", UnreachableCount: 4},
					{SwitchName: "sw-05", UnreachableCount: 3},
					{SwitchName: "sw-06", UnreachableCount: 3},
					{SwitchName: "sw-07", UnreachableCount: 3},
					{SwitchName: "sw-08", UnreachableCount: 3},
					{SwitchName: "sw-09", UnreachableCount: 2},
					{SwitchName: "sw-10", UnreachableCount: 2},
				},
			},
		},
		{
			name: "empty summary returns zero totals",
			rows: []dashboardSummaryQueryRow{
				{RowType: "summary", TotalUnreachable: 0, TotalSwitchCount: 0},
			},
			want: model.DashboardUnreachableSummary{
				TotalUnreachable: 0,
				TotalSwitchCount: 0,
				BySwitch:         nil,
			},
		},
		{
			name: "unknown row type returns error",
			rows: []dashboardSummaryQueryRow{
				{RowType: "summary", TotalUnreachable: 1, TotalSwitchCount: 1},
				{RowType: "mystery", SwitchName: "core-a", UnreachableCount: 1},
			},
			wantErr: `unexpected dashboard summary row type "mystery"`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := dashboardSummaryFromQueryRows(tc.rows)
			if tc.wantErr != "" {
				if err == nil || err.Error() != tc.wantErr {
					t.Fatalf("expected error %q, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("unexpected summary: got %#v want %#v", got, tc.want)
			}
		})
	}
}
