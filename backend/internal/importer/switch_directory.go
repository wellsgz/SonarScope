package importer

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"net"
	"strconv"

	"sonarscope/backend/internal/model"
)

var switchDirectoryHeaderAliases = map[string]string{
	"name":        "name",
	"switch":      "name",
	"switch_name": "name",
	"switchname":  "name",
	"ip":          "ip_address",
	"ip_address":  "ip_address",
	"ipaddress":   "ip_address",
}

func ParseSwitchDirectoryCSV(raw []byte) ([]model.SwitchDirectoryImportCandidate, error) {
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

	return parseSwitchDirectoryRows(rows)
}

func ClassifySwitchDirectoryImport(
	candidates []model.SwitchDirectoryImportCandidate,
	existing map[string]model.SwitchDirectoryEntry,
) []model.SwitchDirectoryImportCandidate {
	seenNames := map[string]string{}
	result := make([]model.SwitchDirectoryImportCandidate, 0, len(candidates))

	for _, candidate := range candidates {
		if candidate.Action == model.ImportInvalid {
			result = append(result, candidate)
			continue
		}

		if priorRow, ok := seenNames[candidate.Name]; ok {
			candidate.Action = model.ImportInvalid
			candidate.Message = fmt.Sprintf("duplicate name in file (already seen in %s)", priorRow)
			result = append(result, candidate)
			continue
		}
		seenNames[candidate.Name] = candidate.RowID

		entry, ok := existing[candidate.Name]
		if !ok {
			candidate.Action = model.ImportAdd
			candidate.Message = "new switch"
			result = append(result, candidate)
			continue
		}

		candidate.ExistingID = &entry.ID
		if candidate.IPAddress != entry.IPAddress {
			candidate.Action = model.ImportUpdate
			candidate.Message = "existing switch changed"
		} else {
			candidate.Action = model.ImportUnchanged
			candidate.Message = "no changes"
		}
		result = append(result, candidate)
	}

	return result
}

func parseSwitchDirectoryRows(rows [][]string) ([]model.SwitchDirectoryImportCandidate, error) {
	if len(rows) == 0 {
		return nil, fmt.Errorf("input is empty")
	}

	headerRowIdx := -1
	headerMap := map[string]int{}
	for idx, row := range rows {
		if isCommentOrEmptyRow(row) {
			continue
		}
		mapped, err := mapSwitchDirectoryHeaders(row)
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

	result := make([]model.SwitchDirectoryImportCandidate, 0, len(rows)-headerRowIdx-1)
	for i := headerRowIdx + 1; i < len(rows); i++ {
		row := rows[i]
		if isCommentOrEmptyRow(row) {
			continue
		}

		sourceRow := i + 1
		candidate := model.SwitchDirectoryImportCandidate{
			RowID:     "row-" + strconv.Itoa(sourceRow),
			SourceRow: sourceRow,
			Name:      cellByKey(row, headerMap, "name"),
			IPAddress: cellByKey(row, headerMap, "ip_address"),
			Action:    model.ImportInvalid,
		}

		if candidate.Name == "" {
			candidate.Message = "missing switch name"
			result = append(result, candidate)
			continue
		}
		if candidate.IPAddress == "" {
			candidate.Message = "missing IP address"
			result = append(result, candidate)
			continue
		}
		if net.ParseIP(candidate.IPAddress) == nil {
			candidate.Message = "invalid IP format"
			result = append(result, candidate)
			continue
		}

		candidate.Action = model.ImportAdd
		result = append(result, candidate)
	}

	return result, nil
}

func mapSwitchDirectoryHeaders(headers []string) (map[string]int, error) {
	mapped := map[string]int{}
	for idx, header := range headers {
		normalized := normalizeHeader(header)
		if key, ok := switchDirectoryHeaderAliases[normalized]; ok {
			if _, exists := mapped[key]; exists {
				continue
			}
			mapped[key] = idx
		}
	}

	if _, ok := mapped["name"]; !ok {
		return nil, fmt.Errorf("missing headers: name")
	}
	if _, ok := mapped["ip_address"]; !ok {
		return nil, fmt.Errorf("missing headers: ip_address (or ip)")
	}

	return mapped, nil
}
