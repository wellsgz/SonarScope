package store

import (
	"reflect"
	"strings"
	"testing"
)

func TestBuildMonitorOrderClause(t *testing.T) {
	tests := []struct {
		name     string
		criteria []MonitorSortCriterion
		want     string
	}{
		{
			name:     "no sort expression falls back to ip",
			criteria: nil,
			want:     "ie.ip ASC",
		},
		{
			name: "last_success_on asc uses nulls first",
			criteria: []MonitorSortCriterion{
				{Field: "last_success_on", Dir: "asc"},
			},
			want: "es.last_success_on ASC NULLS FIRST, ie.ip ASC",
		},
		{
			name: "last_success_on desc uses nulls last",
			criteria: []MonitorSortCriterion{
				{Field: "last_success_on", Dir: "desc"},
			},
			want: "es.last_success_on DESC NULLS LAST, ie.ip ASC",
		},
		{
			name: "other field asc keeps nulls last",
			criteria: []MonitorSortCriterion{
				{Field: "failed_count", Dir: "asc"},
			},
			want: "COALESCE(es.failed_count, 0) ASC NULLS LAST, ie.ip ASC",
		},
		{
			name: "other field desc keeps nulls last",
			criteria: []MonitorSortCriterion{
				{Field: "failed_count", Dir: "desc"},
			},
			want: "COALESCE(es.failed_count, 0) DESC NULLS LAST, ie.ip ASC",
		},
		{
			name: "multiple criteria append in order",
			criteria: []MonitorSortCriterion{
				{Field: "failed_count", Dir: "desc"},
				{Field: "last_ping_status", Dir: "asc"},
			},
			want: "COALESCE(es.failed_count, 0) DESC NULLS LAST, lower(COALESCE(es.last_ping_status, 'unknown')) ASC NULLS LAST, ie.ip ASC",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := buildMonitorOrderClause(tc.criteria, monitorSortExpression)
			if err != nil {
				t.Fatalf("buildMonitorOrderClause returned error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("unexpected order clause: got %q want %q", got, tc.want)
			}
		})
	}
}

func TestBuildMonitorWhereClauseWithIPListOverridesTextSearches(t *testing.T) {
	whereClause, args := buildMonitorWhereClause(
		MonitorFilters{
			VLANs:      []string{"10"},
			Switches:   []string{"core-1"},
			Ports:      []string{"Gi1/0/1"},
			GroupNames: []string{"DC"},
		},
		"host-a",
		"aa-bb",
		"custom-one",
		"custom-two",
		"custom-three",
		[]string{"10.0.0.1", "10.0.0.2"},
		nil,
	)

	if contains(whereClause, "ie.hostname ILIKE") || contains(whereClause, "ie.custom_field_1_value ILIKE") || contains(whereClause, "ie.ip = ANY") == false {
		t.Fatalf("unexpected where clause: %s", whereClause)
	}

	wantArgs := []any{
		[]string{"10"},
		[]string{"core-1"},
		[]string{"Gi1/0/1"},
		[]string{"DC"},
		[]string{"10.0.0.1", "10.0.0.2"},
	}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestBuildMonitorWhereClauseUsesTextSearchesWithoutIPList(t *testing.T) {
	whereClause, args := buildMonitorWhereClause(
		MonitorFilters{},
		"host-a",
		"aa-bb",
		"custom-one",
		"",
		"",
		nil,
		nil,
	)

	if !contains(whereClause, "ie.hostname ILIKE") || !contains(whereClause, "replace(replace(replace(lower(ie.mac)") || !contains(whereClause, "ie.custom_field_1_value ILIKE") {
		t.Fatalf("unexpected where clause: %s", whereClause)
	}

	wantArgs := []any{"%host-a%", "%aabb%", "%custom-one%"}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestBuildMonitorWhereClauseExcludesEndpointIDs(t *testing.T) {
	whereClause, args := buildMonitorWhereClause(
		MonitorFilters{},
		"",
		"",
		"",
		"",
		"",
		nil,
		[]int64{10, 12},
	)

	if !contains(whereClause, "NOT (ie.id = ANY($1::bigint[]))") {
		t.Fatalf("unexpected where clause: %s", whereClause)
	}

	wantArgs := []any{[]int64{10, 12}}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func contains(value string, fragment string) bool {
	return strings.Contains(value, fragment)
}
