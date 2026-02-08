package importer

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"

	"sonarscope/backend/internal/model"
)

var requiredHeaders = map[string]string{
	"switch":      "switch",
	"port":        "port",
	"sorting":     "sorting",
	"status":      "status",
	"description": "description",
	"vlan":        "vlan",
	"mac":         "mac",
	"port-type":   "port_type",
	"fw/lb":       "fw_lb",
	"zone":        "zone",
	"ip":          "ip",
}

func Parse(fileName string, raw []byte) ([]model.ImportCandidate, error) {
	ext := strings.ToLower(filepath.Ext(fileName))
	switch ext {
	case ".csv":
		return parseCSV(raw)
	case ".xlsx", ".xlsm", ".xls":
		return parseXLSX(raw)
	default:
		return nil, fmt.Errorf("unsupported file extension %q", ext)
	}
}

func Classify(candidates []model.ImportCandidate, existing map[string]model.InventoryEndpoint) []model.ImportCandidate {
	seenIP := map[string]string{}
	result := make([]model.ImportCandidate, 0, len(candidates))

	for _, candidate := range candidates {
		if candidate.Action == model.ImportInvalid {
			result = append(result, candidate)
			continue
		}

		if priorRow, exists := seenIP[candidate.IP]; exists {
			candidate.Action = model.ImportInvalid
			candidate.Message = fmt.Sprintf("duplicate IP in file (already seen in %s)", priorRow)
			result = append(result, candidate)
			continue
		}
		seenIP[candidate.IP] = candidate.RowID

		existingEndpoint, exists := existing[candidate.IP]
		if !exists {
			candidate.Action = model.ImportAdd
			candidate.Message = "new endpoint"
			result = append(result, candidate)
			continue
		}

		candidate.ExistingID = &existingEndpoint.ID
		if hasDiff(candidate, existingEndpoint) {
			candidate.Action = model.ImportUpdate
			candidate.Message = "existing endpoint changed"
		} else {
			candidate.Action = model.ImportUnchanged
			candidate.Message = "no changes"
		}
		result = append(result, candidate)
	}

	return result
}

func parseCSV(raw []byte) ([]model.ImportCandidate, error) {
	reader := csv.NewReader(bytes.NewReader(raw))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1

	rows := [][]string{}
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read csv: %w", err)
		}
		rows = append(rows, record)
	}

	return parseRows(rows)
}

func parseXLSX(raw []byte) ([]model.ImportCandidate, error) {
	book, err := excelize.OpenReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("open workbook: %w", err)
	}
	defer func() { _ = book.Close() }()

	sheets := book.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("workbook has no sheets")
	}

	rows, err := book.GetRows(sheets[0])
	if err != nil {
		return nil, fmt.Errorf("read worksheet rows: %w", err)
	}

	return parseRows(rows)
}

func parseRows(rows [][]string) ([]model.ImportCandidate, error) {
	if len(rows) == 0 {
		return nil, fmt.Errorf("input is empty")
	}

	headerMap, err := mapHeaders(rows[0])
	if err != nil {
		return nil, err
	}

	result := make([]model.ImportCandidate, 0, len(rows)-1)
	for i, row := range rows[1:] {
		sourceRow := i + 2
		candidate := model.ImportCandidate{
			RowID:     "row-" + strconv.Itoa(sourceRow),
			SourceRow: sourceRow,
			Action:    model.ImportInvalid,
		}

		candidate.IP = cell(row, headerMap["ip"])
		candidate.MAC = normalizeMAC(cell(row, headerMap["mac"]))
		candidate.VLAN = cell(row, headerMap["vlan"])
		candidate.SwitchName = cell(row, headerMap["switch"])
		candidate.Port = cell(row, headerMap["port"])
		candidate.Description = cell(row, headerMap["description"])
		candidate.Status = cell(row, headerMap["status"])
		candidate.Zone = cell(row, headerMap["zone"])
		candidate.FWLB = cell(row, headerMap["fw_lb"])
		candidate.Sorting = cell(row, headerMap["sorting"])
		candidate.PortType = cell(row, headerMap["port_type"])
		candidate.Hostname = cell(row, headerMap["description"])

		if candidate.IP == "" {
			candidate.Message = "missing IP"
			result = append(result, candidate)
			continue
		}
		if net.ParseIP(candidate.IP) == nil {
			candidate.Message = "invalid IP format"
			result = append(result, candidate)
			continue
		}
		candidate.Action = model.ImportAdd
		result = append(result, candidate)
	}

	return result, nil
}

func mapHeaders(headers []string) (map[string]int, error) {
	mapped := map[string]int{}
	for idx, header := range headers {
		normalized := strings.ToLower(strings.TrimSpace(header))
		if key, ok := requiredHeaders[normalized]; ok {
			mapped[key] = idx
		}
	}

	missing := []string{}
	for _, key := range requiredHeaders {
		if _, ok := mapped[key]; !ok {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing headers: %s", strings.Join(missing, ", "))
	}
	return mapped, nil
}

func cell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}

func normalizeMAC(mac string) string {
	mac = strings.TrimSpace(strings.ToUpper(mac))
	if mac == "" {
		return ""
	}
	mac = strings.ReplaceAll(mac, "-", ":")
	return mac
}

func hasDiff(candidate model.ImportCandidate, existing model.InventoryEndpoint) bool {
	if candidate.MAC != existing.MAC {
		return true
	}
	if candidate.VLAN != existing.VLAN {
		return true
	}
	if candidate.SwitchName != existing.SwitchName {
		return true
	}
	if candidate.Port != existing.Port {
		return true
	}
	if candidate.Description != existing.Description {
		return true
	}
	if candidate.Status != existing.Status {
		return true
	}
	if candidate.Zone != existing.Zone {
		return true
	}
	if candidate.FWLB != existing.FWLB {
		return true
	}
	if candidate.Hostname != existing.Hostname {
		return true
	}
	return false
}
