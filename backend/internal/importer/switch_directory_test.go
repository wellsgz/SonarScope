package importer

import (
	"testing"
	"time"

	"sonarscope/backend/internal/model"
)

func TestParseSwitchDirectoryRows(t *testing.T) {
	rows := [][]string{
		{"# Required: name, ip_address"},
		{"name", "ip_address"},
		{"core-1", "10.0.0.10"},
	}

	candidates, err := parseSwitchDirectoryRows(rows)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(candidates))
	}
	if candidates[0].Name != "core-1" || candidates[0].IPAddress != "10.0.0.10" {
		t.Fatalf("unexpected candidate: %#v", candidates[0])
	}
	if candidates[0].Action != model.ImportAdd {
		t.Fatalf("expected add action, got %s", candidates[0].Action)
	}
}

func TestParseSwitchDirectoryRowsInvalidData(t *testing.T) {
	rows := [][]string{
		{"name", "ip_address"},
		{"", "10.0.0.1"},
		{"core-2", "bad-ip"},
	}

	candidates, err := parseSwitchDirectoryRows(rows)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("expected 2 candidates, got %d", len(candidates))
	}
	if candidates[0].Message != "missing switch name" {
		t.Fatalf("unexpected first error: %s", candidates[0].Message)
	}
	if candidates[1].Message != "invalid IP format" {
		t.Fatalf("unexpected second error: %s", candidates[1].Message)
	}
}

func TestClassifySwitchDirectoryImport(t *testing.T) {
	now := time.Now()
	existing := map[string]model.SwitchDirectoryEntry{
		"core-1": {
			ID:        7,
			Name:      "core-1",
			IPAddress: "10.0.0.1",
			CreatedAt: now,
			UpdatedAt: now,
		},
	}

	input := []model.SwitchDirectoryImportCandidate{
		{RowID: "row-2", Name: "core-1", IPAddress: "10.0.0.1", Action: model.ImportAdd},
		{RowID: "row-3", Name: "core-1", IPAddress: "10.0.0.2", Action: model.ImportAdd},
		{RowID: "row-4", Name: "edge-1", IPAddress: "10.0.0.3", Action: model.ImportAdd},
	}

	out := ClassifySwitchDirectoryImport(input, existing)
	if len(out) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(out))
	}
	if out[0].Action != model.ImportUnchanged {
		t.Fatalf("expected unchanged for first row, got %s", out[0].Action)
	}
	if out[1].Action != model.ImportInvalid {
		t.Fatalf("expected duplicate row to be invalid, got %s", out[1].Action)
	}
	if out[2].Action != model.ImportAdd {
		t.Fatalf("expected add for third row, got %s", out[2].Action)
	}
}

func TestClassifySwitchDirectoryImportUpdate(t *testing.T) {
	now := time.Now()
	existing := map[string]model.SwitchDirectoryEntry{
		"core-1": {
			ID:        7,
			Name:      "core-1",
			IPAddress: "10.0.0.1",
			CreatedAt: now,
			UpdatedAt: now,
		},
	}

	input := []model.SwitchDirectoryImportCandidate{
		{RowID: "row-2", Name: "core-1", IPAddress: "10.0.0.2", Action: model.ImportAdd},
	}

	out := ClassifySwitchDirectoryImport(input, existing)
	if len(out) != 1 {
		t.Fatalf("expected 1 row, got %d", len(out))
	}
	if out[0].Action != model.ImportUpdate {
		t.Fatalf("expected update, got %s", out[0].Action)
	}
	if out[0].ExistingID == nil || *out[0].ExistingID != 7 {
		t.Fatalf("expected existing id 7, got %#v", out[0].ExistingID)
	}
}
