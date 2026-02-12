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
	"unicode"

	"github.com/xuri/excelize/v2"

	"sonarscope/backend/internal/model"
)

var headerAliases = map[string]string{
	"ip":                   "ip",
	"ip_address":           "ip",
	"ipaddress":            "ip",
	"hostname":             "hostname",
	"host":                 "hostname",
	"mac":                  "mac",
	"mac_address":          "mac",
	"macaddress":           "mac",
	"vlan":                 "vlan",
	"switch":               "switch",
	"switch_name":          "switch",
	"switchname":           "switch",
	"port":                 "port",
	"port_type":            "port_type",
	"porttype":             "port_type",
	"description":          "description",
	"desc":                 "description",
	"sorting":              "sorting",
	"sort":                 "sorting",
	"custom_field_1":       "custom_field_1_value",
	"custom_field1":        "custom_field_1_value",
	"custom_field_1_value": "custom_field_1_value",
	"custom_field1_value":  "custom_field_1_value",
	"custom1":              "custom_field_1_value",
	"custom_field_2":       "custom_field_2_value",
	"custom_field2":        "custom_field_2_value",
	"custom_field_2_value": "custom_field_2_value",
	"custom_field2_value":  "custom_field_2_value",
	"custom2":              "custom_field_2_value",
	"custom_field_3":       "custom_field_3_value",
	"custom_field3":        "custom_field_3_value",
	"custom_field_3_value": "custom_field_3_value",
	"custom_field3_value":  "custom_field_3_value",
	"custom3":              "custom_field_3_value",
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

	headerRowIdx := -1
	headerMap := map[string]int{}
	for idx, row := range rows {
		if isCommentOrEmptyRow(row) {
			continue
		}
		mapped, err := mapHeaders(row)
		if err != nil {
			return nil, err
		}
		headerMap = mapped
		headerRowIdx = idx
		break
	}
	if headerRowIdx < 0 {
		return nil, fmt.Errorf("input is empty")
	}

	result := make([]model.ImportCandidate, 0, len(rows)-headerRowIdx-1)
	for i := headerRowIdx + 1; i < len(rows); i++ {
		row := rows[i]
		if isCommentOrEmptyRow(row) {
			continue
		}
		sourceRow := i + 1
		candidate := model.ImportCandidate{
			RowID:     "row-" + strconv.Itoa(sourceRow),
			SourceRow: sourceRow,
			Action:    model.ImportInvalid,
		}

		candidate.IP = cellByKey(row, headerMap, "ip")
		candidate.Hostname = cellByKey(row, headerMap, "hostname")
		candidate.MAC = normalizeMAC(cellByKey(row, headerMap, "mac"))
		candidate.CustomField1Value = cellByKey(row, headerMap, "custom_field_1_value")
		candidate.CustomField2Value = cellByKey(row, headerMap, "custom_field_2_value")
		candidate.CustomField3Value = cellByKey(row, headerMap, "custom_field_3_value")
		candidate.VLAN = cellByKey(row, headerMap, "vlan")
		candidate.SwitchName = cellByKey(row, headerMap, "switch")
		candidate.Port = cellByKey(row, headerMap, "port")
		candidate.PortType = normalizePortType(cellByKey(row, headerMap, "port_type"))
		candidate.Description = cellByKey(row, headerMap, "description")
		candidate.Sorting = cellByKey(row, headerMap, "sorting")

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
		normalized := normalizeHeader(header)
		if key, ok := headerAliases[normalized]; ok {
			if _, exists := mapped[key]; exists {
				continue
			}
			mapped[key] = idx
		}
	}

	if _, ok := mapped["ip"]; !ok {
		return nil, fmt.Errorf("missing headers: ip (or ip_address)")
	}
	return mapped, nil
}

func normalizeHeader(input string) string {
	raw := strings.ToLower(strings.TrimSpace(input))
	if raw == "" {
		return ""
	}
	var b strings.Builder
	lastUnderscore := false
	for _, r := range raw {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteRune('_')
			lastUnderscore = true
		}
	}
	return strings.Trim(b.String(), "_")
}

func isCommentOrEmptyRow(row []string) bool {
	firstNonEmpty := ""
	for _, item := range row {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		firstNonEmpty = trimmed
		break
	}
	if firstNonEmpty == "" {
		return true
	}
	return strings.HasPrefix(firstNonEmpty, "#")
}

func cell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}

func cellByKey(row []string, headerMap map[string]int, key string) string {
	idx, ok := headerMap[key]
	if !ok {
		return ""
	}
	return cell(row, idx)
}

func normalizeMAC(mac string) string {
	mac = strings.TrimSpace(strings.ToUpper(mac))
	if mac == "" {
		return ""
	}
	mac = strings.ReplaceAll(mac, "-", ":")
	return mac
}

func normalizePortType(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func hasDiff(candidate model.ImportCandidate, existing model.InventoryEndpoint) bool {
	if hasProvidedDiff(candidate.MAC, existing.MAC) {
		return true
	}
	if hasProvidedDiff(candidate.CustomField1Value, existing.CustomField1Value) {
		return true
	}
	if hasProvidedDiff(candidate.CustomField2Value, existing.CustomField2Value) {
		return true
	}
	if hasProvidedDiff(candidate.CustomField3Value, existing.CustomField3Value) {
		return true
	}
	if hasProvidedDiff(candidate.VLAN, existing.VLAN) {
		return true
	}
	if hasProvidedDiff(candidate.SwitchName, existing.SwitchName) {
		return true
	}
	if hasProvidedDiff(candidate.Port, existing.Port) {
		return true
	}
	if hasProvidedDiff(candidate.Description, existing.Description) {
		return true
	}
	if hasProvidedDiff(candidate.PortType, existing.PortType) {
		return true
	}
	if hasProvidedDiff(candidate.Hostname, existing.Hostname) {
		return true
	}
	return false
}

func hasProvidedDiff(candidateValue string, existingValue string) bool {
	value := strings.TrimSpace(candidateValue)
	return value != "" && value != existingValue
}
