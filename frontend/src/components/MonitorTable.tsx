import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import type { MonitorDataScope, MonitorEndpoint, MonitorSortCriterion, MonitorSortField } from "../types/api";

type Props = {
  rows: MonitorEndpoint[];
  customFields: Array<{ slot: number; name: string }>;
  columnVisibility: Record<string, boolean>;
  columnOrder: string[];
  selectedEndpointIDs: number[];
  onSelectionChange: (ids: number[]) => void;
  selectionMode?: "none" | "replace" | "multi";
  page: number;
  pageSize: 50 | 100 | 200;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: 50 | 100 | 200) => void;
  dataScope: MonitorDataScope;
  sortableFields: MonitorSortField[];
  sortCriteria: MonitorSortCriterion[];
  multiSortEnabled?: boolean;
  probeRunning: boolean;
  probeScope: "all" | "groups" | "";
  activeProbeGroupNames: Set<string>;
  onSortChange: (criteria: MonitorSortCriterion[]) => void;
  onToggleColumnVisibility: (key: string) => void;
  onColumnOrderChange: (order: string[]) => void;
  onResetColumnPreferences: () => void;
  actionSlot?: ReactNode;
  showSelectionCheckboxes?: boolean;
  preserveRelativeScroll?: boolean;
  refreshSignal?: number;
  emptyMessage?: string;
  switchIPMap?: Record<string, string>;
};

type MonitorColumn = {
  key: string;
  menuLabel: string;
  header: string;
  sortable?: MonitorSortField;
  render: (row: MonitorEndpoint) => ReactNode;
};

type EndpointHealth = "healthy" | "unhealthy" | "no_data";
type LiveProbeContext = {
  probeRunning: boolean;
  probeScope: "all" | "groups" | "";
  activeProbeGroupNames: Set<string>;
};

type HorizontalScrollMetrics = {
  hasOverflow: boolean;
  viewportWidth: number;
  contentWidth: number;
  railWidth: number;
  scrollLeft: number;
};

type HeaderLayout = {
  widths: number[];
  height: number;
  tableWidth: number;
};

type HeaderAriaSort = "none" | "ascending" | "descending" | "other";

type HeaderColumnState = MonitorColumn & {
  sortField?: MonitorSortField;
  isSortable: boolean;
  sortState?: { index: number; criterion: MonitorSortCriterion };
  active: boolean;
  ariaSort: HeaderAriaSort;
  indicator: string;
};

const defaultHorizontalScrollMetrics: HorizontalScrollMetrics = {
  hasOverflow: false,
  viewportWidth: 0,
  contentWidth: 0,
  railWidth: 0,
  scrollLeft: 0
};

const defaultHeaderLayout: HeaderLayout = {
  widths: [],
  height: 0,
  tableWidth: 0
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

function customFieldValueBySlot(row: MonitorEndpoint, slot: number): string {
  return (row[`custom_field_${slot}_value` as keyof MonitorEndpoint] as string | undefined) || "-";
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

type BaseColumnDefinition = {
  key: string;
  menuLabel: string;
  header: string;
  sortable?: MonitorSortField;
  render: (row: MonitorEndpoint) => ReactNode;
};

const baseColumnDefinitions: BaseColumnDefinition[] = [
  { key: "hostname", menuLabel: "Hostname", header: "Hostname", render: (row) => row.hostname || "-" },
  { key: "ip_address", menuLabel: "IP Address", header: "IP Address", render: (row) => row.ip_address },
  {
    key: "last_success_on",
    menuLabel: "Last Success On",
    header: "Last Success On",
    sortable: "last_success_on",
    render: (row) => formatDate(row.last_success_on)
  },
  {
    key: "last_failed_on",
    menuLabel: "Last Failed On",
    header: "Last Failed On",
    sortable: "last_failed_on",
    render: (row) => formatDate(row.last_failed_on)
  },
  { key: "mac_address", menuLabel: "MAC Address", header: "MAC Address", render: (row) => row.mac_address || "-" },
  { key: "reply_ip_address", menuLabel: "Reply IP", header: "Reply IP", render: (row) => row.reply_ip_address || "-" },
  {
    key: "success_count",
    menuLabel: "Success Count",
    header: "Success Count",
    sortable: "success_count",
    render: (row) => String(row.success_count)
  },
  {
    key: "failed_count",
    menuLabel: "Failed Count",
    header: "Failed Count",
    sortable: "failed_count",
    render: (row) => String(row.failed_count)
  },
  {
    key: "consecutive_failed_count",
    menuLabel: "Consecutive Failed",
    header: "Consec. Failed",
    sortable: "consecutive_failed_count",
    render: (row) => String(row.consecutive_failed_count)
  },
  {
    key: "max_consecutive_failed_count",
    menuLabel: "Max Consecutive Failed",
    header: "Max Consec. Failed",
    sortable: "max_consecutive_failed_count",
    render: (row) => String(row.max_consecutive_failed_count)
  },
  {
    key: "max_consecutive_failed_count_time",
    menuLabel: "Max Consecutive Failed Time",
    header: "Max Consec. Failed Time",
    sortable: "max_consecutive_failed_count_time",
    render: (row) => formatDate(row.max_consecutive_failed_count_time)
  },
  {
    key: "failed_pct",
    menuLabel: "Failed %",
    header: "Failed %",
    sortable: "failed_pct",
    render: (row) => formatPercent(row.failed_pct)
  },
  { key: "total_sent_ping", menuLabel: "Total Sent Ping", header: "Total Sent", render: (row) => String(row.total_sent_ping) },
  {
    key: "last_ping_status",
    menuLabel: "Last Ping Status",
    header: "Last Status",
    sortable: "last_ping_status",
    render: (row) => row.last_ping_status || "-"
  },
  {
    key: "last_ping_latency",
    menuLabel: "Last Ping Latency",
    header: "Last Latency",
    sortable: "last_ping_latency",
    render: (row) => formatLatency(row.last_ping_latency)
  },
  {
    key: "average_latency",
    menuLabel: "Average Latency",
    header: "Avg. Latency",
    sortable: "average_latency",
    render: (row) => formatLatency(row.average_latency)
  },
  { key: "vlan", menuLabel: "VLAN", header: "VLAN", render: (row) => row.vlan || "-" },
  { key: "zone", menuLabel: "Zone", header: "Zone", render: (row) => row.zone || "-" },
  { key: "switch", menuLabel: "Switch", header: "Switch", render: (row) => row.switch || "-" },
  { key: "port", menuLabel: "Port", header: "Port", render: (row) => row.port || "-" },
  { key: "port_type", menuLabel: "Port Type", header: "Port Type", render: (row) => row.port_type || "-" },
  { key: "gateway", menuLabel: "Gateway", header: "Gateway", render: (row) => row.gateway || "-" },
  { key: "mgmt_ip", menuLabel: "Mgmt IP", header: "Mgmt IP", render: (row) => row.mgmt_ip || "-" },
  { key: "speed", menuLabel: "Speed", header: "Speed", render: (row) => row.speed || "-" },
  { key: "duplex", menuLabel: "Duplex", header: "Duplex", render: (row) => row.duplex || "-" },
  { key: "group", menuLabel: "Group", header: "Group", render: (row) => row.group.join(", ") || "-" }
];

export const monitorBuiltInColumnKeys = baseColumnDefinitions.map((column) => column.key);

export function MonitorTable({
  rows,
  customFields,
  columnVisibility,
  columnOrder,
  selectedEndpointIDs,
  onSelectionChange,
  selectionMode = "replace",
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
  dataScope,
  sortableFields,
  sortCriteria,
  multiSortEnabled = false,
  probeRunning,
  probeScope,
  activeProbeGroupNames,
  onSortChange,
  onToggleColumnVisibility,
  onColumnOrderChange,
  onResetColumnPreferences,
  actionSlot,
  showSelectionCheckboxes = false,
  preserveRelativeScroll = false,
  refreshSignal,
  emptyMessage = "No endpoints match the active filters.",
  switchIPMap
}: Props) {
  const sortableSet = useMemo(() => new Set<MonitorSortField>(sortableFields), [sortableFields]);
  const selectedEndpointIDSet = useMemo(() => new Set<number>(selectedEndpointIDs), [selectedEndpointIDs]);
  const visibleEndpointIDs = useMemo(() => rows.map((row) => row.endpoint_id), [rows]);
  const sortIndexByField = useMemo(() => {
    const entries = sortCriteria.map((criterion, index) => [criterion.field, { index, criterion }] as const);
    return new Map(entries);
  }, [sortCriteria]);
  const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const verticalScrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const horizontalRailRef = useRef<HTMLDivElement | null>(null);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionAnchorEndpointIDRef = useRef<number | null>(null);
  const relativeScrollRef = useRef(0);
  const horizontalFrameRef = useRef(0);
  const thumbDragRef = useRef<{ pointerID: number; startX: number; startScrollLeft: number } | null>(null);
  const draggingColumnKeyRef = useRef<string | null>(null);
  const [horizontalMetrics, setHorizontalMetrics] = useState<HorizontalScrollMetrics>(defaultHorizontalScrollMetrics);
  const [headerLayout, setHeaderLayout] = useState<HeaderLayout>(defaultHeaderLayout);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [dragOverColumnKey, setDragOverColumnKey] = useState<string | null>(null);
  const liveProbeContext = useMemo(
    () => ({
      probeRunning,
      probeScope,
      activeProbeGroupNames
    }),
    [probeRunning, probeScope, activeProbeGroupNames]
  );
  const allColumns = useMemo(() => {
    const dynamicCustomColumns: MonitorColumn[] = customFields.map((field) => ({
      key: `custom_field_${field.slot}_value`,
      menuLabel: field.name,
      header: field.name,
      render: (row) => customFieldValueBySlot(row, field.slot)
    }));

    const baseColumns = baseColumnDefinitions.map((column) => {
      if (column.key !== "switch") {
        return column;
      }
      return {
        ...column,
        render: (row: MonitorEndpoint) => {
          const value = row.switch || "-";
          const ipAddress = row.switch ? switchIPMap?.[row.switch] : undefined;
          if (!ipAddress) {
            return value;
          }
          return (
            <span
              className="switch-cell-has-ip"
              data-tooltip={`Mgmt IP: ${ipAddress}`}
              aria-label={`${value} (Mgmt IP: ${ipAddress})`}
            >
              {value}
            </span>
          );
        }
      };
    });

    return [...baseColumns, ...dynamicCustomColumns];
  }, [customFields, switchIPMap]);

  const orderedColumns = useMemo(() => {
    const columnMap = new Map(allColumns.map((column) => [column.key, column]));
    const ordered = columnOrder.filter((key) => columnMap.has(key)).map((key) => columnMap.get(key)!);
    allColumns.forEach((column) => {
      if (!columnOrder.includes(column.key)) {
        ordered.push(column);
      }
    });
    return ordered;
  }, [allColumns, columnOrder]);

  const columns = useMemo(
    () => orderedColumns.filter((column) => columnVisibility[column.key] !== false),
    [orderedColumns, columnVisibility]
  );
  const minimumVisibleColumns = Math.min(3, orderedColumns.length);
  const columnLayoutSignature = useMemo(() => columns.map((column) => column.key).join("|"), [columns]);
  const headerColumns = useMemo<HeaderColumnState[]>(
    () =>
      columns.map((column) => {
        const sortField = column.sortable;
        const isSortable = Boolean(sortField && sortableSet.has(sortField));
        const sortState = isSortable && sortField ? sortIndexByField.get(sortField) : undefined;
        const active = Boolean(sortState);
        const isPrimary = active && sortState?.index === 0;
        const ariaSort: HeaderAriaSort = !active
          ? "none"
          : isPrimary
            ? sortState?.criterion.dir === "asc"
              ? "ascending"
              : "descending"
            : "other";
        const indicator = !isSortable
          ? ""
          : !active
            ? "↕"
            : `${sortState?.criterion.dir === "desc" ? "↓" : "↑"}${sortState!.index + 1}`;

        return {
          ...column,
          sortField,
          isSortable,
          sortState,
          active,
          ariaSort,
          indicator
        };
      }),
    [columns, sortIndexByField, sortableSet]
  );

  const pageOptions = useMemo(() => {
    if (totalPages < 1) {
      return [1];
    }
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }, [totalPages]);

  const startItem = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = totalItems === 0 ? 0 : Math.min(page * pageSize, totalItems);

  const toggleSort = (field: MonitorSortField) => {
    const existing = sortIndexByField.get(field);
    if (!existing) {
      const nextCriterion: MonitorSortCriterion = { field, dir: "desc" };
      onSortChange(multiSortEnabled ? [...sortCriteria, nextCriterion] : [nextCriterion]);
      return;
    }
    if (existing.criterion.dir === "desc") {
      const next = sortCriteria.map((criterion, index) =>
        index === existing.index ? { ...criterion, dir: "asc" as const } : criterion
      );
      onSortChange(next);
      return;
    }
    onSortChange(sortCriteria.filter((_, index) => index !== existing.index));
  };

  const headerCellStyle = (width: number | undefined): CSSProperties | undefined => {
    if (!width || width <= 0) {
      return undefined;
    }
    return {
      width,
      minWidth: width,
      maxWidth: width
    };
  };

  const renderHeaderCellInner = (column: HeaderColumnState, interactive: boolean) => {
    const sortField = column.sortField;
    const sortButtonLabel =
      interactive && column.isSortable
        ? `Sort by ${column.menuLabel}${column.active ? ` (${column.sortState!.criterion.dir}, priority ${column.sortState!.index + 1})` : ""}`
        : undefined;

    return (
      <div className="table-column-head">
        <span
          className="table-column-grip"
          draggable={interactive}
          onDragStart={interactive ? (event) => handleColumnDragStart(column.key, event) : undefined}
          onDragEnd={interactive ? clearColumnDragState : undefined}
          aria-hidden
          title={interactive ? `Drag to reorder ${column.menuLabel}` : undefined}
        >
          ⋮⋮
        </span>
        {column.isSortable && sortField ? (
          interactive ? (
            <button
              type="button"
              className={`table-sort-button ${column.active ? "table-sort-button-active" : ""}`}
              onClick={() => toggleSort(sortField)}
              aria-label={sortButtonLabel}
            >
              <span>{column.header}</span>
              <span className="table-sort-indicator" aria-hidden>
                {column.indicator}
              </span>
            </button>
          ) : (
            <span className={`table-sort-button ${column.active ? "table-sort-button-active" : ""} table-sort-button-placeholder`}>
              <span>{column.header}</span>
              <span className="table-sort-indicator" aria-hidden>
                {column.indicator}
              </span>
            </span>
          )
        ) : (
          <span className="table-column-label">{column.header}</span>
        )}
      </div>
    );
  };

  const renderHeaderCell = (column: HeaderColumnState, index: number, interactive: boolean) => {
    const width = headerLayout.widths[showSelectionCheckboxes ? index + 1 : index];
    if (interactive) {
      return (
        <div
          key={column.key}
          role="columnheader"
          aria-sort={column.ariaSort}
          className={`monitor-table-header-cell${dragOverColumnKey === column.key ? " column-drag-over" : ""}`}
          style={headerCellStyle(width)}
          onDragOver={(event) => handleColumnDragOver(column.key, event)}
          onDrop={(event) => handleColumnDrop(column.key, event)}
          onDragLeave={() => {
            if (dragOverColumnKey === column.key) {
              setDragOverColumnKey(null);
            }
          }}
        >
          {renderHeaderCellInner(column, true)}
        </div>
      );
    }

    return (
      <th key={column.key} scope="col" style={headerCellStyle(width)}>
        {renderHeaderCellInner(column, false)}
      </th>
    );
  };

  const toggleMultiSelection = (endpointID: number, selected: boolean) => {
    return selected
      ? selectedEndpointIDs.filter((value) => value !== endpointID)
      : [...selectedEndpointIDs, endpointID];
  };

  const nextSelectionIDs = (
    endpointID: number,
    selected: boolean,
    modifiers?: {
      shiftKey?: boolean;
      metaKey?: boolean;
      ctrlKey?: boolean;
    }
  ) => {
    if (selectionMode === "none") {
      return selectedEndpointIDs;
    }
    if (selectionMode === "replace") {
      return [endpointID];
    }

    if (modifiers?.shiftKey) {
      const anchorID = selectionAnchorEndpointIDRef.current;
      if (anchorID !== null) {
        const anchorIndex = visibleEndpointIDs.indexOf(anchorID);
        const currentIndex = visibleEndpointIDs.indexOf(endpointID);
        if (anchorIndex >= 0 && currentIndex >= 0) {
          const [start, end] = anchorIndex < currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
          const nextRange = visibleEndpointIDs.slice(start, end + 1);
          return Array.from(new Set([...selectedEndpointIDs, ...nextRange]));
        }
      }
    }

    return toggleMultiSelection(endpointID, selected);
  };

  const commitSelectionChange = (
    endpointID: number,
    selected: boolean,
    modifiers?: {
      shiftKey?: boolean;
      metaKey?: boolean;
      ctrlKey?: boolean;
    }
  ) => {
    if (selectionMode === "multi") {
      const hasAnchor = selectionAnchorEndpointIDRef.current !== null;
      const usedShiftRange = Boolean(
        modifiers?.shiftKey &&
          hasAnchor &&
          visibleEndpointIDs.includes(selectionAnchorEndpointIDRef.current!) &&
          visibleEndpointIDs.includes(endpointID)
      );
      if (!usedShiftRange) {
        selectionAnchorEndpointIDRef.current = endpointID;
      }
    }
    onSelectionChange(nextSelectionIDs(endpointID, selected, modifiers));
  };

  useEffect(() => {
    if (selectionMode !== "multi" || selectedEndpointIDs.length === 0) {
      selectionAnchorEndpointIDRef.current = null;
      return;
    }
    if (
      selectionAnchorEndpointIDRef.current !== null &&
      !visibleEndpointIDs.includes(selectionAnchorEndpointIDRef.current)
    ) {
      selectionAnchorEndpointIDRef.current = null;
    }
  }, [selectionMode, selectedEndpointIDs, visibleEndpointIDs]);

  useEffect(() => {
    if (!columnMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!columnMenuRef.current?.contains(event.target as Node)) {
        setColumnMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [columnMenuOpen]);

  const reorderVisibleColumns = (sourceKey: string, targetKey: string) => {
    if (sourceKey === targetKey) {
      return;
    }
    const visibleKeys = columns.map((column) => column.key);
    const sourceIndex = visibleKeys.indexOf(sourceKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }

    const nextVisibleKeys = [...visibleKeys];
    const [movedKey] = nextVisibleKeys.splice(sourceIndex, 1);
    nextVisibleKeys.splice(targetIndex, 0, movedKey);

    const visibleKeySet = new Set(visibleKeys);
    const nextOrder = orderedColumns.map((column) => column.key);
    let visibleIndex = 0;
    for (let index = 0; index < nextOrder.length; index += 1) {
      if (!visibleKeySet.has(nextOrder[index])) {
        continue;
      }
      nextOrder[index] = nextVisibleKeys[visibleIndex];
      visibleIndex += 1;
    }
    onColumnOrderChange(nextOrder);
  };

  const handleColumnDragStart = (columnKey: string, event: React.DragEvent<HTMLElement>) => {
    draggingColumnKeyRef.current = columnKey;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", columnKey);
    setDragOverColumnKey(null);
  };

  const handleColumnDragOver = (columnKey: string, event: React.DragEvent<HTMLElement>) => {
    if (!draggingColumnKeyRef.current || draggingColumnKeyRef.current === columnKey) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverColumnKey(columnKey);
  };

  const clearColumnDragState = () => {
    draggingColumnKeyRef.current = null;
    setDragOverColumnKey(null);
  };

  const handleColumnDrop = (columnKey: string, event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const sourceKey = draggingColumnKeyRef.current || event.dataTransfer.getData("text/plain");
    clearColumnDragState();
    if (!sourceKey) {
      return;
    }
    reorderVisibleColumns(sourceKey, columnKey);
  };

  const updateHorizontalMetrics = (next: HorizontalScrollMetrics) => {
    setHorizontalMetrics((prev) => {
      if (
        prev.hasOverflow === next.hasOverflow &&
        Math.abs(prev.viewportWidth - next.viewportWidth) < 1 &&
        Math.abs(prev.contentWidth - next.contentWidth) < 1 &&
        Math.abs(prev.railWidth - next.railWidth) < 1 &&
        Math.abs(prev.scrollLeft - next.scrollLeft) < 1
      ) {
        return prev;
      }
      return next;
    });
  };

  const updateHeaderLayout = (next: HeaderLayout) => {
    setHeaderLayout((prev) => {
      if (
        prev.widths.length === next.widths.length &&
        Math.abs(prev.height - next.height) < 1 &&
        Math.abs(prev.tableWidth - next.tableWidth) < 1 &&
        prev.widths.every((width, index) => Math.abs(width - next.widths[index]) < 1)
      ) {
        return prev;
      }
      return next;
    });
  };

  const measureHeaderLayout = () => {
    const table = tableRef.current;
    if (!table) {
      return;
    }
    const headerCells = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child > th"));
    if (headerCells.length === 0) {
      updateHeaderLayout(defaultHeaderLayout);
      return;
    }

    const rowHeight = headerCells[0]?.parentElement?.getBoundingClientRect().height ?? 0;
    const widths = headerCells.map((cell) => cell.getBoundingClientRect().width);
    const tableWidth = Math.max(table.scrollWidth, table.getBoundingClientRect().width);

    updateHeaderLayout({
      widths,
      height: rowHeight,
      tableWidth
    });
  };

  const measureHorizontalOverflow = () => {
    const horizontalScroll = horizontalScrollRef.current;
    const table = tableRef.current;
    if (!horizontalScroll || !table) {
      return;
    }

    const viewportWidth = horizontalScroll.clientWidth;
    const contentWidth = Math.max(table.scrollWidth, table.getBoundingClientRect().width);
    const maxScrollLeft = Math.max(0, contentWidth - viewportWidth);
    const scrollLeft = Math.max(0, Math.min(maxScrollLeft, horizontalScroll.scrollLeft));
    if (Math.abs(horizontalScroll.scrollLeft - scrollLeft) >= 1) {
      horizontalScroll.scrollLeft = scrollLeft;
    }

    updateHorizontalMetrics({
      hasOverflow: maxScrollLeft > 1,
      viewportWidth,
      contentWidth,
      railWidth: horizontalRailRef.current?.clientWidth ?? 0,
      scrollLeft
    });
  };

  const captureRelativeScroll = () => {
    if (!preserveRelativeScroll) {
      return;
    }
    const tableScroll = verticalScrollRef.current;
    if (!tableScroll) {
      return;
    }
    const maxScrollTop = tableScroll.scrollHeight - tableScroll.clientHeight;
    if (maxScrollTop <= 0) {
      relativeScrollRef.current = 0;
      return;
    }
    const ratio = tableScroll.scrollTop / maxScrollTop;
    relativeScrollRef.current = Math.max(0, Math.min(1, ratio));
  };

  useLayoutEffect(() => {
    if (!preserveRelativeScroll) {
      return;
    }
    const tableScroll = verticalScrollRef.current;
    if (!tableScroll) {
      return;
    }
    const maxScrollTop = tableScroll.scrollHeight - tableScroll.clientHeight;
    if (maxScrollTop <= 0) {
      tableScroll.scrollTop = 0;
      relativeScrollRef.current = 0;
      return;
    }
    const nextScrollTop = relativeScrollRef.current * maxScrollTop;
    tableScroll.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
  }, [preserveRelativeScroll, refreshSignal]);

  useLayoutEffect(() => {
    const runMeasure = () => {
      if (horizontalFrameRef.current !== 0) {
        window.cancelAnimationFrame(horizontalFrameRef.current);
      }
      horizontalFrameRef.current = window.requestAnimationFrame(() => {
        horizontalFrameRef.current = 0;
        measureHorizontalOverflow();
        measureHeaderLayout();
      });
    };

    runMeasure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        runMeasure();
      });
      if (horizontalScrollRef.current) {
        observer.observe(horizontalScrollRef.current);
      }
      if (tableRef.current) {
        observer.observe(tableRef.current);
      }
      if (horizontalRailRef.current) {
        observer.observe(horizontalRailRef.current);
      }
      return () => {
        observer.disconnect();
        if (horizontalFrameRef.current !== 0) {
          window.cancelAnimationFrame(horizontalFrameRef.current);
          horizontalFrameRef.current = 0;
        }
      };
    }

    window.addEventListener("resize", runMeasure);
    return () => {
      window.removeEventListener("resize", runMeasure);
      if (horizontalFrameRef.current !== 0) {
        window.cancelAnimationFrame(horizontalFrameRef.current);
        horizontalFrameRef.current = 0;
      }
    };
  }, [columnLayoutSignature, horizontalMetrics.hasOverflow, refreshSignal, rows.length, showSelectionCheckboxes]);

  useEffect(() => {
    return () => {
      thumbDragRef.current = null;
      if (horizontalFrameRef.current !== 0) {
        window.cancelAnimationFrame(horizontalFrameRef.current);
      }
    };
  }, []);

  const maxScrollLeft = Math.max(0, horizontalMetrics.contentWidth - horizontalMetrics.viewportWidth);
  const railThumbWidth = horizontalMetrics.hasOverflow
    ? Math.max(48, Math.min(horizontalMetrics.railWidth, horizontalMetrics.railWidth * (horizontalMetrics.viewportWidth / horizontalMetrics.contentWidth)))
    : 0;
  const railMaxOffset = Math.max(0, horizontalMetrics.railWidth - railThumbWidth);
  const railThumbOffset = maxScrollLeft > 0 ? (horizontalMetrics.scrollLeft / maxScrollLeft) * railMaxOffset : 0;

  const clampScrollLeft = (value: number) => {
    return Math.max(0, Math.min(maxScrollLeft, value));
  };

  const setHorizontalScroll = (value: number) => {
    const horizontalScroll = horizontalScrollRef.current;
    if (!horizontalScroll) {
      return;
    }
    horizontalScroll.scrollLeft = clampScrollLeft(value);
    measureHorizontalOverflow();
  };

  const handleHorizontalScroll = () => {
    const horizontalScroll = horizontalScrollRef.current;
    if (!horizontalScroll) {
      return;
    }
    setHorizontalMetrics((prev) => {
      if (Math.abs(prev.scrollLeft - horizontalScroll.scrollLeft) < 1) {
        return prev;
      }
      return {
        ...prev,
        scrollLeft: horizontalScroll.scrollLeft
      };
    });
  };

  const handleRailPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!horizontalMetrics.hasOverflow || event.target !== event.currentTarget) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    if (railMaxOffset <= 0) {
      setHorizontalScroll(0);
      return;
    }
    const targetOffset = Math.max(0, Math.min(railMaxOffset, clickX - railThumbWidth / 2));
    setHorizontalScroll((targetOffset / railMaxOffset) * maxScrollLeft);
  };

  const handleRailThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!horizontalMetrics.hasOverflow) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    thumbDragRef.current = {
      pointerID: event.pointerId,
      startX: event.clientX,
      startScrollLeft: horizontalMetrics.scrollLeft
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleRailThumbPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = thumbDragRef.current;
    if (!dragState || dragState.pointerID !== event.pointerId || railMaxOffset <= 0 || maxScrollLeft <= 0) {
      return;
    }
    const deltaX = event.clientX - dragState.startX;
    const deltaScroll = deltaX * (maxScrollLeft / railMaxOffset);
    setHorizontalScroll(dragState.startScrollLeft + deltaScroll);
  };

  const clearRailThumbDrag = () => {
    thumbDragRef.current = null;
  };

  const handleRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!horizontalMetrics.hasOverflow) {
      return;
    }
    const step = Math.max(64, Math.round(horizontalMetrics.viewportWidth * 0.2));
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setHorizontalScroll(horizontalMetrics.scrollLeft - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setHorizontalScroll(horizontalMetrics.scrollLeft + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      setHorizontalScroll(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHorizontalScroll(maxScrollLeft);
    }
  };

  const overlayTrackStyle: CSSProperties | undefined =
    headerLayout.tableWidth > 0
      ? {
          width: headerLayout.tableWidth,
          minWidth: "100%",
          transform: `translateX(-${horizontalMetrics.scrollLeft}px)`
        }
      : undefined;

  return (
    <div className="panel table-panel">
      <div className="table-action-row">
        <div className="table-action-custom">{actionSlot}</div>
        <div className="table-action-group" ref={columnMenuRef}>
          <button
            type="button"
            className={`btn btn-small table-action-trigger ${columnMenuOpen ? "table-action-trigger-active" : ""}`}
            onClick={() => setColumnMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={columnMenuOpen}
          >
            Columns
            <span className="table-action-meta">
              {columns.length}/{orderedColumns.length}
            </span>
          </button>
          {columnMenuOpen ? (
            <div className="column-visibility-menu" aria-label="Toggle monitor columns">
              <div className="column-visibility-menu-head">
                <div>
                  <div className="column-visibility-menu-title">Visible Columns</div>
                  <div className="column-visibility-menu-copy">
                    Keep at least {minimumVisibleColumns} columns visible. Drag column grips in the table header to reorder.
                  </div>
                </div>
                <button type="button" className="btn-link" onClick={onResetColumnPreferences}>
                  Reset
                </button>
              </div>
              <div className="column-visibility-menu-list">
                {orderedColumns.map((column) => {
                  const checked = columnVisibility[column.key] !== false;
                  const disableToggle = checked && columns.length <= minimumVisibleColumns;
                  return (
                    <label key={`column-menu-${column.key}`} className={`column-visibility-item ${disableToggle ? "is-locked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disableToggle}
                        onChange={() => onToggleColumnVisibility(column.key)}
                      />
                      <span>{column.menuLabel}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="table-viewport-shell">
        {headerLayout.height > 0 ? (
          <div className="monitor-table-header-overlay-shell" style={{ height: headerLayout.height }}>
            <div className="monitor-table-header-overlay-track" style={overlayTrackStyle}>
              <div className="monitor-table-header-row" role="row">
                {showSelectionCheckboxes ? (
                  <div
                    role="presentation"
                    className="monitor-table-header-cell table-selection-column-head"
                    style={headerCellStyle(headerLayout.widths[0])}
                  />
                ) : null}
                {headerColumns.map((column, index) => renderHeaderCell(column, index, true))}
              </div>
            </div>
          </div>
        ) : null}
        <div className="table-scroll-y" ref={verticalScrollRef} onScroll={captureRelativeScroll}>
          <div className="table-scroll-x" ref={horizontalScrollRef} onScroll={handleHorizontalScroll}>
            <table className="monitor-table" ref={tableRef}>
              <thead className="monitor-table-head-placeholder">
                <tr>
                  {showSelectionCheckboxes ? (
                    <th className="table-selection-column-head" aria-label="Endpoint selection" />
                  ) : null}
                  {headerColumns.map((column, index) => renderHeaderCell(column, index, false))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr className="monitor-table-empty-row">
                    <td colSpan={columns.length + (showSelectionCheckboxes ? 1 : 0)}>{emptyMessage}</td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const endpointID = row.endpoint_id;
                    const selected = selectedEndpointIDSet.has(endpointID);
                    const health = endpointHealth(row, dataScope, liveProbeContext);
                    const rowClassName = `${rowHealthClassName(health)}${selected ? " row-selected" : ""}`;
                    const isSelectable = selectionMode !== "none";
                    return (
                      <tr
                        key={endpointID}
                        className={rowClassName}
                        onClick={
                          isSelectable
                            ? (event) =>
                                commitSelectionChange(endpointID, selected, {
                                  shiftKey: event.shiftKey,
                                  metaKey: event.metaKey,
                                  ctrlKey: event.ctrlKey
                                })
                            : undefined
                        }
                        onKeyDown={
                          isSelectable
                            ? (event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  commitSelectionChange(endpointID, selected);
                                }
                              }
                            : undefined
                        }
                        tabIndex={isSelectable ? 0 : -1}
                        aria-selected={isSelectable ? selected : undefined}
                      >
                        {showSelectionCheckboxes ? (
                          <td className="table-selection-cell">
                            <input
                              type="checkbox"
                              className="table-selection-checkbox"
                              checked={selected}
                              readOnly
                              onClick={(event: ReactMouseEvent<HTMLInputElement>) => {
                                event.stopPropagation();
                                commitSelectionChange(endpointID, selected, {
                                  shiftKey: event.shiftKey,
                                  metaKey: event.metaKey,
                                  ctrlKey: event.ctrlKey
                                });
                              }}
                              aria-label={`Select endpoint ${row.hostname || row.ip_address}`}
                            />
                          </td>
                        ) : null}
                        {columns.map((column) => {
                          return <td key={`${endpointID}-${column.key}`}>{column.render(row)}</td>;
                        })}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {horizontalMetrics.hasOverflow ? (
        <div className="table-scroll-rail-shell">
          <div
            className="table-scroll-rail"
            ref={horizontalRailRef}
            onPointerDown={handleRailPointerDown}
            onKeyDown={handleRailKeyDown}
            tabIndex={0}
            aria-label="Scroll table horizontally"
          >
            <div
              className="table-scroll-rail-thumb"
              style={{ width: `${railThumbWidth}px`, transform: `translateX(${railThumbOffset}px)` }}
              onPointerDown={handleRailThumbPointerDown}
              onPointerMove={handleRailThumbPointerMove}
              onPointerUp={clearRailThumbDrag}
              onPointerCancel={clearRailThumbDrag}
            />
          </div>
        </div>
      ) : null}

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
