import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listFilterOptions,
  listGroups,
  listMonitorEndpoints,
  listMonitorTimeSeries,
  getSettings,
  startProbe,
  stopProbe,
  updateSettings
} from "../api/client";
import { MonitorTable } from "../components/MonitorTable";
import { MonitorChart } from "../components/MonitorChart";
import { MonitorToolbar } from "../components/MonitorToolbar";
import { rangeToDates, toApiTime, type QuickRange } from "../hooks/time";
import { useMonitorSocket } from "../hooks/useMonitorSocket";
import type { Settings } from "../types/api";

function toDateTimeLocal(value: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
    value.getHours()
  )}:${pad(value.getMinutes())}`;
}

export function MonitorPage() {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState({
    vlan: [] as string[],
    switches: [] as string[],
    ports: [] as string[],
    groups: [] as string[]
  });
  const [quickRange, setQuickRange] = useState<QuickRange>("30m");
  const [customStart, setCustomStart] = useState(toDateTimeLocal(new Date(Date.now() - 30 * 60 * 1000)));
  const [customEnd, setCustomEnd] = useState(toDateTimeLocal(new Date()));
  const [selectedEndpointIDs, setSelectedEndpointIDs] = useState<number[]>([]);
  const [probeRunning, setProbeRunning] = useState(false);

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const filterOptionsQuery = useQuery({ queryKey: ["filter-options"], queryFn: listFilterOptions });

  const autoRefreshMs = (settingsQuery.data?.auto_refresh_sec ?? 10) * 1000;

  const monitorQuery = useQuery({
    queryKey: ["monitor-endpoints", filters],
    queryFn: () =>
      listMonitorEndpoints({
        vlan: filters.vlan,
        switches: filters.switches,
        ports: filters.ports,
        groups: filters.groups
      }),
    refetchInterval: autoRefreshMs
  });

  const { start, end } = useMemo(() => {
    if (quickRange === "custom") {
      const startDate = new Date(customStart);
      const endDate = new Date(customEnd);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return rangeToDates("30m");
      }
      return {
        start: startDate,
        end: endDate
      };
    }
    return rangeToDates(quickRange);
  }, [quickRange, customStart, customEnd]);

  const timeSeriesQuery = useQuery({
    queryKey: ["timeseries", selectedEndpointIDs, start.toISOString(), end.toISOString()],
    queryFn: () =>
      listMonitorTimeSeries({
        endpointIds: selectedEndpointIDs,
        start: toApiTime(start),
        end: toApiTime(end)
      }),
    enabled: selectedEndpointIDs.length > 0,
    refetchInterval: autoRefreshMs
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

  useMonitorSocket((message) => {
    const event = message as { type?: string; endpoint_id?: number };
    if (event.type === "probe_update") {
      queryClient.invalidateQueries({ queryKey: ["monitor-endpoints"] });
      if (event.endpoint_id && selectedEndpointIDs.includes(event.endpoint_id)) {
        queryClient.invalidateQueries({ queryKey: ["timeseries"] });
      }
    }
  });

  return (
    <div className="monitor-page">
      <MonitorToolbar
        filters={filters}
        options={filterOptionsQuery.data}
        quickRange={quickRange}
        customStart={customStart}
        customEnd={customEnd}
        settings={settingsQuery.data}
        groups={groupsQuery.data || []}
        probeRunning={probeRunning}
        onFilterChange={setFilters}
        onQuickRangeChange={setQuickRange}
        onCustomStartChange={(value) => {
          setQuickRange("custom");
          setCustomStart(value);
        }}
        onCustomEndChange={(value) => {
          setQuickRange("custom");
          setCustomEnd(value);
        }}
        onSettingsPatch={(settings) => settingsMutation.mutate(settings)}
        onStartAll={() => startProbeMutation.mutate({ scope: "all" })}
        onStartGroups={(groupIDs) => startProbeMutation.mutate({ scope: "groups", group_ids: groupIDs })}
        onStop={() => stopProbeMutation.mutate()}
      />

      {(monitorQuery.error || settingsMutation.error || startProbeMutation.error || stopProbeMutation.error) && (
        <div className="error-banner">
          {(monitorQuery.error as Error | undefined)?.message ||
            (settingsMutation.error as Error | undefined)?.message ||
            (startProbeMutation.error as Error | undefined)?.message ||
            (stopProbeMutation.error as Error | undefined)?.message}
        </div>
      )}

      <div className="pane-stack">
        <div className="pane-upper">
          <MonitorTable rows={monitorQuery.data || []} onSelectionChange={setSelectedEndpointIDs} />
        </div>
        <div className="pane-lower">
          <MonitorChart points={timeSeriesQuery.data?.series || []} />
        </div>
      </div>
    </div>
  );
}
