export type MonitorEndpoint = {
  endpoint_id: number;
  hostname: string;
  last_failed_on: string | null;
  ip_address: string;
  mac_address: string;
  custom_field_1_value: string;
  custom_field_2_value: string;
  custom_field_3_value: string;
  custom_field_4_value: string;
  custom_field_5_value: string;
  custom_field_6_value: string;
  custom_field_7_value: string;
  custom_field_8_value: string;
  custom_field_9_value: string;
  custom_field_10_value: string;
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
  zone: string;
  switch: string;
  port: string;
  port_type: string;
  gateway: string;
  mgmt_ip: string;
  speed: string;
  duplex: string;
  group: string[];
};

export type MonitorSortField =
  | "last_failed_on"
  | "last_success_on"
  | "success_count"
  | "failed_count"
  | "consecutive_failed_count"
  | "max_consecutive_failed_count"
  | "max_consecutive_failed_count_time"
  | "failed_pct"
  | "last_ping_status"
  | "last_ping_latency"
  | "average_latency";

export type MonitorSortCriterion = {
  field: MonitorSortField;
  dir: "asc" | "desc";
};

export type MonitorDataScope = "live" | "range";

export type MonitorEndpointPageResponse = {
  items: MonitorEndpoint[];
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  stats_scope?: MonitorDataScope;
  range_rollup?: "1m" | "1h";
};

export type InventoryEndpoint = {
  endpoint_id: number;
  hostname: string;
  ip_address: string;
  mac_address: string;
  custom_field_1_value: string;
  custom_field_2_value: string;
  custom_field_3_value: string;
  custom_field_4_value: string;
  custom_field_5_value: string;
  custom_field_6_value: string;
  custom_field_7_value: string;
  custom_field_8_value: string;
  custom_field_9_value: string;
  custom_field_10_value: string;
  vlan: string;
  zone: string;
  switch: string;
  port: string;
  port_type: string;
  gateway: string;
  mgmt_ip: string;
  speed: string;
  duplex: string;
  description: string;
  group: string[];
  active: boolean;
  updated_at: string;
};

export type InventoryEndpointCreateRequest = {
  ip_address: string;
  hostname?: string;
  mac_address?: string;
  custom_field_1_value?: string;
  custom_field_2_value?: string;
  custom_field_3_value?: string;
  custom_field_4_value?: string;
  custom_field_5_value?: string;
  custom_field_6_value?: string;
  custom_field_7_value?: string;
  custom_field_8_value?: string;
  custom_field_9_value?: string;
  custom_field_10_value?: string;
  vlan?: string;
  zone?: string;
  switch?: string;
  port?: string;
  port_type?: string;
  gateway?: string;
  mgmt_ip?: string;
  speed?: string;
  duplex?: string;
  description?: string;
  group_id?: number;
  [key: `custom_field_${number}_value`]: string | undefined;
};

export type Group = {
  id: number;
  name: string;
  description: string;
  is_system?: boolean;
  created_at: string;
  updated_at: string;
  endpoint_ids?: number[];
  active_endpoint_count?: number;
};

export type InventoryEndpointActivityUpdateResponse = {
  updated_count: number;
  active: boolean;
};

export type CustomFieldConfig = {
  slot: number;
  enabled: boolean;
  name: string;
};

export type Settings = {
  ping_interval_sec: number;
  icmp_payload_bytes: number;
  icmp_timeout_ms: number;
  auto_refresh_sec: number;
  custom_fields: CustomFieldConfig[];
};

export type SwitchDirectoryEntry = {
  id: number;
  name: string;
  ip_address: string;
  created_at: string;
  updated_at: string;
};

export type SwitchDirectoryImportCandidate = {
  row_id: string;
  source_row: number;
  name: string;
  ip_address: string;
  message: string;
  action: "add" | "update" | "unchanged" | "invalid";
  existing_id?: number;
};

export type SwitchDirectoryImportPreview = {
  preview_id: string;
  created_at: string;
  candidates: SwitchDirectoryImportCandidate[];
};

export type SwitchDirectoryImportApplyResponse = {
  added: number;
  updated: number;
  errors: string[];
};

export type SwitchUnreachableCount = {
  switch_name: string;
  unreachable_count: number;
};

export type DashboardUnreachableSummary = {
  total_unreachable: number;
  by_switch: SwitchUnreachableCount[];
  total_switch_count: number;
};

export type ProbeStatus = {
  running: boolean;
  scope: "all" | "groups" | "";
  group_ids: number[];
};

export type ImportCandidate = {
  row_id: string;
  source_row: number;
  ip: string;
  hostname: string;
  mac: string;
  custom_field_1_value: string;
  custom_field_2_value: string;
  custom_field_3_value: string;
  custom_field_4_value: string;
  custom_field_5_value: string;
  custom_field_6_value: string;
  custom_field_7_value: string;
  custom_field_8_value: string;
  custom_field_9_value: string;
  custom_field_10_value: string;
  vlan: string;
  zone: string;
  switch: string;
  port: string;
  port_type: string;
  gateway: string;
  mgmt_ip: string;
  speed: string;
  duplex: string;
  description: string;
  sorting: string;
  message: string;
  action: "add" | "update" | "unchanged" | "invalid";
  existing_id?: number;
};

export type ImportPreview = {
  preview_id: string;
  created_at: string;
  candidates: ImportCandidate[];
};

export type ImportGroupAssignmentMode = "none" | "existing" | "create";

export type ImportGroupAssignmentRequest = {
  mode: ImportGroupAssignmentMode;
  group_id?: number;
  group_name?: string;
};

export type ImportGroupAssignmentResult = {
  applied: boolean;
  group_id: number;
  group_name: string;
  valid_upload_ips: number;
  resolved_endpoints: number;
  assigned_added: number;
  unresolved_ips: number;
  used_existing_by_name?: boolean;
};

export type ImportApplyResponse = {
  added: number;
  updated: number;
  errors: string[];
  group_assignment?: ImportGroupAssignmentResult;
};

export type DeleteInventoryByGroupResponse = {
  deleted: boolean;
  matched_count: number;
  deleted_count: number;
  group_id: number;
};

export type InventoryBatchMatchMode = "criteria" | "ip_list";
export type InventoryBatchMatchField =
  | "hostname"
  | "ip_address"
  | "mac_address"
  | "vlan"
  | "zone"
  | "switch"
  | "port"
  | "port_type"
  | "gateway"
  | "mgmt_ip"
  | "speed"
  | "duplex"
  | "description"
  | "custom_field_1_value"
  | "custom_field_2_value"
  | "custom_field_3_value"
  | "custom_field_4_value"
  | "custom_field_5_value"
  | "custom_field_6_value"
  | "custom_field_7_value"
  | "custom_field_8_value"
  | "custom_field_9_value"
  | "custom_field_10_value";

export type InventoryBatchMatchSpec = {
  mode: InventoryBatchMatchMode;
  field?: InventoryBatchMatchField;
  regex?: string;
  ips?: string[];
};

export type InventoryBatchMatchStats = {
  mode: InventoryBatchMatchMode;
  submitted_count?: number;
  unique_count?: number;
  invalid_count?: number;
  matched_count: number;
  unmatched_count?: number;
  unmatched_sample?: string[];
};

export type InventoryBatchMatchPreview = {
  stats: InventoryBatchMatchStats;
  endpoint_ids: number[];
  sample: InventoryEndpoint[];
};

export type InventoryBatchGroupAssignmentMode = "existing" | "create";

export type InventoryBatchGroupAssignmentTarget = {
  mode: InventoryBatchGroupAssignmentMode;
  group_id?: number;
  group_name?: string;
};

export type InventoryBatchGroupPreviewResponse = {
  preview: InventoryBatchMatchPreview;
  group_id?: number;
  group_name: string;
  already_in_group: number;
  would_assign: number;
  used_existing_by_name?: boolean;
};

export type InventoryBatchGroupApplyResponse = {
  matched_count: number;
  group_id: number;
  group_name: string;
  already_in_group: number;
  assigned_added: number;
  used_existing_by_name?: boolean;
};

export type GroupMembershipRemovalPreviewResponse = {
  preview: InventoryBatchMatchPreview;
  group_id: number;
  group_name: string;
  would_remove: number;
};

export type InventoryBatchDeletePreviewResponse = {
  preview: InventoryBatchMatchPreview;
  target_summary: string;
};

export type DeleteAllInventoryResponse = {
  deleted: boolean;
  deleted_count: number;
};

export type InventoryDeleteJobMode = "endpoint" | "by_group" | "all" | "match";
export type InventoryDeleteJobState = "running" | "completed" | "failed";

export type InventoryDeleteJobStatus = {
  active: boolean;
  job_id?: string;
  mode?: InventoryDeleteJobMode;
  group_id?: number;
  target_summary?: string;
  state?: InventoryDeleteJobState;
  matched_endpoints?: number;
  processed_endpoints?: number;
  deleted_endpoints?: number;
  total_ping_rows?: number;
  deleted_ping_rows?: number;
  progress_pct?: number;
  eta_seconds?: number;
  phase?: string;
  error?: string;
  started_at?: string;
  updated_at?: string;
  completed_at?: string;
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
