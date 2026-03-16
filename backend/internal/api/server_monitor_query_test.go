package api

import (
	"net/http"
	"testing"
	"time"
)

func TestParseDashboardLookbackAcceptsAllowedLiveValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		raw      string
		expected time.Duration
	}{
		{name: "default live snapshot", raw: "", expected: 0},
		{name: "30 seconds", raw: "30s", expected: 30 * time.Second},
		{name: "1 minute", raw: "1m", expected: time.Minute},
		{name: "5 minutes", raw: "5m", expected: 5 * time.Minute},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			lookback, parseErr := parseDashboardLookback(tc.raw, "live")
			if parseErr != nil {
				t.Fatalf("expected no parse error, got %+v", parseErr)
			}
			if lookback != tc.expected {
				t.Fatalf("expected %v, got %v", tc.expected, lookback)
			}
		})
	}
}

func TestParseDashboardLookbackRejectsInvalidValues(t *testing.T) {
	t.Parallel()

	tests := []string{"45s", "10m", "0s", "garbage"}
	for _, raw := range tests {
		raw := raw
		t.Run(raw, func(t *testing.T) {
			t.Parallel()

			lookback, parseErr := parseDashboardLookback(raw, "live")
			if parseErr == nil {
				t.Fatalf("expected parse error for %q, got lookback %v", raw, lookback)
			}
			if parseErr.Status != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d", http.StatusBadRequest, parseErr.Status)
			}
			if parseErr.Message != "lookback must be one of 30s, 1m, or 5m" {
				t.Fatalf("unexpected message %q", parseErr.Message)
			}
		})
	}
}

func TestParseDashboardLookbackRejectsRangeScope(t *testing.T) {
	t.Parallel()

	lookback, parseErr := parseDashboardLookback("30s", "range")
	if parseErr == nil {
		t.Fatalf("expected parse error, got lookback %v", lookback)
	}
	if parseErr.Status != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, parseErr.Status)
	}
	if parseErr.Message != "lookback is only supported when stats_scope=live" {
		t.Fatalf("unexpected message %q", parseErr.Message)
	}
}
