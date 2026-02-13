package store

import "testing"

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
