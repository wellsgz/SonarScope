package config

import "testing"

func TestValidateSettings(t *testing.T) {
	tests := []struct {
		name        string
		intervalSec int
		payload     int
		autoRefresh int
		wantErr     bool
	}{
		{name: "valid defaults", intervalSec: 1, payload: 56, autoRefresh: 10, wantErr: false},
		{name: "interval too small", intervalSec: 0, payload: 56, autoRefresh: 10, wantErr: true},
		{name: "interval too large", intervalSec: 31, payload: 56, autoRefresh: 10, wantErr: true},
		{name: "payload too small", intervalSec: 1, payload: 1, autoRefresh: 10, wantErr: true},
		{name: "payload too large", intervalSec: 1, payload: 2000, autoRefresh: 10, wantErr: true},
		{name: "auto refresh too small", intervalSec: 1, payload: 56, autoRefresh: 0, wantErr: true},
		{name: "auto refresh too large", intervalSec: 1, payload: 56, autoRefresh: 61, wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateSettings(tc.intervalSec, tc.payload, tc.autoRefresh)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
