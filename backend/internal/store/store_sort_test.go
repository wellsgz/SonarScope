package store

import (
	"reflect"
	"strings"
	"testing"
)

func TestBuildMonitorOrderClause(t *testing.T) {
	tests := []struct {
		name           string
		sortBy         string
		sortDir        string
		sortExpression string
		want           string
	}{
		{
			name:           "no sort expression falls back to ip",
			sortBy:         "",
			sortDir:        "",
			sortExpression: "",
			want:           "ie.ip ASC",
		},
		{
			name:           "last_success_on asc uses nulls first",
			sortBy:         "last_success_on",
			sortDir:        "asc",
			sortExpression: "es.last_success_on",
			want:           "es.last_success_on ASC NULLS FIRST, ie.ip ASC",
		},
		{
			name:           "last_success_on desc uses nulls last",
			sortBy:         "last_success_on",
			sortDir:        "desc",
			sortExpression: "es.last_success_on",
			want:           "es.last_success_on DESC NULLS LAST, ie.ip ASC",
		},
		{
			name:           "other field asc keeps nulls last",
			sortBy:         "failed_count",
			sortDir:        "asc",
			sortExpression: "COALESCE(es.failed_count, 0)",
			want:           "COALESCE(es.failed_count, 0) ASC NULLS LAST, ie.ip ASC",
		},
		{
			name:           "other field desc keeps nulls last",
			sortBy:         "failed_count",
			sortDir:        "desc",
			sortExpression: "COALESCE(es.failed_count, 0)",
			want:           "COALESCE(es.failed_count, 0) DESC NULLS LAST, ie.ip ASC",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := buildMonitorOrderClause(tc.sortBy, tc.sortDir, tc.sortExpression)
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
	)

	if !contains(whereClause, "ie.hostname ILIKE") || !contains(whereClause, "replace(replace(replace(lower(ie.mac)") || !contains(whereClause, "ie.custom_field_1_value ILIKE") {
		t.Fatalf("unexpected where clause: %s", whereClause)
	}

	wantArgs := []any{"%host-a%", "%aabb%", "%custom-one%"}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func contains(value string, fragment string) bool {
	return strings.Contains(value, fragment)
}
