import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useMemo } from "react";
import type { MonitorEndpoint } from "../types/api";

type Props = {
  rows: MonitorEndpoint[];
  selectedEndpointID: number | null;
  onSelectionChange: (id: number | null) => void;
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

const columnHelper = createColumnHelper<MonitorEndpoint>();

const columns = [
  columnHelper.accessor("hostname", { header: "Hostname" }),
  columnHelper.accessor("last_failed_on", {
    header: "Last Failed On",
    cell: ({ getValue }) => formatDate(getValue())
  }),
  columnHelper.accessor("ip_address", { header: "IP Address" }),
  columnHelper.accessor("mac_address", { header: "MAC Address" }),
  columnHelper.accessor("reply_ip_address", { header: "Reply IP" }),
  columnHelper.accessor("last_success_on", {
    header: "Last Success On",
    cell: ({ getValue }) => formatDate(getValue())
  }),
  columnHelper.accessor("success_count", { header: "Success Count" }),
  columnHelper.accessor("failed_count", { header: "Failed Count" }),
  columnHelper.accessor("consecutive_failed_count", { header: "Consecutive Failed" }),
  columnHelper.accessor("max_consecutive_failed_count", { header: "Max Consecutive Failed" }),
  columnHelper.accessor("max_consecutive_failed_count_time", {
    header: "Max Consec Failed Time",
    cell: ({ getValue }) => formatDate(getValue())
  }),
  columnHelper.accessor("failed_pct", {
    header: "Failed %",
    cell: ({ getValue }) => formatPercent(getValue())
  }),
  columnHelper.accessor("total_sent_ping", { header: "Total Sent Ping" }),
  columnHelper.accessor("last_ping_status", { header: "Last Ping Status" }),
  columnHelper.accessor("last_ping_latency", {
    header: "Last Ping Latency",
    cell: ({ getValue }) => formatLatency(getValue())
  }),
  columnHelper.accessor("average_latency", {
    header: "Average Latency",
    cell: ({ getValue }) => formatLatency(getValue())
  }),
  columnHelper.accessor("vlan", { header: "VLAN" }),
  columnHelper.accessor("switch", { header: "Switch" }),
  columnHelper.accessor("port", { header: "Port" }),
  columnHelper.accessor("port_type", { header: "Port Type" }),
  columnHelper.accessor("group", {
    header: "Group",
    cell: ({ getValue }) => getValue().join(", ")
  })
];

export function MonitorTable({ rows, selectedEndpointID, onSelectionChange }: Props) {
  const data = useMemo(() => rows, [rows]);

  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => row.endpoint_id.toString(),
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table className="monitor-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const endpointID = row.original.endpoint_id;
              const selected = selectedEndpointID === endpointID;
              return (
                <tr
                  key={row.id}
                  className={selected ? "row-selected" : ""}
                  onClick={() => onSelectionChange(selected ? null : endpointID)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
