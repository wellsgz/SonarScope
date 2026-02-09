import type {
  DeleteAllInventoryResponse,
  DeleteInventoryByGroupResponse,
  FilterOptions,
  Group,
  ImportApplyResponse,
  ImportGroupAssignmentRequest,
  InventoryEndpoint,
  InventoryEndpointCreateRequest,
  MonitorDataScope,
  ImportPreview,
  InventoryDeleteJobStatus,
  MonitorEndpoint,
  MonitorEndpointPageResponse,
  MonitorSortField,
  ProbeStatus,
  Settings,
  TimeSeriesResponse
} from "../types/api";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").trim();

function buildURL(path: string): string {
  if (!API_BASE) {
    return path;
  }
  const base = API_BASE.endsWith("/") ? API_BASE : `${API_BASE}/`;
  return new URL(path, base).toString();
}

function buildWSURL(path: string): string {
  const base = API_BASE ? new URL(API_BASE) : new URL(window.location.origin);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${base.host}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildURL(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore parse errors and keep default status text
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function buildQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });
  const raw = params.toString();
  return raw ? `${path}?${raw}` : path;
}

export async function getSettings(): Promise<Settings> {
  return request<Settings>("/api/settings/");
}

export async function updateSettings(payload: Settings): Promise<Settings> {
  return request<Settings>("/api/settings/", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function listGroups(): Promise<Group[]> {
  return request<Group[]>("/api/groups/");
}

export async function createGroup(payload: {
  name: string;
  description: string;
  endpoint_ids: number[];
}): Promise<Group> {
  return request<Group>("/api/groups/", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateGroup(
  id: number,
  payload: { name: string; description: string; endpoint_ids: number[] }
): Promise<Group> {
  return request<Group>(`/api/groups/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteGroup(id: number): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/groups/${id}`, {
    method: "DELETE"
  });
}

export async function listMonitorEndpoints(filters: {
  vlan?: string[];
  switches?: string[];
  ports?: string[];
  groups?: string[];
}): Promise<MonitorEndpoint[]> {
  const path = buildQuery("/api/monitor/endpoints", {
    vlan: filters.vlan?.join(","),
    switch: filters.switches?.join(","),
    port: filters.ports?.join(","),
    group: filters.groups?.join(",")
  });
  return request<MonitorEndpoint[]>(path);
}

export async function listMonitorEndpointsPage(filters: {
  vlan?: string[];
  switches?: string[];
  ports?: string[];
  groups?: string[];
  hostname?: string;
  mac?: string;
  ipList?: string[];
  page: number;
  pageSize: 50 | 100 | 200;
  statsScope?: MonitorDataScope;
  start?: string;
  end?: string;
  sortBy?: MonitorSortField;
  sortDir?: "asc" | "desc";
}): Promise<MonitorEndpointPageResponse> {
  const path = buildQuery("/api/monitor/endpoints-page", {
    vlan: filters.vlan?.join(","),
    switch: filters.switches?.join(","),
    port: filters.ports?.join(","),
    group: filters.groups?.join(","),
    hostname: filters.hostname?.trim() || undefined,
    mac: filters.mac?.trim() || undefined,
    ip_list: filters.ipList?.join(","),
    page: String(filters.page),
    page_size: String(filters.pageSize),
    stats_scope: filters.statsScope,
    start: filters.start,
    end: filters.end,
    sort_by: filters.sortBy,
    sort_dir: filters.sortDir
  });
  return request<MonitorEndpointPageResponse>(path);
}

export async function listMonitorTimeSeries(payload: {
  endpointIds: number[];
  start?: string;
  end?: string;
}): Promise<TimeSeriesResponse> {
  const path = buildQuery("/api/monitor/timeseries", {
    endpoint_ids: payload.endpointIds.join(","),
    start: payload.start,
    end: payload.end
  });
  return request<TimeSeriesResponse>(path);
}

export async function listFilterOptions(): Promise<FilterOptions> {
  return request<FilterOptions>("/api/monitor/filter-options");
}

export async function listInventoryFilterOptions(): Promise<FilterOptions> {
  return request<FilterOptions>("/api/inventory/filter-options");
}

export async function listInventoryEndpoints(filters: {
  vlan?: string[];
  switches?: string[];
  ports?: string[];
  groups?: string[];
}): Promise<InventoryEndpoint[]> {
  const path = buildQuery("/api/inventory/endpoints", {
    vlan: filters.vlan?.join(","),
    switch: filters.switches?.join(","),
    port: filters.ports?.join(","),
    group: filters.groups?.join(",")
  });
  return request<InventoryEndpoint[]>(path);
}

export async function createInventoryEndpoint(payload: InventoryEndpointCreateRequest): Promise<InventoryEndpoint> {
  return request<InventoryEndpoint>("/api/inventory/endpoints", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function updateInventoryEndpoint(
  endpointID: number,
  payload: {
    hostname: string;
    mac_address: string;
    vlan: string;
    switch: string;
    port: string;
    port_type: string;
    description: string;
  }
): Promise<InventoryEndpoint> {
  return request<InventoryEndpoint>(`/api/inventory/endpoints/${endpointID}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export async function deleteInventoryEndpointsByGroup(groupID: number): Promise<DeleteInventoryByGroupResponse> {
  return request<DeleteInventoryByGroupResponse>(`/api/inventory/endpoints/by-group/${groupID}`, {
    method: "DELETE"
  });
}

export async function deleteAllInventoryEndpoints(confirmPhrase: string): Promise<DeleteAllInventoryResponse> {
  return request<DeleteAllInventoryResponse>("/api/inventory/endpoints/delete-all", {
    method: "POST",
    body: JSON.stringify({ confirm_phrase: confirmPhrase })
  });
}

export async function startDeleteByGroupJob(groupID: number): Promise<InventoryDeleteJobStatus> {
  return request<InventoryDeleteJobStatus>(`/api/inventory/delete-jobs/by-group/${groupID}`, {
    method: "POST"
  });
}

export async function startDeleteAllJob(confirmPhrase: string): Promise<InventoryDeleteJobStatus> {
  return request<InventoryDeleteJobStatus>("/api/inventory/delete-jobs/all", {
    method: "POST",
    body: JSON.stringify({ confirm_phrase: confirmPhrase })
  });
}

export async function getCurrentDeleteJobStatus(): Promise<InventoryDeleteJobStatus> {
  return request<InventoryDeleteJobStatus>("/api/inventory/delete-jobs/current");
}

export async function getProbeStatus(): Promise<ProbeStatus> {
  return request<ProbeStatus>("/api/probes/status");
}

export async function startProbe(payload: {
  scope: "all" | "groups";
  group_ids?: number[];
}): Promise<{ running: boolean; scope: string; group_ids: number[] }> {
  return request<{ running: boolean; scope: string; group_ids: number[] }>("/api/probes/start", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function stopProbe(): Promise<{ running: boolean; stopped: boolean }> {
  return request<{ running: boolean; stopped: boolean }>("/api/probes/stop", {
    method: "POST"
  });
}

export async function importInventoryPreview(file: File): Promise<ImportPreview> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch(buildURL("/api/inventory/import-preview"), {
    method: "POST",
    body: form
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // no-op
    }
    throw new Error(message);
  }
  return (await response.json()) as ImportPreview;
}

export async function applyInventoryPreview(payload: {
  preview_id: string;
  selections?: { row_id: string; action: "add" | "update" }[];
  group_assignment?: ImportGroupAssignmentRequest;
}): Promise<ImportApplyResponse> {
  return request<ImportApplyResponse>("/api/inventory/import-apply", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function createMonitorSocket(onMessage: (message: unknown) => void): WebSocket {
  const socket = new WebSocket(buildWSURL("/ws/monitor"));
  socket.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      // ignore malformed events
    }
  };
  return socket;
}
