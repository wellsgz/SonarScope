import { useMemo, type ChangeEvent } from "react";
import type { FilterOptions, MonitorDataScope, Settings } from "../types/api";
import type { QuickRange } from "../hooks/time";

export type FilterState = {
  vlan: string[];
  switches: string[];
  ports: string[];
  groups: string[];
};

type Props = {
  filters: FilterState;
  customFields: Array<{ slot: 1 | 2 | 3; name: string }>;
  hostnameSearch: string;
  macSearch: string;
  customSearch: {
    custom1: string;
    custom2: string;
    custom3: string;
  };
  ipListSearch: string;
  options?: FilterOptions;
  quickRange: QuickRange;
  customStart: string;
  customEnd: string;
  dataScope: MonitorDataScope;
  settings?: Settings;
  onFilterChange: (next: FilterState) => void;
  onClearFilter: (key: keyof FilterState) => void;
  onClearAllFilters: () => void;
  onHostnameSearchChange: (next: string) => void;
  onMACSearchChange: (next: string) => void;
  onCustomSearchChange: (slot: 1 | 2 | 3, next: string) => void;
  onIPListSearchChange: (next: string) => void;
  onClearHostnameSearch: () => void;
  onClearMACSearch: () => void;
  onClearCustomSearch: (slot: 1 | 2 | 3) => void;
  onClearIPListSearch: () => void;
  onQuickRangeChange: (next: QuickRange) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onDataScopeChange: (next: MonitorDataScope) => void;
  onSettingsPatch: (next: Settings) => void;
};

function multiSelectValue(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.target.selectedOptions).map((option) => option.value);
}

function customSearchValueBySlot(
  customSearch: { custom1: string; custom2: string; custom3: string },
  slot: 1 | 2 | 3
): string {
  if (slot === 1) return customSearch.custom1;
  if (slot === 2) return customSearch.custom2;
  return customSearch.custom3;
}

export function MonitorToolbar({
  filters,
  customFields,
  hostnameSearch,
  macSearch,
  customSearch,
  ipListSearch,
  options,
  quickRange,
  customStart,
  customEnd,
  dataScope,
  settings,
  onFilterChange,
  onClearFilter,
  onClearAllFilters,
  onHostnameSearchChange,
  onMACSearchChange,
  onCustomSearchChange,
  onIPListSearchChange,
  onClearHostnameSearch,
  onClearMACSearch,
  onClearCustomSearch,
  onClearIPListSearch,
  onQuickRangeChange,
  onCustomStartChange,
  onCustomEndChange,
  onDataScopeChange,
  onSettingsPatch
}: Props) {
  const filterCards: Array<{ key: keyof FilterState; label: string; options: string[] }> = [
    { key: "vlan", label: "VLAN", options: options?.vlan || [] },
    { key: "switches", label: "Switch", options: options?.switch || [] },
    { key: "ports", label: "Port", options: options?.port || [] },
    { key: "groups", label: "Group", options: options?.group || [] }
  ];
  const selectedFilterCount = filterCards.reduce((total, card) => total + filters[card.key].length, 0);
  const ipListCount = useMemo(
    () =>
      ipListSearch
        .split(/[,\n\r\t ]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0).length,
    [ipListSearch]
  );

  return (
    <div className="panel toolbar-panel">
      <div className="toolbar-grid">
        <section className="toolbar-block toolbar-block-scope" aria-label="Data scope and window controls">
          <div className="toolbar-title">Data Scope &amp; Window</div>
          <div className="quick-range-row scope-toggle-row">
            <button
              type="button"
              className={`chip ${dataScope === "live" ? "chip-active" : ""}`}
              onClick={() => onDataScopeChange("live")}
            >
              Live Snapshot
            </button>
            <button
              type="button"
              className={`chip ${dataScope === "range" ? "chip-active" : ""}`}
              onClick={() => onDataScopeChange("range")}
            >
              Selected Range
            </button>
          </div>
          <span className="field-help">
            {dataScope === "live"
              ? "Live Snapshot: middle pane shows current endpoint counters."
              : "Selected Range: middle pane counters are recalculated for the chosen window."}
          </span>
          {dataScope === "range" ? (
            <>
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
                    type="button"
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
                  aria-label="Custom start time"
                />
                <input
                  type="datetime-local"
                  value={customEnd}
                  onChange={(event) => onCustomEndChange(event.target.value)}
                  aria-label="Custom end time"
                />
              </div>
            </>
          ) : null}
        </section>

        <section className="toolbar-block toolbar-block-filters" aria-label="Endpoint filters">
          <div className="toolbar-title toolbar-title-row">
            <span>Filters</span>
            <button className="btn btn-small" type="button" onClick={onClearAllFilters}>
              Clear All
            </button>
          </div>
          <div className="monitor-search-grid monitor-search-grid-compact">
            <div className="search-dual-row">
              <label>
                Hostname Search
                <div className="search-input-row search-input-row-compact">
                  <input
                    type="text"
                    value={hostnameSearch}
                    onChange={(event) => onHostnameSearchChange(event.target.value)}
                    placeholder="Contains match"
                    aria-label="Search hostname"
                  />
                  {hostnameSearch.trim() ? (
                    <button className="btn btn-small btn-icon" type="button" onClick={onClearHostnameSearch}>
                      ×
                    </button>
                  ) : null}
                </div>
              </label>
              <label>
                MAC Address Search
                <div className="search-input-row search-input-row-compact">
                  <input
                    type="text"
                    value={macSearch}
                    onChange={(event) => onMACSearchChange(event.target.value)}
                    placeholder="Contains match"
                    aria-label="Search MAC address"
                  />
                  {macSearch.trim() ? (
                    <button className="btn btn-small btn-icon" type="button" onClick={onClearMACSearch}>
                      ×
                    </button>
                  ) : null}
                </div>
              </label>
            </div>
            {customFields.length > 0 ? (
              <div className="search-dual-row">
                {customFields.map((field) => {
                  const slot = field.slot as 1 | 2 | 3;
                  const value = customSearchValueBySlot(customSearch, slot);
                  return (
                    <label key={`monitor-custom-search-${field.slot}`}>
                      {field.name} Search
                      <div className="search-input-row search-input-row-compact">
                        <input
                          type="text"
                          value={value}
                          onChange={(event) => onCustomSearchChange(slot, event.target.value)}
                          placeholder="Contains match"
                          aria-label={`Search ${field.name}`}
                        />
                        {value.trim() ? (
                          <button className="btn btn-small btn-icon" type="button" onClick={() => onClearCustomSearch(slot)}>
                            ×
                          </button>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : null}
            <details className="filter-card filter-ip-details" open={ipListCount > 0}>
              <summary className="filter-card-summary">
                <span>IP Search List</span>
                <span className="count-badge">{ipListCount}</span>
              </summary>
              <div className="filter-card-body">
                <textarea
                  rows={2}
                  value={ipListSearch}
                  onChange={(event) => onIPListSearchChange(event.target.value)}
                  placeholder="10.0.0.1,10.0.0.2 or newline separated"
                  aria-label="Search by IP list"
                />
                <div className="search-input-row">
                  <span className="field-help">IP list overrides hostname, MAC, and custom field searches when provided.</span>
                  <button className="btn btn-small" type="button" onClick={onClearIPListSearch}>
                    Clear
                  </button>
                </div>
              </div>
            </details>
          </div>
          <details className="filter-card advanced-filter-details" open={selectedFilterCount > 0}>
            <summary className="filter-card-summary">
              <span>Advanced Filters</span>
              <span className="count-badge">{selectedFilterCount}</span>
            </summary>
            <div className="filter-card-body">
              <div className="filter-stack">
                {filterCards.map((filterCard) => {
                  const selectedValues = filters[filterCard.key];
                  return (
                    <details key={filterCard.key} className="filter-card" open={selectedValues.length > 0}>
                      <summary className="filter-card-summary">
                        <span>{filterCard.label}</span>
                        <span className="count-badge">{selectedValues.length}</span>
                      </summary>
                      <div className="filter-card-body">
                        <div className="filter-card-actions">
                          <span>{selectedValues.length} selected</span>
                          <button className="btn-link" type="button" onClick={() => onClearFilter(filterCard.key)}>
                            Clear
                          </button>
                        </div>
                        <select
                          multiple
                          value={selectedValues}
                          onChange={(event) =>
                            onFilterChange({
                              ...filters,
                              [filterCard.key]: multiSelectValue(event)
                            })
                          }
                          aria-label={`${filterCard.label} filter`}
                        >
                          {filterCard.options.map((item) => (
                            <option key={item} value={item}>
                              {item}
                            </option>
                          ))}
                        </select>
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          </details>
        </section>

        <section className="toolbar-block" aria-label="Global settings controls">
          <div className="toolbar-title">Global Settings</div>
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
            ICMP Payload (8-1400 bytes)
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
            ICMP Timeout (20-1000ms)
            <input
              type="number"
              min={20}
              max={1000}
              value={settings?.icmp_timeout_ms ?? 500}
              onChange={(event) =>
                settings &&
                onSettingsPatch({
                  ...settings,
                  icmp_timeout_ms: Number(event.target.value)
                })
              }
            />
          </label>
        </section>
      </div>
    </div>
  );
}
