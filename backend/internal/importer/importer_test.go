package importer

import (
	"testing"
	"time"

	"sonarscope/backend/internal/model"
)

func TestClassify(t *testing.T) {
	now := time.Now()
	existing := map[string]model.InventoryEndpoint{
		"10.0.0.1": {
			ID:          10,
			IP:          "10.0.0.1",
			MAC:         "AA:BB:CC:DD:EE:FF",
			VLAN:        "100",
			SwitchName:  "sw1",
			Port:        "1/1",
			Description: "db",
			Status:      "up",
			Zone:        "prod",
			FWLB:        "fw1",
			Hostname:    "db1",
			UpdatedAt:   now,
		},
	}

	input := []model.ImportCandidate{
		{RowID: "row-2", IP: "10.0.0.2", MAC: "11:22", VLAN: "200", SwitchName: "sw2", Port: "1/2", Action: model.ImportAdd},
		{RowID: "row-3", IP: "10.0.0.1", MAC: "AA:BB:CC:DD:EE:FF", VLAN: "100", SwitchName: "sw1", Port: "1/1", Description: "db", Status: "up", Zone: "prod", FWLB: "fw1", Hostname: "db1", Action: model.ImportAdd},
		{RowID: "row-4", IP: "10.0.0.1", MAC: "AA:BB:CC:DD:EE:01", VLAN: "100", SwitchName: "sw1", Port: "1/1", Description: "db", Status: "up", Zone: "prod", FWLB: "fw1", Hostname: "db1", Action: model.ImportAdd},
	}

	out := Classify(input, existing)
	if len(out) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(out))
	}

	if out[0].Action != model.ImportAdd {
		t.Fatalf("row 1 expected add, got %s", out[0].Action)
	}
	if out[1].Action != model.ImportUnchanged {
		t.Fatalf("row 2 expected unchanged, got %s", out[1].Action)
	}
	if out[2].Action != model.ImportInvalid {
		t.Fatalf("row 3 expected invalid duplicate, got %s", out[2].Action)
	}
}

func TestParseRowsMissingIP(t *testing.T) {
	rows := [][]string{
		{"Switch", "Port", "Sorting", "Status", "Description", "VLAN", "MAC", "Port-Type", "FW/LB", "Zone", "IP"},
		{"sw", "1/1", "", "", "", "", "", "", "", "", ""},
	}

	candidates, err := parseRows(rows)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(candidates))
	}
	if candidates[0].Action != model.ImportInvalid {
		t.Fatalf("expected invalid action, got %s", candidates[0].Action)
	}
}
