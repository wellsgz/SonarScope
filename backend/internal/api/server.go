package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"

	"sonarscope/backend/internal/config"
	"sonarscope/backend/internal/importer"
	"sonarscope/backend/internal/model"
	"sonarscope/backend/internal/probe"
	"sonarscope/backend/internal/store"
	"sonarscope/backend/internal/telemetry"
	"sonarscope/backend/internal/util"
)

type Server struct {
	cfg   config.Config
	store *store.Store
	probe *probe.Engine
	hub   *telemetry.Hub

	previewMu sync.RWMutex
	previews  map[string]model.ImportPreview
}

func NewServer(cfg config.Config, st *store.Store, p *probe.Engine, hub *telemetry.Hub) *Server {
	return &Server{
		cfg:      cfg,
		store:    st,
		probe:    p,
		hub:      hub,
		previews: map[string]model.ImportPreview{},
	}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)
	r.Use(s.corsMiddleware)

	r.Get("/healthz", s.handleHealth)
	r.Get("/ws/monitor", s.handleWSMonitor)

	r.Route("/api", func(r chi.Router) {
		r.Route("/inventory", func(r chi.Router) {
			r.Get("/endpoints", s.handleInventoryEndpoints)
			r.Put("/endpoints/{endpointID}", s.handleInventoryEndpointUpdate)
			r.Get("/filter-options", s.handleInventoryFilters)
			r.Post("/import-preview", s.handleInventoryImportPreview)
			r.Post("/import-apply", s.handleInventoryImportApply)
		})

		r.Route("/groups", func(r chi.Router) {
			r.Get("/", s.handleListGroups)
			r.Post("/", s.handleCreateGroup)
			r.Put("/{groupID}", s.handleUpdateGroup)
			r.Delete("/{groupID}", s.handleDeleteGroup)
		})

		r.Route("/probes", func(r chi.Router) {
			r.Get("/status", s.handleProbeStatus)
			r.Post("/start", s.handleProbeStart)
			r.Post("/stop", s.handleProbeStop)
		})

		r.Route("/settings", func(r chi.Router) {
			r.Get("/", s.handleGetSettings)
			r.Put("/", s.handleUpdateSettings)
		})

		r.Route("/monitor", func(r chi.Router) {
			r.Get("/endpoints", s.handleMonitorEndpoints)
			r.Get("/endpoints-page", s.handleMonitorEndpointsPage)
			r.Get("/timeseries", s.handleMonitorTimeSeries)
			r.Get("/filter-options", s.handleMonitorFilters)
		})
	})

	return r
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	util.WriteJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handleWSMonitor(w http.ResponseWriter, r *http.Request) {
	s.hub.ServeWS(w, r)
}

func (s *Server) handleInventoryImportPreview(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(25 << 20); err != nil {
		util.WriteError(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer func() { _ = file.Close() }()

	raw, err := io.ReadAll(io.LimitReader(file, 50<<20))
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, "failed to read file")
		return
	}

	rows, err := importer.Parse(header.Filename, raw)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	existing, err := s.store.InventoryByIP(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("inventory lookup failed: %v", err))
		return
	}

	classified := importer.Classify(rows, existing)
	preview := model.ImportPreview{
		PreviewID:  newPreviewID(),
		CreatedAt:  time.Now().UTC(),
		Candidates: classified,
	}

	s.previewMu.Lock()
	s.previews[preview.PreviewID] = preview
	s.previewMu.Unlock()

	util.WriteJSON(w, http.StatusOK, preview)
}

func (s *Server) handleInventoryImportApply(w http.ResponseWriter, r *http.Request) {
	type selection struct {
		RowID  string                     `json:"row_id"`
		Action model.ImportClassification `json:"action"`
	}
	type request struct {
		PreviewID  string      `json:"preview_id"`
		Selections []selection `json:"selections"`
	}

	var req request
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}
	if req.PreviewID == "" {
		util.WriteError(w, http.StatusBadRequest, "preview_id is required")
		return
	}

	s.previewMu.RLock()
	preview, ok := s.previews[req.PreviewID]
	s.previewMu.RUnlock()
	if !ok {
		util.WriteError(w, http.StatusNotFound, "preview not found")
		return
	}

	selected := map[string]model.ImportClassification{}
	for _, item := range req.Selections {
		selected[item.RowID] = item.Action
	}

	rowsToApply := []model.ImportCandidate{}
	if len(selected) == 0 {
		for _, candidate := range preview.Candidates {
			if candidate.Action == model.ImportAdd || candidate.Action == model.ImportUpdate {
				rowsToApply = append(rowsToApply, candidate)
			}
		}
	} else {
		for _, candidate := range preview.Candidates {
			action, include := selected[candidate.RowID]
			if !include {
				continue
			}
			candidate.Action = action
			if candidate.Action == model.ImportAdd || candidate.Action == model.ImportUpdate {
				rowsToApply = append(rowsToApply, candidate)
			}
		}
	}

	added, updated, applyErrors := s.store.ApplyImport(r.Context(), rowsToApply)

	s.previewMu.Lock()
	delete(s.previews, req.PreviewID)
	s.previewMu.Unlock()

	util.WriteJSON(w, http.StatusOK, map[string]any{
		"added":   added,
		"updated": updated,
		"errors":  applyErrors,
	})
}

func (s *Server) handleInventoryEndpoints(w http.ResponseWriter, r *http.Request) {
	filters := store.MonitorFilters{
		VLANs:      parseCSVQuery(r, "vlan"),
		Switches:   parseCSVQuery(r, "switch"),
		Ports:      parseCSVQuery(r, "port"),
		GroupNames: parseCSVQuery(r, "group"),
	}

	items, err := s.store.ListInventoryEndpoints(r.Context(), filters)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, items)
}

func (s *Server) handleInventoryEndpointUpdate(w http.ResponseWriter, r *http.Request) {
	endpointID, err := strconv.ParseInt(chi.URLParam(r, "endpointID"), 10, 64)
	if err != nil || endpointID < 1 {
		util.WriteError(w, http.StatusBadRequest, "invalid endpoint id")
		return
	}

	var patch model.InventoryEndpointUpdate
	if err := util.DecodeJSON(r, &patch); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	patch.Hostname = strings.TrimSpace(patch.Hostname)
	patch.MACAddress = strings.TrimSpace(patch.MACAddress)
	patch.VLAN = strings.TrimSpace(patch.VLAN)
	patch.Switch = strings.TrimSpace(patch.Switch)
	patch.Port = strings.TrimSpace(patch.Port)
	patch.PortType = strings.ToLower(strings.TrimSpace(patch.PortType))
	patch.Description = strings.TrimSpace(patch.Description)

	item, err := s.store.UpdateInventoryEndpoint(r.Context(), endpointID, patch)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			util.WriteError(w, http.StatusNotFound, "inventory endpoint not found")
			return
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	util.WriteJSON(w, http.StatusOK, item)
}

func (s *Server) handleInventoryFilters(w http.ResponseWriter, r *http.Request) {
	filters, err := s.store.ListDistinctFilters(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, filters)
}

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.store.ListGroups(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, groups)
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	type request struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		EndpointIDs []int64 `json:"endpoint_ids"`
	}
	var req request
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		util.WriteError(w, http.StatusBadRequest, "name is required")
		return
	}

	group, err := s.store.CreateGroup(r.Context(), strings.TrimSpace(req.Name), req.Description, req.EndpointIDs)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusCreated, group)
}

func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	groupID, err := strconv.ParseInt(chi.URLParam(r, "groupID"), 10, 64)
	if err != nil || groupID < 1 {
		util.WriteError(w, http.StatusBadRequest, "invalid group id")
		return
	}

	type request struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		EndpointIDs []int64 `json:"endpoint_ids"`
	}
	var req request
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		util.WriteError(w, http.StatusBadRequest, "name is required")
		return
	}

	group, err := s.store.UpdateGroup(r.Context(), groupID, strings.TrimSpace(req.Name), req.Description, req.EndpointIDs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			util.WriteError(w, http.StatusNotFound, "group not found")
			return
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, group)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	groupID, err := strconv.ParseInt(chi.URLParam(r, "groupID"), 10, 64)
	if err != nil || groupID < 1 {
		util.WriteError(w, http.StatusBadRequest, "invalid group id")
		return
	}

	if err := s.store.DeleteGroup(r.Context(), groupID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			util.WriteError(w, http.StatusNotFound, "group not found")
			return
		}
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handleProbeStart(w http.ResponseWriter, r *http.Request) {
	type request struct {
		Scope    string  `json:"scope"`
		GroupIDs []int64 `json:"group_ids"`
	}
	var req request
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	req.Scope = strings.ToLower(strings.TrimSpace(req.Scope))
	if req.Scope == "" {
		req.Scope = "all"
	}
	if err := s.probe.Start(req.Scope, req.GroupIDs); err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	util.WriteJSON(w, http.StatusOK, map[string]any{
		"running":   true,
		"scope":     req.Scope,
		"group_ids": req.GroupIDs,
	})
}

func (s *Server) handleProbeStatus(w http.ResponseWriter, _ *http.Request) {
	status := s.probe.Status()
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"running":   status.Running,
		"scope":     status.Scope,
		"group_ids": status.GroupIDs,
	})
}

func (s *Server) handleProbeStop(w http.ResponseWriter, _ *http.Request) {
	stopped := s.probe.Stop()
	util.WriteJSON(w, http.StatusOK, map[string]any{"running": false, "stopped": stopped})
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetSettings(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, settings)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	type settingsPatch struct {
		PingIntervalSec *int `json:"ping_interval_sec"`
		ICMPPayloadSize *int `json:"icmp_payload_bytes"`
		ICMPTimeoutMs   *int `json:"icmp_timeout_ms"`
		AutoRefreshSec  *int `json:"auto_refresh_sec"`
	}

	var patch settingsPatch
	if err := util.DecodeJSON(r, &patch); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	settings, err := s.store.GetSettings(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if patch.PingIntervalSec != nil {
		settings.PingIntervalSec = *patch.PingIntervalSec
	}
	if patch.ICMPPayloadSize != nil {
		settings.ICMPPayloadSize = *patch.ICMPPayloadSize
	}
	if patch.ICMPTimeoutMs != nil {
		settings.ICMPTimeoutMs = *patch.ICMPTimeoutMs
	}
	if patch.AutoRefreshSec != nil {
		settings.AutoRefreshSec = *patch.AutoRefreshSec
	}

	if err := config.ValidateSettings(
		settings.PingIntervalSec,
		settings.ICMPPayloadSize,
		settings.AutoRefreshSec,
		settings.ICMPTimeoutMs,
	); err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := s.store.UpdateSettings(r.Context(), settings); err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.probe.UpdateSettings(settings)
	util.WriteJSON(w, http.StatusOK, settings)
}

func (s *Server) handleMonitorEndpoints(w http.ResponseWriter, r *http.Request) {
	filters := store.MonitorFilters{
		VLANs:      parseCSVQuery(r, "vlan"),
		Switches:   parseCSVQuery(r, "switch"),
		Ports:      parseCSVQuery(r, "port"),
		GroupNames: parseCSVQuery(r, "group"),
	}

	items, err := s.store.ListMonitorEndpoints(r.Context(), filters)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, items)
}

func (s *Server) handleMonitorEndpointsPage(w http.ResponseWriter, r *http.Request) {
	filters := store.MonitorFilters{
		VLANs:      parseCSVQuery(r, "vlan"),
		Switches:   parseCSVQuery(r, "switch"),
		Ports:      parseCSVQuery(r, "port"),
		GroupNames: parseCSVQuery(r, "group"),
	}

	page, err := parsePositiveIntQuery(r, "page", 1)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	pageSize, err := parsePositiveIntQuery(r, "page_size", 100)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if pageSize != 50 && pageSize != 100 && pageSize != 200 {
		util.WriteError(w, http.StatusBadRequest, "page_size must be one of 50, 100, 200")
		return
	}

	statsScope := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("stats_scope")))
	if statsScope == "" {
		statsScope = "live"
	}
	if statsScope != "live" && statsScope != "range" {
		util.WriteError(w, http.StatusBadRequest, "stats_scope must be live or range")
		return
	}

	sortBy := strings.TrimSpace(r.URL.Query().Get("sort_by"))
	sortDir := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sort_dir")))
	if sortBy != "" {
		validateSort := storeMonitorSortExpression
		if statsScope == "range" {
			validateSort = storeMonitorRangeSortExpression
		}
		if _, err := validateSort(sortBy); err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid sort_by")
			return
		}
		if sortDir == "" {
			sortDir = "desc"
		}
		if sortDir != "asc" && sortDir != "desc" {
			util.WriteError(w, http.StatusBadRequest, "sort_dir must be asc or desc")
			return
		}
	} else {
		if sortDir != "" {
			util.WriteError(w, http.StatusBadRequest, "sort_dir requires sort_by")
			return
		}
	}

	hostname := strings.TrimSpace(r.URL.Query().Get("hostname"))
	mac := strings.TrimSpace(r.URL.Query().Get("mac"))
	ipList, err := parseIPListQuery(r, "ip_list")
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	var start time.Time
	var end time.Time
	if statsScope == "range" {
		startRaw := strings.TrimSpace(r.URL.Query().Get("start"))
		endRaw := strings.TrimSpace(r.URL.Query().Get("end"))
		if startRaw == "" || endRaw == "" {
			util.WriteError(w, http.StatusBadRequest, "start and end are required when stats_scope=range")
			return
		}

		start, err = parseQueryTimestamp(startRaw)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid start format")
			return
		}
		end, err = parseQueryTimestamp(endRaw)
		if err != nil {
			util.WriteError(w, http.StatusBadRequest, "invalid end format")
			return
		}
		if !start.Before(end) {
			util.WriteError(w, http.StatusBadRequest, "start must be before end")
			return
		}
	}

	items, totalItems, err := s.store.ListMonitorEndpointsPage(r.Context(), store.MonitorPageQuery{
		Filters:    filters,
		Hostname:   hostname,
		MAC:        mac,
		IPList:     ipList,
		Page:       page,
		PageSize:   pageSize,
		SortBy:     sortBy,
		SortDir:    sortDir,
		StatsScope: statsScope,
		Start:      start,
		End:        end,
	})
	if err != nil {
		if err.Error() == "invalid sort_by" {
			util.WriteError(w, http.StatusBadRequest, "invalid sort_by")
			return
		}
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	totalPages := int((totalItems + int64(pageSize) - 1) / int64(pageSize))
	if totalItems == 0 {
		totalPages = 0
	}

	rangeRollup := ""
	if statsScope == "range" {
		if end.Sub(start) > 48*time.Hour {
			rangeRollup = "1h"
		} else {
			rangeRollup = "1m"
		}
	}

	util.WriteJSON(w, http.StatusOK, model.MonitorEndpointsPageResponse{
		Items:       items,
		Page:        page,
		PageSize:    pageSize,
		TotalItems:  totalItems,
		TotalPages:  totalPages,
		SortBy:      sortBy,
		SortDir:     sortDir,
		StatsScope:  statsScope,
		RangeRollup: rangeRollup,
	})
}

func (s *Server) handleMonitorTimeSeries(w http.ResponseWriter, r *http.Request) {
	endpointIDs := parseInt64CSVQuery(r, "endpoint_ids")
	if len(endpointIDs) == 0 {
		util.WriteJSON(w, http.StatusOK, []model.TimeSeriesPoint{})
		return
	}

	end := parseTimeQuery(r, "end", time.Now().UTC())
	start := parseTimeQuery(r, "start", end.Add(-30*time.Minute))
	if !start.Before(end) {
		util.WriteError(w, http.StatusBadRequest, "start must be before end")
		return
	}

	rollup := "1m"
	if end.Sub(start) > 48*time.Hour {
		rollup = "1h"
	}

	series, err := s.store.QueryTimeSeries(r.Context(), endpointIDs, start, end, rollup)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, map[string]any{
		"rollup": rollup,
		"series": series,
	})
}

func (s *Server) handleMonitorFilters(w http.ResponseWriter, r *http.Request) {
	filters, err := s.store.ListDistinctFilters(r.Context())
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	util.WriteJSON(w, http.StatusOK, filters)
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	allowed := map[string]struct{}{}
	for _, origin := range s.cfg.AllowedOrigins {
		allowed[strings.TrimSpace(origin)] = struct{}{}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if _, ok := allowed[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
		}

		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func parseCSVQuery(r *http.Request, key string) []string {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			out = append(out, value)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parsePositiveIntQuery(r *http.Request, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func parseIPListQuery(r *http.Request, key string) ([]string, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil, nil
	}

	parts := strings.FieldsFunc(raw, func(ch rune) bool {
		return ch == ',' || ch == '\n' || ch == '\r' || ch == '\t' || ch == ' '
	})

	seen := map[string]struct{}{}
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		ip := strings.TrimSpace(part)
		if ip == "" {
			continue
		}
		if net.ParseIP(ip) == nil {
			return nil, fmt.Errorf("invalid ip in ip_list: %s", ip)
		}
		if _, ok := seen[ip]; ok {
			continue
		}
		seen[ip] = struct{}{}
		out = append(out, ip)
	}

	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func storeMonitorSortExpression(sortBy string) (string, error) {
	switch sortBy {
	case "",
		"last_success_on",
		"success_count",
		"failed_count",
		"consecutive_failed_count",
		"max_consecutive_failed_count",
		"max_consecutive_failed_count_time",
		"failed_pct",
		"last_ping_latency",
		"average_latency":
		return sortBy, nil
	default:
		return "", fmt.Errorf("invalid sort_by")
	}
}

func storeMonitorRangeSortExpression(sortBy string) (string, error) {
	switch sortBy {
	case "",
		"last_success_on",
		"success_count",
		"failed_count",
		"failed_pct",
		"average_latency":
		return sortBy, nil
	default:
		return "", fmt.Errorf("invalid sort_by")
	}
}

func parseQueryTimestamp(raw string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse("2006-01-02-15-04-05", raw); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("invalid time format")
}

func parseInt64CSVQuery(r *http.Request, key string) []int64 {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]int64, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id < 1 {
			continue
		}
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseTimeQuery(r *http.Request, key string, fallback time.Time) time.Time {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}

	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse("2006-01-02-15-04-05", raw); err == nil {
		return t.UTC()
	}
	return fallback
}

func newPreviewID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("preview-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
