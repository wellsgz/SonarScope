import type {
  FilterOptions,
  Group,
  ImportPreview,
  MonitorEndpoint,
  Settings,
  TimeSeriesResponse
} from "../types/api";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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

  const response = await fetch(`${API_BASE}/api/inventory/import-preview`, {
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
}): Promise<{ added: number; updated: number; errors: string[] }> {
  return request<{ added: number; updated: number; errors: string[] }>("/api/inventory/import-apply", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function createMonitorSocket(onMessage: (message: unknown) => void): WebSocket {
  const wsBase = API_BASE.replace("http://", "ws://").replace("https://", "wss://");
  const socket = new WebSocket(`${wsBase}/ws/monitor`);
  socket.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      // ignore malformed events
    }
  };
  return socket;
}
