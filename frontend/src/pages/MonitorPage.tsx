import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSettings,
  listFilterOptions,
  listMonitorEndpointsPage,
  listMonitorTimeSeries,
  updateSettings
} from "../api/client";
import { MonitorChart } from "../components/MonitorChart";
import { MonitorTable } from "../components/MonitorTable";
import { MonitorToolbar, type FilterState } from "../components/MonitorToolbar";
import { rangeToDatesAt, toApiTime, type QuickRange } from "../hooks/time";
import { useMonitorSocket } from "../hooks/useMonitorSocket";
import type { CustomFieldConfig, Group, MonitorDataScope, MonitorSortField, ProbeStatus, Settings } from "../types/api";

function toDateTimeLocal(value: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
    value.getHours()
  )}:${pad(value.getMinutes())}`;
}

const defaultFilters: FilterState = {
  vlan: [],
  switches: [],
  ports: [],
  groups: []
};

const liveSortableFields: MonitorSortField[] = [
  "last_failed_on",
  "last_success_on",
  "success_count",
  "failed_count",
  "consecutive_failed_count",
  "max_consecutive_failed_count",
  "max_consecutive_failed_count_time",
  "failed_pct",
  "last_ping_latency",
  "average_latency"
];

const rangeSortableFields: MonitorSortField[] = [
  "last_failed_on",
  "last_success_on",
  "success_count",
  "failed_count",
  "failed_pct",
  "average_latency"
];
const monitorControlsCollapsedKey = "sonarscope.monitor.controls_collapsed";

type CustomFieldSlot = 1 | 2 | 3;

type EnabledCustomField = {
  slot: CustomFieldSlot;
  name: string;
};

type CustomSearchState = {
  custom1: string;
  custom2: string;
  custom3: string;
};

const defaultCustomSearch: CustomSearchState = {
  custom1: "",
  custom2: "",
  custom3: ""
};
const dashboardRefreshPresets = [30, 60] as const;
const liveSnapshotChartRange: QuickRange = "30m";

function normalizeEnabledCustomFields(fields?: CustomFieldConfig[]): EnabledCustomField[] {
  const bySlot: Record<CustomFieldSlot, EnabledCustomField | null> = {
    1: null,
    2: null,
    3: null
  };
  (fields || []).forEach((field) => {
    if (field.slot < 1 || field.slot > 3) {
      return;
    }
    if (!field.enabled || !field.name.trim()) {
      return;
    }
    const slot = field.slot as CustomFieldSlot;
    bySlot[slot] = {
      slot,
      name: field.name.trim()
    };
  });
  return [bySlot[1], bySlot[2], bySlot[3]].filter((field): field is EnabledCustomField => field !== null);
}

function customSearchValueBySlot(values: CustomSearchState, slot: CustomFieldSlot): string {
  if (slot === 1) return values.custom1;
  if (slot === 2) return values.custom2;
  return values.custom3;
}

function setCustomSearchBySlot(values: CustomSearchState, slot: CustomFieldSlot, next: string): CustomSearchState {
  if (slot === 1) return { ...values, custom1: next };
  if (slot === 2) return { ...values, custom2: next };
  return { ...values, custom3: next };
}

function normalizeIPList(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[,\n\r\t ]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

type Props = {
  dashboardMode?: boolean;
  onDashboardModeChange?: (enabled: boolean) => void;
  probeStatus?: ProbeStatus;
  groups?: Group[];
};

const defaultProbeStatus: ProbeStatus = {
  running: false,
  scope: "",
  group_ids: []
};

export function MonitorPage({ dashboardMode, onDashboardModeChange, probeStatus, groups }: Props = {}) {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [quickRange, setQuickRange] = useState<QuickRange>("30m");
  const [customStart, setCustomStart] = useState(toDateTimeLocal(new Date(Date.now() - 30 * 60 * 1000)));
  const [customEnd, setCustomEnd] = useState(toDateTimeLocal(new Date()));
  const [selectedEndpointID, setSelectedEndpointID] = useState<number | null>(null);
  const [hostnameSearch, setHostnameSearch] = useState("");
  const [macSearch, setMACSearch] = useState("");
  const [customSearch, setCustomSearch] = useState<CustomSearchState>(defaultCustomSearch);
  const [ipListSearch, setIPListSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [sortBy, setSortBy] = useState<MonitorSortField | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [dataScope, setDataScope] = useState<MonitorDataScope>("live");
  const [rangeAnchorMs, setRangeAnchorMs] = useState<number>(Date.now());
  const [internalDashboardMode, setInternalDashboardMode] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.localStorage.getItem(monitorControlsCollapsedKey) !== "0";
  });
  const lastRealtimeRefreshRef = useRef(0);

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const filterOptionsQuery = useQuery({ queryKey: ["filter-options"], queryFn: listFilterOptions });
  const effectiveProbeStatus = probeStatus ?? defaultProbeStatus;
  const probeGroups = groups ?? [];
  const enabledCustomFields = useMemo(
    () => normalizeEnabledCustomFields(settingsQuery.data?.custom_fields),
    [settingsQuery.data?.custom_fields]
  );
  const enabledCustomFieldKey = useMemo(
    () => enabledCustomFields.map((field) => `${field.slot}:${field.name}`).join("|"),
    [enabledCustomFields]
  );

  const autoRefreshMs = Math.max(1000, (settingsQuery.data?.auto_refresh_sec ?? 30) * 1000);

  useEffect(() => {
    lastRealtimeRefreshRef.current = 0;
  }, [autoRefreshMs]);

  useEffect(() => {
    const usesRollingWindow = dataScope === "live" || quickRange !== "custom";
    if (!usesRollingWindow) {
      return;
    }
    const refreshRangeAnchor = () => setRangeAnchorMs(Date.now());
    refreshRangeAnchor();
    const intervalID = window.setInterval(refreshRangeAnchor, autoRefreshMs);
    return () => window.clearInterval(intervalID);
  }, [autoRefreshMs, dataScope, quickRange]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(monitorControlsCollapsedKey, controlsCollapsed ? "1" : "0");
  }, [controlsCollapsed]);

  const tableDashboardMode = dashboardMode ?? internalDashboardMode;
  const setTableDashboardMode = (enabled: boolean) => {
    if (dashboardMode === undefined) {
      setInternalDashboardMode(enabled);
    }
    onDashboardModeChange?.(enabled);
  };

  useEffect(() => {
    return () => {
      onDashboardModeChange?.(false);
    };
  }, [onDashboardModeChange]);

  useEffect(() => {
    if (!tableDashboardMode) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTableDashboardMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tableDashboardMode]);

  const socketConnected = useMonitorSocket((message) => {
    if (tableDashboardMode) {
      return;
    }
    const event = message as { type?: string; endpoint_id?: number };
    if (event.type !== "probe_update") {
      return;
    }
    const now = Date.now();
    if (now - lastRealtimeRefreshRef.current < autoRefreshMs) {
      return;
    }
    lastRealtimeRefreshRef.current = now;
    queryClient.invalidateQueries({ queryKey: ["monitor-endpoints-page"] });
    if (event.endpoint_id && selectedEndpointID === event.endpoint_id) {
      queryClient.invalidateQueries({ queryKey: ["timeseries"] });
    }
  });

  const ipListValues = useMemo(() => normalizeIPList(ipListSearch), [ipListSearch]);
  const activeCustomSearchCount = useMemo(
    () =>
      enabledCustomFields.reduce((count, field) => {
        const value = customSearchValueBySlot(customSearch, field.slot);
        return count + (value.trim() ? 1 : 0);
      }, 0),
    [enabledCustomFields, customSearch]
  );
  const activeFilterCount =
    filters.vlan.length +
    filters.switches.length +
    filters.ports.length +
    filters.groups.length +
    (hostnameSearch.trim() ? 1 : 0) +
    (macSearch.trim() ? 1 : 0) +
    activeCustomSearchCount +
    (ipListValues.length > 0 ? 1 : 0);
  const activeLiveProbeGroupNames = useMemo(() => {
    if (!effectiveProbeStatus.running || effectiveProbeStatus.scope !== "groups" || !effectiveProbeStatus.group_ids.length) {
      return new Set<string>();
    }

    const activeGroupIDs = new Set<number>(effectiveProbeStatus.group_ids);
    const names = new Set<string>();
    probeGroups.forEach((group) => {
      if (!activeGroupIDs.has(group.id)) {
        return;
      }
      const normalized = group.name.trim().toLowerCase();
      if (normalized) {
        names.add(normalized);
      }
    });
    return names;
  }, [effectiveProbeStatus.group_ids, effectiveProbeStatus.running, effectiveProbeStatus.scope, probeGroups]);

  const { effectiveStart, effectiveEnd } = useMemo(() => {
    if (dataScope === "live") {
      const { start, end } = rangeToDatesAt(liveSnapshotChartRange, new Date(rangeAnchorMs));
      return { effectiveStart: start, effectiveEnd: end };
    }
    if (quickRange === "custom") {
      const startDate = new Date(customStart);
      const endDate = new Date(customEnd);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        const fallbackEnd = new Date();
        const fallbackStart = new Date(fallbackEnd.getTime() - 30 * 60 * 1000);
        return { effectiveStart: fallbackStart, effectiveEnd: fallbackEnd };
      }
      return { effectiveStart: startDate, effectiveEnd: endDate };
    }
    const { start, end } = rangeToDatesAt(quickRange, new Date(rangeAnchorMs));
    return { effectiveStart: start, effectiveEnd: end };
  }, [dataScope, quickRange, customStart, customEnd, rangeAnchorMs]);

  const displayStartValue = quickRange === "custom" ? customStart : toDateTimeLocal(effectiveStart);
  const displayEndValue = quickRange === "custom" ? customEnd : toDateTimeLocal(effectiveEnd);
  const isDashboardIntervalMode = tableDashboardMode;
  const queryRefetchInterval = isDashboardIntervalMode ? autoRefreshMs : socketConnected ? false : autoRefreshMs;

  const monitorQuery = useQuery({
    queryKey: [
      "monitor-endpoints-page",
      filters,
      hostnameSearch,
      macSearch,
      customSearch.custom1,
      customSearch.custom2,
      customSearch.custom3,
      enabledCustomFieldKey,
      ipListSearch,
      dataScope,
      dataScope === "range" ? effectiveStart.toISOString() : "",
      dataScope === "range" ? effectiveEnd.toISOString() : "",
      page,
      pageSize,
      sortBy,
      sortDir
    ],
    queryFn: () =>
      listMonitorEndpointsPage({
        vlan: filters.vlan,
        switches: filters.switches,
        ports: filters.ports,
        groups: filters.groups,
        hostname: hostnameSearch,
        mac: macSearch,
        custom1: customSearch.custom1,
        custom2: customSearch.custom2,
        custom3: customSearch.custom3,
        ipList: ipListValues,
        page,
        pageSize,
        statsScope: dataScope,
        start: dataScope === "range" ? toApiTime(effectiveStart) : undefined,
        end: dataScope === "range" ? toApiTime(effectiveEnd) : undefined,
        sortBy: sortBy || undefined,
        sortDir: sortDir || undefined
      }),
    refetchInterval: queryRefetchInterval
  });

  const monitorRows = monitorQuery.data?.items || [];
  const selectedEndpoint = monitorRows.find((row) => row.endpoint_id === selectedEndpointID) || null;

  useEffect(() => {
    const totalPages = monitorQuery.data?.total_pages ?? 0;
    if (totalPages > 0 && page > totalPages) {
      setPage(totalPages);
    }
  }, [monitorQuery.data?.total_pages, page]);

  useEffect(() => {
    if (!monitorRows.length || selectedEndpointID === null) {
      return;
    }
    if (!monitorRows.some((row) => row.endpoint_id === selectedEndpointID)) {
      setSelectedEndpointID(null);
    }
  }, [monitorRows, selectedEndpointID]);

  useEffect(() => {
    if (dataScope !== "range") {
      return;
    }
    if (sortBy && !rangeSortableFields.includes(sortBy)) {
      setSortBy(null);
      setSortDir(null);
      setPage(1);
    }
  }, [dataScope, sortBy]);

  const timeSeriesQuery = useQuery({
    queryKey: ["timeseries", dataScope, selectedEndpointID, effectiveStart.toISOString(), effectiveEnd.toISOString()],
    queryFn: () =>
      listMonitorTimeSeries({
        endpointIds: selectedEndpointID ? [selectedEndpointID] : [],
        start: toApiTime(effectiveStart),
        end: toApiTime(effectiveEnd)
      }),
    enabled: selectedEndpointID !== null,
    refetchInterval: queryRefetchInterval
  });

  const settingsMutation = useMutation({
    mutationFn: (settings: Settings) => updateSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const applyAutoRefreshSetting = (refreshSec: number) => {
    const current = settingsQuery.data;
    if (!current || current.auto_refresh_sec === refreshSec || settingsMutation.isPending) {
      return;
    }
    settingsMutation.mutate({
      ...current,
      auto_refresh_sec: refreshSec
    });
  };

  const handleDashboardRefreshPreset = (refreshSec: (typeof dashboardRefreshPresets)[number]) => {
    applyAutoRefreshSetting(refreshSec);
  };

  const handleDashboardRefreshInputChange = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const bounded = Math.max(1, Math.min(60, Math.round(parsed)));
    applyAutoRefreshSetting(bounded);
  };
  const controlsSummaryScope = dataScope === "live" ? "Live Snapshot" : "Selected Range";
  const controlsSummaryFilters = activeFilterCount === 0 ? "Filters: All" : `Filters: ${activeFilterCount}`;
  const dashboardRowSummary =
    monitorQuery.data && monitorQuery.data.total_items > 0
      ? `Showing ${monitorQuery.data.total_items} endpoints`
      : "No endpoints in current scope";

  const tableContent = monitorQuery.isLoading ? (
    <div className="panel state-panel">
      <div>
        <span className="skeleton-bar" style={{ width: 240 }} />
        <p className="state-loading-copy">Loading endpoint telemetry…</p>
      </div>
    </div>
  ) : monitorRows.length === 0 ? (
    <div className="panel state-panel">No endpoints match the active filters.</div>
  ) : (
    <MonitorTable
      rows={monitorRows}
      customFields={enabledCustomFields}
      selectedEndpointID={selectedEndpointID}
      onSelectionChange={setSelectedEndpointID}
      page={monitorQuery.data?.page ?? page}
      pageSize={(monitorQuery.data?.page_size as 50 | 100 | 200) ?? pageSize}
      totalItems={monitorQuery.data?.total_items ?? 0}
      totalPages={monitorQuery.data?.total_pages ?? 0}
      dataScope={dataScope}
      onPageChange={(nextPage) => setPage(Math.max(1, nextPage))}
      onPageSizeChange={(nextSize) => {
        setPageSize(nextSize);
        setPage(1);
      }}
      sortableFields={dataScope === "range" ? rangeSortableFields : liveSortableFields}
      sortBy={sortBy}
      sortDir={sortDir}
      probeRunning={effectiveProbeStatus.running}
      probeScope={effectiveProbeStatus.scope}
      activeProbeGroupNames={activeLiveProbeGroupNames}
      onSortChange={(nextSortBy, nextSortDir) => {
        setSortBy(nextSortBy);
        setSortDir(nextSortDir);
        setPage(1);
      }}
      preserveRelativeScroll={tableDashboardMode}
      refreshSignal={monitorQuery.dataUpdatedAt}
    />
  );

  if (tableDashboardMode) {
    return (
      <div className="monitor-dashboard-view">
        {(monitorQuery.error || settingsMutation.error) && (
          <div className="error-banner" role="alert" aria-live="assertive">
            {(monitorQuery.error as Error | undefined)?.message ||
              (settingsMutation.error as Error | undefined)?.message}
          </div>
        )}

        <div className="panel monitor-dashboard-header">
          <div className="monitor-dashboard-header-main">
            <div className="monitor-dashboard-header-copy">
              <h2 className="panel-title">Monitor Dashboard</h2>
              <p className="panel-subtitle">Fullscreen endpoint table view for wallboard monitoring.</p>
            </div>
            <div className="monitor-dashboard-header-actions">
              <button className="btn btn-primary monitor-dashboard-exit-btn" type="button" onClick={() => setTableDashboardMode(false)}>
                Exit Dashboard
              </button>
              <div className="monitor-dashboard-refresh-controls" aria-label="Dashboard auto refresh controls">
                <label className="monitor-dashboard-refresh-field">
                  <span className="monitor-dashboard-refresh-label">Auto Refresh (s)</span>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={settingsQuery.data?.auto_refresh_sec ?? 30}
                    disabled={settingsQuery.isLoading || settingsMutation.isPending}
                    onChange={(event) => handleDashboardRefreshInputChange(event.target.value)}
                    aria-label="Dashboard auto refresh interval in seconds"
                  />
                </label>
                <div className="monitor-dashboard-refresh-actions">
                  {dashboardRefreshPresets.map((refreshSec) => {
                    const active = settingsQuery.data?.auto_refresh_sec === refreshSec;
                    return (
                      <button
                        key={refreshSec}
                        className={`btn btn-small monitor-dashboard-refresh-btn ${active ? "is-active" : ""}`}
                        type="button"
                        aria-pressed={active}
                        disabled={settingsQuery.isLoading || settingsMutation.isPending}
                        onClick={() => handleDashboardRefreshPreset(refreshSec)}
                      >
                        {refreshSec}s
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <div className="monitor-dashboard-meta">
            <span className="status-chip">{controlsSummaryScope}</span>
            <span className="status-chip">{controlsSummaryFilters}</span>
            <span className="status-chip">{dashboardRowSummary}</span>
          </div>
        </div>

        <div className="monitor-dashboard-table">{tableContent}</div>
      </div>
    );
  }

  return (
    <div className={`monitor-page ${controlsCollapsed ? "monitor-page-controls-collapsed" : ""}`}>
      <aside className={`monitor-controls-column ${controlsCollapsed ? "monitor-controls-column-collapsed" : ""}`}>
        <div className="panel monitor-controls-header-panel">
          <div className="toolbar-title">Control Center</div>
          <button className="btn btn-small" type="button" onClick={() => setControlsCollapsed((prev) => !prev)}>
            {controlsCollapsed ? "Expand" : "Collapse"}
          </button>
        </div>

        {controlsCollapsed ? (
          <div className="panel monitor-controls-summary-panel">
            <span className="status-chip">{controlsSummaryScope}</span>
            <span className="status-chip">{controlsSummaryFilters}</span>
          </div>
        ) : (
          <MonitorToolbar
            filters={filters}
            customFields={enabledCustomFields}
            hostnameSearch={hostnameSearch}
            macSearch={macSearch}
            customSearch={customSearch}
            ipListSearch={ipListSearch}
            options={filterOptionsQuery.data}
            quickRange={quickRange}
            customStart={displayStartValue}
            customEnd={displayEndValue}
            dataScope={dataScope}
            settings={settingsQuery.data}
            onFilterChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
            onClearFilter={(key) => {
              setFilters((prev) => ({
                ...prev,
                [key]: []
              }));
              setPage(1);
            }}
            onClearAllFilters={() => {
              setFilters({ vlan: [], switches: [], ports: [], groups: [] });
              setHostnameSearch("");
              setMACSearch("");
              setCustomSearch(defaultCustomSearch);
              setIPListSearch("");
              setPage(1);
            }}
            onHostnameSearchChange={(next) => {
              setHostnameSearch(next);
              setPage(1);
            }}
            onMACSearchChange={(next) => {
              setMACSearch(next);
              setPage(1);
            }}
            onCustomSearchChange={(slot, next) => {
              setCustomSearch((prev) => setCustomSearchBySlot(prev, slot, next));
              setPage(1);
            }}
            onIPListSearchChange={(next) => {
              setIPListSearch(next);
              setPage(1);
            }}
            onClearHostnameSearch={() => {
              setHostnameSearch("");
              setPage(1);
            }}
            onClearMACSearch={() => {
              setMACSearch("");
              setPage(1);
            }}
            onClearCustomSearch={(slot) => {
              setCustomSearch((prev) => setCustomSearchBySlot(prev, slot, ""));
              setPage(1);
            }}
            onClearIPListSearch={() => {
              setIPListSearch("");
              setPage(1);
            }}
            onQuickRangeChange={(next) => {
              setQuickRange(next);
              if (next !== "custom") {
                setRangeAnchorMs(Date.now());
              }
            }}
            onCustomStartChange={(value) => {
              setQuickRange("custom");
              setCustomStart(value);
              setRangeAnchorMs(Date.now());
            }}
            onCustomEndChange={(value) => {
              setQuickRange("custom");
              setCustomEnd(value);
              setRangeAnchorMs(Date.now());
            }}
            onDataScopeChange={(next) => {
              if (next === "range" && sortBy && !rangeSortableFields.includes(sortBy)) {
                setSortBy(null);
                setSortDir(null);
              }
              setDataScope(next);
              setPage(1);
            }}
            onSettingsPatch={(settings) => settingsMutation.mutate(settings)}
          />
        )}
      </aside>

      <div className="monitor-data-stack">
        {(monitorQuery.error || settingsMutation.error) && (
          <div className="error-banner" role="alert" aria-live="assertive">
            {(monitorQuery.error as Error | undefined)?.message ||
              (settingsMutation.error as Error | undefined)?.message}
          </div>
        )}

        <div className="monitor-pane-middle">
          <div className="monitor-pane-middle-head">
            <span className="monitor-pane-middle-title">Endpoint Snapshot</span>
          </div>
          {tableContent}
        </div>

        <div className="monitor-pane-bottom">
          {selectedEndpointID === null ? (
            <div className="panel state-panel empty-chart-panel">Select an endpoint row to visualize loss rate and latency.</div>
          ) : timeSeriesQuery.isLoading ? (
            <div className="panel state-panel">Loading timeseries data…</div>
          ) : timeSeriesQuery.error ? (
            <div className="panel state-panel">Failed to load timeseries data for the selected range.</div>
          ) : (
            <MonitorChart
              points={timeSeriesQuery.data?.series || []}
              rollup={timeSeriesQuery.data?.rollup || "1m"}
              rangeStart={effectiveStart}
              rangeEnd={effectiveEnd}
              endpointLabel={selectedEndpoint ? `${selectedEndpoint.hostname || selectedEndpoint.ip_address} (${selectedEndpoint.ip_address})` : `ID ${selectedEndpointID}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
