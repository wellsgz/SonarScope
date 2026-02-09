export type MonitorEndpoint = {
  endpoint_id: number;
  hostname: string;
  last_failed_on: string | null;
  ip_address: string;
  mac_address: string;
  reply_ip_address: string | null;
  last_success_on: string | null;
  success_count: number;
  failed_count: number;
  consecutive_failed_count: number;
  max_consecutive_failed_count: number;
  max_consecutive_failed_count_time: string | null;
  failed_pct: number;
  total_sent_ping: number;
  last_ping_status: string;
  last_ping_latency: number | null;
  average_latency: number | null;
  vlan: string;
  switch: string;
  port: string;
  port_type: string;
  group: string[];
};

export type MonitorSortField =
  | "last_success_on"
  | "success_count"
  | "failed_count"
  | "consecutive_failed_count"
  | "max_consecutive_failed_count"
  | "max_consecutive_failed_count_time"
  | "failed_pct"
  | "last_ping_latency"
  | "average_latency";

export type MonitorEndpointPageResponse = {
  items: MonitorEndpoint[];
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
};

export type InventoryEndpoint = {
  endpoint_id: number;
  hostname: string;
  ip_address: string;
  mac_address: string;
  vlan: string;
  switch: string;
  port: string;
  port_type: string;
  description: string;
  group: string[];
  updated_at: string;
};

export type Group = {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  endpoint_ids?: number[];
};

export type Settings = {
  ping_interval_sec: number;
  icmp_payload_bytes: number;
  icmp_timeout_ms: number;
  auto_refresh_sec: number;
};

export type ImportCandidate = {
  row_id: string;
  source_row: number;
  ip: string;
  mac: string;
  vlan: string;
  switch: string;
  port: string;
  port_type: string;
  description: string;
  sorting: string;
  hostname: string;
  message: string;
  action: "add" | "update" | "unchanged" | "invalid";
  existing_id?: number;
};

export type ImportPreview = {
  preview_id: string;
  created_at: string;
  candidates: ImportCandidate[];
};

export type TimeSeriesPoint = {
  endpoint_id: number;
  bucket: string;
  loss_rate: number;
  avg_latency_ms: number | null;
  max_latency_ms: number | null;
  sent_count: number;
  fail_count: number;
};

export type TimeSeriesResponse = {
  rollup: "1m" | "1h";
  series: TimeSeriesPoint[];
};

export type FilterOptions = {
  vlan: string[];
  switch: string[];
  port: string[];
  group: string[];
};
