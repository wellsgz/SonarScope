import { useMemo } from "react";
import type { MonitorDataScope, MonitorEndpoint, MonitorSortField } from "../types/api";

type Props = {
  rows: MonitorEndpoint[];
  customFields: Array<{ slot: 1 | 2 | 3; name: string }>;
  selectedEndpointID: number | null;
  onSelectionChange: (id: number | null) => void;
  page: number;
  pageSize: 50 | 100 | 200;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: 50 | 100 | 200) => void;
  dataScope: MonitorDataScope;
  sortableFields: MonitorSortField[];
  sortBy: MonitorSortField | null;
  sortDir: "asc" | "desc" | null;
  probeRunning: boolean;
  probeScope: "all" | "groups" | "";
  activeProbeGroupNames: Set<string>;
  onSortChange: (sortBy: MonitorSortField | null, sortDir: "asc" | "desc" | null) => void;
};

type MonitorColumn = {
  key: string;
  header: string;
  sortable?: MonitorSortField;
  render: (row: MonitorEndpoint) => string;
};

type EndpointHealth = "healthy" | "unhealthy" | "no_data";
type LiveProbeContext = {
  probeRunning: boolean;
  probeScope: "all" | "groups" | "";
  activeProbeGroupNames: Set<string>;
};

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatLatency(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value.toFixed(2)} ms`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function customFieldValueBySlot(row: MonitorEndpoint, slot: 1 | 2 | 3): string {
  if (slot === 1) return row.custom_field_1_value || "-";
  if (slot === 2) return row.custom_field_2_value || "-";
  return row.custom_field_3_value || "-";
}

function normalizeGroupName(groupName: string): string {
  return groupName.trim().toLowerCase();
}

function isActivelyProbedLiveRow(row: MonitorEndpoint, liveProbeContext: LiveProbeContext): boolean {
  if (!liveProbeContext.probeRunning) {
    return false;
  }
  if (liveProbeContext.probeScope === "all") {
    return true;
  }
  if (liveProbeContext.probeScope !== "groups" || liveProbeContext.activeProbeGroupNames.size === 0) {
    return false;
  }
  return row.group.some((groupName) => liveProbeContext.activeProbeGroupNames.has(normalizeGroupName(groupName)));
}

function endpointHealth(
  row: MonitorEndpoint,
  dataScope: MonitorDataScope,
  liveProbeContext: LiveProbeContext
): EndpointHealth {
  if (row.total_sent_ping <= 0) {
    return "no_data";
  }

  if (dataScope === "range") {
    return row.failed_count > 0 ? "unhealthy" : "healthy";
  }

  if (!isActivelyProbedLiveRow(row, liveProbeContext)) {
    return "no_data";
  }

  const status = (row.last_ping_status || "").trim().toLowerCase();
  const liveFailure = row.consecutive_failed_count > 0 || (status.length > 0 && status !== "succeeded");
  return liveFailure ? "unhealthy" : "healthy";
}

function rowHealthClassName(health: EndpointHealth): string {
  if (health === "healthy") {
    return "monitor-row-health-healthy";
  }
  if (health === "unhealthy") {
    return "monitor-row-health-unhealthy";
  }
  return "monitor-row-health-no-data";
}

const baseColumns: MonitorColumn[] = [
  { key: "hostname", header: "Hostname", render: (row) => row.hostname || "-" },
  { key: "ip_address", header: "IP Address", render: (row) => row.ip_address },
  {
    key: "last_success_on",
    header: "Last Success On",
    sortable: "last_success_on",
    render: (row) => formatDate(row.last_success_on)
  },
  {
    key: "last_failed_on",
    header: "Last Failed On",
    sortable: "last_failed_on",
    render: (row) => formatDate(row.last_failed_on)
  },
  { key: "mac_address", header: "MAC Address", render: (row) => row.mac_address || "-" },
  { key: "reply_ip_address", header: "Reply IP", render: (row) => row.reply_ip_address || "-" },
  { key: "success_count", header: "Success Count", sortable: "success_count", render: (row) => String(row.success_count) },
  {
    key: "failed_count",
    header: "Failed Count",
    sortable: "failed_count",
    render: (row) => String(row.failed_count)
  },
  {
    key: "consecutive_failed_count",
    header: "Consecutive Failed",
    sortable: "consecutive_failed_count",
    render: (row) => String(row.consecutive_failed_count)
  },
  {
    key: "max_consecutive_failed_count",
    header: "Max Consecutive Failed",
    sortable: "max_consecutive_failed_count",
    render: (row) => String(row.max_consecutive_failed_count)
  },
  {
    key: "max_consecutive_failed_count_time",
    header: "Max Consec Failed Time",
    sortable: "max_consecutive_failed_count_time",
    render: (row) => formatDate(row.max_consecutive_failed_count_time)
  },
  {
    key: "failed_pct",
    header: "Failed %",
    sortable: "failed_pct",
    render: (row) => formatPercent(row.failed_pct)
  },
  { key: "total_sent_ping", header: "Total Sent Ping", render: (row) => String(row.total_sent_ping) },
  { key: "last_ping_status", header: "Last Ping Status", render: (row) => row.last_ping_status || "-" },
  {
    key: "last_ping_latency",
    header: "Last Ping Latency",
    sortable: "last_ping_latency",
    render: (row) => formatLatency(row.last_ping_latency)
  },
  {
    key: "average_latency",
    header: "Average Latency",
    sortable: "average_latency",
    render: (row) => formatLatency(row.average_latency)
  },
  { key: "vlan", header: "VLAN", render: (row) => row.vlan || "-" },
  { key: "switch", header: "Switch", render: (row) => row.switch || "-" },
  { key: "port", header: "Port", render: (row) => row.port || "-" },
  { key: "port_type", header: "Port Type", render: (row) => row.port_type || "-" },
  { key: "group", header: "Group", render: (row) => row.group.join(", ") || "-" }
];

export function MonitorTable({
  rows,
  customFields,
  selectedEndpointID,
  onSelectionChange,
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
  dataScope,
  sortableFields,
  sortBy,
  sortDir,
  probeRunning,
  probeScope,
  activeProbeGroupNames,
  onSortChange
}: Props) {
  const sortableSet = useMemo(() => new Set<MonitorSortField>(sortableFields), [sortableFields]);
  const liveProbeContext = useMemo(
    () => ({
      probeRunning,
      probeScope,
      activeProbeGroupNames
    }),
    [probeRunning, probeScope, activeProbeGroupNames]
  );
  const columns = useMemo(() => {
    const dynamicCustomColumns: MonitorColumn[] = customFields.map((field) => ({
      key: `custom_field_${field.slot}_value`,
      header: field.name,
      render: (row) => customFieldValueBySlot(row, field.slot)
    }));

    return [...baseColumns, ...dynamicCustomColumns];
  }, [customFields]);

  const pageOptions = useMemo(() => {
    if (totalPages < 1) {
      return [1];
    }
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }, [totalPages]);

  const startItem = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = totalItems === 0 ? 0 : Math.min(page * pageSize, totalItems);

  const toggleSort = (field: MonitorSortField) => {
    if (sortBy !== field) {
      onSortChange(field, "desc");
      return;
    }
    if (sortDir === "desc") {
      onSortChange(field, "asc");
      return;
    }
    onSortChange(null, null);
  };

  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table className="monitor-table">
          <thead>
            <tr>
              {columns.map((column) => {
                const sortable = Boolean(column.sortable && sortableSet.has(column.sortable));
                const active = sortable && sortBy === column.sortable;
                const ariaSort = active ? (sortDir === "asc" ? "ascending" : "descending") : "none";
                const indicator = !sortable ? "" : !active ? "↕" : sortDir === "desc" ? "↓" : "↑";

                return (
                  <th key={column.key} aria-sort={ariaSort}>
                    {sortable && column.sortable ? (
                      <button
                        type="button"
                        className={`table-sort-button ${active ? "table-sort-button-active" : ""}`}
                        onClick={() => toggleSort(column.sortable!)}
                        aria-label={`Sort by ${column.header}`}
                      >
                        <span>{column.header}</span>
                        <span className="table-sort-indicator" aria-hidden>
                          {indicator}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const endpointID = row.endpoint_id;
              const selected = selectedEndpointID === endpointID;
              const health = endpointHealth(row, dataScope, liveProbeContext);
              const rowClassName = `${rowHealthClassName(health)}${selected ? " row-selected" : ""}`;
              return (
                <tr
                  key={endpointID}
                  className={rowClassName}
                  onClick={() => onSelectionChange(selected ? null : endpointID)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectionChange(selected ? null : endpointID);
                    }
                  }}
                  tabIndex={0}
                  aria-selected={selected}
                >
                  {columns.map((column) => {
                    return (
                      <td key={`${endpointID}-${column.key}`}>
                        {column.render(row)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <div className="table-summary">
          Showing {startItem}-{endItem} of {totalItems}
        </div>

        <div className="table-pagination" aria-label="Monitor pagination controls">
          <div className="table-pagination-control">
            <span className="table-pagination-label">Rows</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value) as 50 | 100 | 200)}
              aria-label="Rows per page"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </div>

          <button type="button" className="btn btn-small" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
            Prev
          </button>

          <div className="table-pagination-control">
            <span className="table-pagination-label">Page</span>
            <select
              value={Math.min(page, Math.max(totalPages, 1))}
              onChange={(event) => onPageChange(Number(event.target.value))}
              aria-label="Page selection"
              disabled={totalPages <= 1}
            >
              {pageOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <span className="table-total-pages">/ {Math.max(totalPages, 1)}</span>

          <button
            type="button"
            className="btn btn-small"
            onClick={() => onPageChange(page + 1)}
            disabled={totalPages === 0 || page >= totalPages}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
