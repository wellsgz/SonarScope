import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSettings,
  listFilterOptions,
  listGroups,
  listMonitorEndpointsPage,
  listMonitorTimeSeries,
  startProbe,
  stopProbe,
  updateSettings
} from "../api/client";
import { MonitorChart } from "../components/MonitorChart";
import { MonitorTable } from "../components/MonitorTable";
import { MonitorToolbar, type FilterState } from "../components/MonitorToolbar";
import { rangeToDatesAt, toApiTime, type QuickRange } from "../hooks/time";
import { useMonitorSocket } from "../hooks/useMonitorSocket";
import type { MonitorDataScope, MonitorSortField, Settings } from "../types/api";

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
  "last_success_on",
  "success_count",
  "failed_count",
  "failed_pct",
  "average_latency"
];
const monitorControlsCollapsedKey = "sonarscope.monitor.controls_collapsed";

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

export function MonitorPage() {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [quickRange, setQuickRange] = useState<QuickRange>("30m");
  const [customStart, setCustomStart] = useState(toDateTimeLocal(new Date(Date.now() - 30 * 60 * 1000)));
  const [customEnd, setCustomEnd] = useState(toDateTimeLocal(new Date()));
  const [selectedEndpointID, setSelectedEndpointID] = useState<number | null>(null);
  const [hostnameSearch, setHostnameSearch] = useState("");
  const [macSearch, setMACSearch] = useState("");
  const [ipListSearch, setIPListSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [sortBy, setSortBy] = useState<MonitorSortField | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [dataScope, setDataScope] = useState<MonitorDataScope>("live");
  const [rangeAnchorMs, setRangeAnchorMs] = useState<number>(Date.now());
  const [probeRunning, setProbeRunning] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.localStorage.getItem(monitorControlsCollapsedKey) !== "0";
  });
  const lastRealtimeRefreshRef = useRef(0);

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const filterOptionsQuery = useQuery({ queryKey: ["filter-options"], queryFn: listFilterOptions });

  const autoRefreshMs = Math.max(1000, (settingsQuery.data?.auto_refresh_sec ?? 10) * 1000);

  useEffect(() => {
    lastRealtimeRefreshRef.current = 0;
  }, [autoRefreshMs]);

  useEffect(() => {
    if (quickRange === "custom") {
      return;
    }
    const refreshRangeAnchor = () => setRangeAnchorMs(Date.now());
    refreshRangeAnchor();
    const intervalID = window.setInterval(refreshRangeAnchor, autoRefreshMs);
    return () => window.clearInterval(intervalID);
  }, [quickRange, autoRefreshMs]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(monitorControlsCollapsedKey, controlsCollapsed ? "1" : "0");
  }, [controlsCollapsed]);

  const socketConnected = useMonitorSocket((message) => {
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
  const activeFilterCount =
    filters.vlan.length +
    filters.switches.length +
    filters.ports.length +
    filters.groups.length +
    (hostnameSearch.trim() ? 1 : 0) +
    (macSearch.trim() ? 1 : 0) +
    (ipListValues.length > 0 ? 1 : 0);

  const { effectiveStart, effectiveEnd } = useMemo(() => {
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
  }, [quickRange, customStart, customEnd, rangeAnchorMs]);

  const displayStartValue = quickRange === "custom" ? customStart : toDateTimeLocal(effectiveStart);
  const displayEndValue = quickRange === "custom" ? customEnd : toDateTimeLocal(effectiveEnd);

  const monitorQuery = useQuery({
    queryKey: [
      "monitor-endpoints-page",
      filters,
      hostnameSearch,
      macSearch,
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
        ipList: ipListValues,
        page,
        pageSize,
        statsScope: dataScope,
        start: dataScope === "range" ? toApiTime(effectiveStart) : undefined,
        end: dataScope === "range" ? toApiTime(effectiveEnd) : undefined,
        sortBy: sortBy || undefined,
        sortDir: sortDir || undefined
      }),
    refetchInterval: socketConnected ? false : autoRefreshMs
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
    queryKey: ["timeseries", selectedEndpointID, effectiveStart.toISOString(), effectiveEnd.toISOString()],
    queryFn: () =>
      listMonitorTimeSeries({
        endpointIds: selectedEndpointID ? [selectedEndpointID] : [],
        start: toApiTime(effectiveStart),
        end: toApiTime(effectiveEnd)
      }),
    enabled: selectedEndpointID !== null,
    refetchInterval: socketConnected ? false : autoRefreshMs
  });

  const settingsMutation = useMutation({
    mutationFn: (settings: Settings) => updateSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const startProbeMutation = useMutation({
    mutationFn: (payload: { scope: "all" | "groups"; group_ids?: number[] }) => startProbe(payload),
    onSuccess: () => setProbeRunning(true)
  });

  const stopProbeMutation = useMutation({
    mutationFn: stopProbe,
    onSuccess: () => setProbeRunning(false)
  });
  const controlsSummaryScope = dataScope === "live" ? "Live Snapshot" : "Selected Range";

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
            <span className="status-chip">Filters: {activeFilterCount}</span>
            <span className={`status-chip ${probeRunning ? "status-chip-live" : ""}`}>
              {probeRunning ? "Probe Running" : "Probe Stopped"}
            </span>
          </div>
        ) : (
          <MonitorToolbar
            filters={filters}
            hostnameSearch={hostnameSearch}
            macSearch={macSearch}
            ipListSearch={ipListSearch}
            options={filterOptionsQuery.data}
            quickRange={quickRange}
            customStart={displayStartValue}
            customEnd={displayEndValue}
            dataScope={dataScope}
            settings={settingsQuery.data}
            groups={groupsQuery.data || []}
            probeRunning={probeRunning}
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
            onStartAll={() => startProbeMutation.mutate({ scope: "all" })}
            onStartGroups={(groupIDs) => startProbeMutation.mutate({ scope: "groups", group_ids: groupIDs })}
            onStop={() => stopProbeMutation.mutate()}
          />
        )}
      </aside>

      <div className="monitor-data-stack">
        {(monitorQuery.error || settingsMutation.error || startProbeMutation.error || stopProbeMutation.error) && (
          <div className="error-banner" role="alert" aria-live="assertive">
            {(monitorQuery.error as Error | undefined)?.message ||
              (settingsMutation.error as Error | undefined)?.message ||
              (startProbeMutation.error as Error | undefined)?.message ||
              (stopProbeMutation.error as Error | undefined)?.message}
          </div>
        )}

        <div className="monitor-pane-middle">
          {monitorQuery.isLoading ? (
            <div className="panel state-panel">
              <div>
                <span className="skeleton-bar" style={{ width: 240 }} />
                <p style={{ marginTop: 10 }}>Loading endpoint telemetry…</p>
              </div>
            </div>
          ) : monitorRows.length === 0 ? (
            <div className="panel state-panel">No endpoints match the active filters.</div>
          ) : (
            <MonitorTable
              rows={monitorRows}
              selectedEndpointID={selectedEndpointID}
              onSelectionChange={setSelectedEndpointID}
              page={monitorQuery.data?.page ?? page}
              pageSize={(monitorQuery.data?.page_size as 50 | 100 | 200) ?? pageSize}
              totalItems={monitorQuery.data?.total_items ?? 0}
              totalPages={monitorQuery.data?.total_pages ?? 0}
              onPageChange={(nextPage) => setPage(Math.max(1, nextPage))}
              onPageSizeChange={(nextSize) => {
                setPageSize(nextSize);
                setPage(1);
              }}
              sortableFields={dataScope === "range" ? rangeSortableFields : liveSortableFields}
              sortBy={sortBy}
              sortDir={sortDir}
              onSortChange={(nextSortBy, nextSortDir) => {
                setSortBy(nextSortBy);
                setSortDir(nextSortDir);
                setPage(1);
              }}
            />
          )}
        </div>

        <div className="monitor-pane-bottom">
          {selectedEndpointID === null ? (
            <div className="panel state-panel empty-chart-panel">Select an endpoint row to visualize loss rate and latency.</div>
          ) : timeSeriesQuery.isLoading ? (
            <div className="panel state-panel">Loading timeseries data…</div>
          ) : (timeSeriesQuery.data?.series || []).length === 0 ? (
            <div className="panel state-panel">No timeseries data found for the selected range.</div>
          ) : (
            <MonitorChart
              points={timeSeriesQuery.data?.series || []}
              endpointLabel={selectedEndpoint ? `${selectedEndpoint.hostname || selectedEndpoint.ip_address} (${selectedEndpoint.ip_address})` : `ID ${selectedEndpointID}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
