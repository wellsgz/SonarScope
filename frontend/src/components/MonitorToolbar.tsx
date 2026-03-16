import { useMemo, useState } from "react";
import type { FilterOptions, MonitorDataScope } from "../types/api";
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
};

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
  onDataScopeChange
}: Props) {
  const initialFilterSearch: Record<keyof FilterState, string> = {
    vlan: "",
    switches: "",
    ports: "",
    groups: ""
  };
  const filterCards: Array<{ key: keyof FilterState; label: string; options: string[] }> = [
    { key: "vlan", label: "VLAN", options: options?.vlan || [] },
    { key: "switches", label: "Switch", options: options?.switch || [] },
    { key: "ports", label: "Port", options: options?.port || [] },
    { key: "groups", label: "Group", options: options?.group || [] }
  ];
  const [filterSearch, setFilterSearch] = useState<Record<keyof FilterState, string>>(initialFilterSearch);
  const selectedFilterCount = filterCards.reduce((total, card) => total + filters[card.key].length, 0);
  const ipListCount = useMemo(
    () =>
      ipListSearch
        .split(/[,\n\r\t ]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0).length,
    [ipListSearch]
  );
  const activeTextSearchCount = useMemo(
    () =>
      [hostnameSearch, macSearch, ...customFields.map((field) => customSearchValueBySlot(customSearch, field.slot))]
        .map((value) => value.trim())
        .filter((value) => value.length > 0).length,
    [customFields, customSearch, hostnameSearch, macSearch]
  );
  const hasAnyTextSearch = activeTextSearchCount > 0;

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
              ? "Live Snapshot: middle pane shows current endpoint counters, chart uses a rolling last 30 minutes, and color highlights apply only to actively probed endpoints."
              : "Selected Range: middle pane counters and chart are recalculated for the chosen window."}
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
            <button
              className="btn btn-small"
              type="button"
              onClick={() => {
                onClearAllFilters();
                setFilterSearch(initialFilterSearch);
              }}
            >
              Clear All
            </button>
          </div>
          <div className="toolbar-block-filters-scroll">
            <details className="filter-card" open={hasAnyTextSearch}>
              <summary className="filter-card-summary">
                <span>Text Search</span>
                <span className="count-badge">{activeTextSearchCount}</span>
              </summary>
              <div className="filter-card-body">
                <div className="monitor-search-grid monitor-search-grid-compact">
                  <div className="search-dual-row">
                    <label>
                      Hostname
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
                      MAC Address
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
                            {field.name}
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
                </div>
              </div>
            </details>
            <div className="monitor-search-grid monitor-search-grid-compact">
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
                    const searchValue = filterSearch[filterCard.key];
                    const filteredOptions = filterCard.options.filter((option) =>
                      searchValue.trim() === "" ? true : option.toLowerCase().includes(searchValue.trim().toLowerCase())
                    );
                    return (
                      <div key={filterCard.key} className="filter-card">
                        <div className="filter-card-summary filter-card-summary-static">
                          <span>{filterCard.label}</span>
                          <span className="count-badge">{selectedValues.length}</span>
                        </div>
                        <div className="filter-card-body">
                          <div className="filter-card-actions">
                            <span>{selectedValues.length} selected</span>
                            <button
                              className="btn-link"
                              type="button"
                              onClick={() => {
                                onClearFilter(filterCard.key);
                                setFilterSearch((prev) => ({ ...prev, [filterCard.key]: "" }));
                              }}
                            >
                              Clear
                            </button>
                          </div>
                          {filterCard.options.length > 0 ? (
                            <div className="filter-search-select">
                              {selectedValues.length > 0 ? (
                                <div className="filter-chips">
                                  {selectedValues.map((value) => (
                                    <span key={value} className="filter-chip">
                                      {value}
                                      <button
                                        type="button"
                                        className="filter-chip-remove"
                                        aria-label={`Remove ${value} from ${filterCard.label} filter`}
                                        onClick={() =>
                                          onFilterChange({
                                            ...filters,
                                            [filterCard.key]: selectedValues.filter((item) => item !== value)
                                          })
                                        }
                                      >
                                        ×
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              <input
                                type="text"
                                value={searchValue}
                                onChange={(event) =>
                                  setFilterSearch((prev) => ({ ...prev, [filterCard.key]: event.target.value }))
                                }
                                placeholder={`Search ${filterCard.label}...`}
                                aria-label={`Search ${filterCard.label} options`}
                              />
                              <div className="filter-options-list" aria-label={`${filterCard.label} filter options`}>
                                {filteredOptions.map((option) => {
                                  const isSelected = selectedValues.includes(option);
                                  return (
                                    <button
                                      key={option}
                                      type="button"
                                      className={`filter-option ${isSelected ? "is-selected" : ""}`}
                                      aria-pressed={isSelected}
                                      onClick={() => {
                                        const nextValues = isSelected
                                          ? selectedValues.filter((item) => item !== option)
                                          : [...selectedValues, option];
                                        onFilterChange({
                                          ...filters,
                                          [filterCard.key]: nextValues
                                        });
                                      }}
                                    >
                                      <span>{option}</span>
                                      {isSelected ? <span aria-hidden="true">✓</span> : null}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <span className="field-help">No options available yet.</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>
          </div>
        </section>

      </div>
    </div>
  );
}
