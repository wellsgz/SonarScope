import { useMemo, type ChangeEvent } from "react";
import type { FilterOptions, Group, Settings } from "../types/api";
import type { QuickRange } from "../hooks/time";

type FilterState = {
  vlan: string[];
  switches: string[];
  ports: string[];
  groups: string[];
};

type Props = {
  filters: FilterState;
  options?: FilterOptions;
  quickRange: QuickRange;
  customStart: string;
  customEnd: string;
  settings?: Settings;
  groups: Group[];
  probeRunning: boolean;
  onFilterChange: (next: FilterState) => void;
  onQuickRangeChange: (next: QuickRange) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onSettingsPatch: (next: Settings) => void;
  onStartAll: () => void;
  onStartGroups: (groupIDs: number[]) => void;
  onStop: () => void;
};

function multiSelectValue(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.target.selectedOptions).map((option) => option.value);
}

export function MonitorToolbar({
  filters,
  options,
  quickRange,
  customStart,
  customEnd,
  settings,
  groups,
  probeRunning,
  onFilterChange,
  onQuickRangeChange,
  onCustomStartChange,
  onCustomEndChange,
  onSettingsPatch,
  onStartAll,
  onStartGroups,
  onStop
}: Props) {
  const selectedGroupIDs = useMemo(
    () => groups.filter((group) => filters.groups.includes(group.name)).map((group) => group.id),
    [groups, filters.groups]
  );

  return (
    <div className="panel toolbar-panel">
      <div className="toolbar-grid">
        <div className="toolbar-block">
          <div className="toolbar-title">Time Range</div>
          <div className="quick-range-row">
            {[
              { id: "5m", label: "Last 5m" },
              { id: "30m", label: "Last 30m" },
              { id: "1h", label: "Last 1h" },
              { id: "12h", label: "Last 12h" },
              { id: "24h", label: "Last 24h" },
              { id: "custom", label: "Custom" }
            ].map((item) => (
              <button
                key={item.id}
                className={`chip ${quickRange === item.id ? "chip-active" : ""}`}
                onClick={() => onQuickRangeChange(item.id as QuickRange)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="custom-time-row">
            <input
              type="datetime-local"
              value={customStart}
              onChange={(event) => onCustomStartChange(event.target.value)}
            />
            <input
              type="datetime-local"
              value={customEnd}
              onChange={(event) => onCustomEndChange(event.target.value)}
            />
          </div>
        </div>

        <div className="toolbar-block">
          <div className="toolbar-title">Filters</div>
          <div className="filter-grid">
            <label>
              VLAN
              <select
                multiple
                value={filters.vlan}
                onChange={(event) => onFilterChange({ ...filters, vlan: multiSelectValue(event) })}
              >
                {(options?.vlan || []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Switch
              <select
                multiple
                value={filters.switches}
                onChange={(event) => onFilterChange({ ...filters, switches: multiSelectValue(event) })}
              >
                {(options?.switch || []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Port
              <select
                multiple
                value={filters.ports}
                onChange={(event) => onFilterChange({ ...filters, ports: multiSelectValue(event) })}
              >
                {(options?.port || []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Group
              <select
                multiple
                value={filters.groups}
                onChange={(event) => onFilterChange({ ...filters, groups: multiSelectValue(event) })}
              >
                {(options?.group || []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="toolbar-block">
          <div className="toolbar-title">Probe Control</div>
          <div className="button-row">
            <button className="btn btn-primary" onClick={onStartAll}>
              Start All
            </button>
            <button
              className="btn"
              onClick={() => onStartGroups(selectedGroupIDs)}
              disabled={selectedGroupIDs.length === 0}
            >
              Start Groups
            </button>
            <button className="btn btn-danger" onClick={onStop}>
              Stop
            </button>
          </div>
          <div className="status-row">Probe status: {probeRunning ? "Running" : "Stopped"}</div>
        </div>

        <div className="toolbar-block">
          <div className="toolbar-title">Global Settings</div>
          <div className="setting-row">
            <label>
              Ping Interval (1-30s)
              <input
                type="number"
                min={1}
                max={30}
                value={settings?.ping_interval_sec ?? 1}
                onChange={(event) =>
                  settings &&
                  onSettingsPatch({
                    ...settings,
                    ping_interval_sec: Number(event.target.value)
                  })
                }
              />
            </label>
            <label>
              ICMP Payload (bytes)
              <input
                type="number"
                min={8}
                max={1400}
                value={settings?.icmp_payload_bytes ?? 56}
                onChange={(event) =>
                  settings &&
                  onSettingsPatch({
                    ...settings,
                    icmp_payload_bytes: Number(event.target.value)
                  })
                }
              />
            </label>
            <label>
              Auto Refresh (1-60s)
              <input
                type="number"
                min={1}
                max={60}
                value={settings?.auto_refresh_sec ?? 10}
                onChange={(event) =>
                  settings &&
                  onSettingsPatch({
                    ...settings,
                    auto_refresh_sec: Number(event.target.value)
                  })
                }
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
