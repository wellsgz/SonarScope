import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyInventoryPreview,
  createInventoryEndpoint,
  exportInventoryEndpointsCSV,
  getSettings,
  getCurrentDeleteJobStatus,
  importInventoryPreview,
  listGroups,
  listInventoryEndpoints,
  listInventoryFilterOptions,
  startDeleteAllJob,
  startDeleteByGroupJob,
  updateInventoryEndpoint
} from "../api/client";
import type {
  CustomFieldConfig,
  ImportCandidate,
  ImportPreview,
  InventoryDeleteJobStatus,
  InventoryEndpoint,
  InventoryEndpointCreateRequest
} from "../types/api";

type FilterState = {
  vlan: string[];
  switches: string[];
  ports: string[];
  groups: string[];
};

type InventoryPatch = {
  hostname: string;
  mac_address: string;
  custom_field_1_value: string;
  custom_field_2_value: string;
  custom_field_3_value: string;
  vlan: string;
  switch: string;
  port: string;
  port_type: string;
  description: string;
};

const defaultFilters: FilterState = {
  vlan: [],
  switches: [],
  ports: [],
  groups: []
};

type CustomFieldSlot = 1 | 2 | 3;

type EnabledCustomField = {
  slot: CustomFieldSlot;
  name: string;
};

type CustomSearchState = {
  custom1: string;
  custom2: string;
  custom3: string;
};

const defaultCustomSearch: CustomSearchState = {
  custom1: "",
  custom2: "",
  custom3: ""
};

function normalizeEnabledCustomFields(fields?: CustomFieldConfig[]): EnabledCustomField[] {
  const bySlot: Record<CustomFieldSlot, EnabledCustomField | null> = {
    1: null,
    2: null,
    3: null
  };
  (fields || []).forEach((field) => {
    if (field.slot < 1 || field.slot > 3) {
      return;
    }
    if (!field.enabled || !field.name.trim()) {
      return;
    }
    const slot = field.slot as CustomFieldSlot;
    bySlot[slot] = {
      slot,
      name: field.name.trim()
    };
  });
  return [bySlot[1], bySlot[2], bySlot[3]].filter((field): field is EnabledCustomField => field !== null);
}

function customFieldValueBySlot(
  values: {
    custom_field_1_value: string;
    custom_field_2_value: string;
    custom_field_3_value: string;
  },
  slot: CustomFieldSlot
): string {
  if (slot === 1) return values.custom_field_1_value;
  if (slot === 2) return values.custom_field_2_value;
  return values.custom_field_3_value;
}

function customSearchValueBySlot(values: CustomSearchState, slot: CustomFieldSlot): string {
  if (slot === 1) return values.custom1;
  if (slot === 2) return values.custom2;
  return values.custom3;
}

function setCustomSearchBySlot(values: CustomSearchState, slot: CustomFieldSlot, next: string): CustomSearchState {
  if (slot === 1) return { ...values, custom1: next };
  if (slot === 2) return { ...values, custom2: next };
  return { ...values, custom3: next };
}

function setInventoryPatchCustomFieldValue(
  values: InventoryPatch,
  slot: CustomFieldSlot,
  next: string
): InventoryPatch {
  if (slot === 1) return { ...values, custom_field_1_value: next };
  if (slot === 2) return { ...values, custom_field_2_value: next };
  return { ...values, custom_field_3_value: next };
}

function setCreateRequestCustomFieldValue(
  values: InventoryEndpointCreateRequest,
  slot: CustomFieldSlot,
  next: string
): InventoryEndpointCreateRequest {
  if (slot === 1) return { ...values, custom_field_1_value: next };
  if (slot === 2) return { ...values, custom_field_2_value: next };
  return { ...values, custom_field_3_value: next };
}

function toPatch(row: InventoryEndpoint): InventoryPatch {
  return {
    hostname: row.hostname,
    mac_address: row.mac_address,
    custom_field_1_value: row.custom_field_1_value || "",
    custom_field_2_value: row.custom_field_2_value || "",
    custom_field_3_value: row.custom_field_3_value || "",
    vlan: row.vlan,
    switch: row.switch,
    port: row.port,
    port_type: row.port_type,
    description: row.description
  };
}

function multiSelectValue(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.target.selectedOptions).map((option) => option.value);
}

function badgeClass(action: ImportCandidate["action"]) {
  if (action === "add") return "badge badge-add";
  if (action === "update") return "badge badge-update";
  if (action === "invalid") return "badge badge-invalid";
  return "badge badge-unchanged";
}

function formatEta(seconds?: number): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "ETA: calculating...";
  }
  const rounded = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;

  if (hours > 0) {
    return `ETA: ${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `ETA: ${minutes}m ${secs}s`;
  }
  return `ETA: ${secs}s`;
}

const deleteJobDismissedStorageKey = "inventory.deleteJobNotice.dismissed";

function formatDateTime(value?: string): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function completionNoticeKey(status?: InventoryDeleteJobStatus): string {
  if (!status?.job_id || !status.state || status.active) {
    return "";
  }
  return `${status.job_id}:${status.state}:${status.deleted_endpoints ?? 0}:${status.matched_endpoints ?? 0}:${status.completed_at ?? ""}`;
}

export function InventoryPage() {
  const queryClient = useQueryClient();

  const initialSingleEndpoint: InventoryEndpointCreateRequest = {
    ip_address: "",
    hostname: "",
    mac_address: "",
    custom_field_1_value: "",
    custom_field_2_value: "",
    custom_field_3_value: "",
    vlan: "",
    switch: "",
    port: "",
    port_type: "",
    description: "",
    group_id: undefined
  };

  const [file, setFile] = useState<File | null>(null);
  const [importFileInputKey, setImportFileInputKey] = useState(0);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<Record<string, "add" | "update">>({});
  const [importExpanded, setImportExpanded] = useState(false);
  const [singleEndpointExpanded, setSingleEndpointExpanded] = useState(false);
  const [lastImportSummary, setLastImportSummary] = useState<{
    added: number;
    updated: number;
    errors: number;
    group_name?: string;
    assigned_added?: number;
    resolved_endpoints?: number;
    valid_upload_ips?: number;
    unresolved_ips?: number;
  } | null>(null);
  const [assignToGroup, setAssignToGroup] = useState(false);
  const [groupAssignmentMode, setGroupAssignmentMode] = useState<"existing" | "create">("existing");
  const [selectedGroupID, setSelectedGroupID] = useState("");
  const [newGroupName, setNewGroupName] = useState("");

  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [customSearch, setCustomSearch] = useState<CustomSearchState>(defaultCustomSearch);
  const [editingEndpointID, setEditingEndpointID] = useState<number | null>(null);
  const [editingPatch, setEditingPatch] = useState<InventoryPatch | null>(null);
  const [singleEndpoint, setSingleEndpoint] = useState<InventoryEndpointCreateRequest>(initialSingleEndpoint);
  const [singleEndpointAdvancedOpen, setSingleEndpointAdvancedOpen] = useState(false);
  const [deleteGroupID, setDeleteGroupID] = useState("");
  const [deleteAllArmed, setDeleteAllArmed] = useState(false);
  const [deleteAllPhrase, setDeleteAllPhrase] = useState("");
  const [deleteJobNotice, setDeleteJobNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [dismissedDeleteJobKey, setDismissedDeleteJobKey] = useState<string>(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(deleteJobDismissedStorageKey) || "";
  });
  const lastHandledDeleteJobRef = useRef<string>("");

  const filterCards: Array<{ key: keyof FilterState; label: string; options: string[] }> = [
    { key: "vlan", label: "VLAN", options: [] },
    { key: "switches", label: "Switch", options: [] },
    { key: "ports", label: "Port", options: [] },
    { key: "groups", label: "Group", options: [] }
  ];

  const filterOptionsQuery = useQuery({
    queryKey: ["inventory-filter-options"],
    queryFn: listInventoryFilterOptions
  });
  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: listGroups
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings
  });
  const deleteJobStatusQuery = useQuery({
    queryKey: ["inventory-delete-job-current"],
    queryFn: getCurrentDeleteJobStatus,
    refetchInterval: 1000
  });

  filterCards[0].options = filterOptionsQuery.data?.vlan || [];
  filterCards[1].options = filterOptionsQuery.data?.switch || [];
  filterCards[2].options = filterOptionsQuery.data?.port || [];
  filterCards[3].options = filterOptionsQuery.data?.group || [];

  const enabledCustomFields = useMemo(
    () => normalizeEnabledCustomFields(settingsQuery.data?.custom_fields),
    [settingsQuery.data?.custom_fields]
  );
  const enabledCustomFieldKey = useMemo(
    () => enabledCustomFields.map((field) => `${field.slot}:${field.name}`).join("|"),
    [enabledCustomFields]
  );

  const inventoryQuery = useQuery({
    queryKey: ["inventory-endpoints", filters, customSearch, enabledCustomFieldKey],
    queryFn: () =>
      listInventoryEndpoints({
        vlan: filters.vlan,
        switches: filters.switches,
        ports: filters.ports,
        groups: filters.groups,
        custom1: customSearch.custom1,
        custom2: customSearch.custom2,
        custom3: customSearch.custom3
      })
  });
  const exportCSVMutation = useMutation({
    mutationFn: () =>
      exportInventoryEndpointsCSV({
        vlan: filters.vlan,
        switches: filters.switches,
        ports: filters.ports,
        groups: filters.groups,
        custom1: customSearch.custom1,
        custom2: customSearch.custom2,
        custom3: customSearch.custom3
      }),
    onSuccess: ({ blob, filename }) => {
      const downloadURL = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadURL;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadURL), 0);
    }
  });

  function invalidateInventoryAndMonitorQueries() {
    queryClient.invalidateQueries({ queryKey: ["inventory-endpoints"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-filter-options"] });
    queryClient.invalidateQueries({ queryKey: ["groups"] });
    queryClient.invalidateQueries({ queryKey: ["monitor-endpoints-page"] });
    queryClient.invalidateQueries({ queryKey: ["monitor-endpoints"] });
    queryClient.invalidateQueries({ queryKey: ["filter-options"] });
  }

  const previewMutation = useMutation({
    mutationFn: (upload: File) => importInventoryPreview(upload),
    onSuccess: (data) => {
      setPreview(data);
      const initial: Record<string, "add" | "update"> = {};
      data.candidates.forEach((candidate) => {
        if (candidate.action === "add" || candidate.action === "update") {
          initial[candidate.row_id] = candidate.action;
        }
      });
      setSelection(initial);
    }
  });

  const applyMutation = useMutation({
    mutationFn: () =>
      preview
        ? applyInventoryPreview({
            preview_id: preview.preview_id,
            selections: Object.entries(selection).map(([row_id, action]) => ({ row_id, action })),
            group_assignment: assignToGroup
              ? groupAssignmentMode === "existing"
                ? { mode: "existing", group_id: Number(selectedGroupID) }
                : { mode: "create", group_name: newGroupName.trim() }
              : undefined
          })
        : Promise.reject(new Error("No preview available")),
    onSuccess: (data) => {
      setLastImportSummary({
        added: data.added,
        updated: data.updated,
        errors: data.errors.length,
        group_name: data.group_assignment?.group_name,
        assigned_added: data.group_assignment?.assigned_added,
        resolved_endpoints: data.group_assignment?.resolved_endpoints,
        valid_upload_ips: data.group_assignment?.valid_upload_ips,
        unresolved_ips: data.group_assignment?.unresolved_ips
      });
      setPreview(null);
      setSelection({});
      setFile(null);
      setImportFileInputKey((value) => value + 1);
      setAssignToGroup(false);
      setGroupAssignmentMode("existing");
      setSelectedGroupID("");
      setNewGroupName("");
      invalidateInventoryAndMonitorQueries();
    }
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingPatch || editingEndpointID === null) {
        return Promise.reject(new Error("No row in edit mode"));
      }
      return updateInventoryEndpoint(editingEndpointID, editingPatch);
    },
    onSuccess: () => {
      setEditingEndpointID(null);
      setEditingPatch(null);
      invalidateInventoryAndMonitorQueries();
    }
  });

  const createSingleEndpointMutation = useMutation({
    mutationFn: (payload: InventoryEndpointCreateRequest) => createInventoryEndpoint(payload),
    onSuccess: () => {
      setSingleEndpoint(initialSingleEndpoint);
      setSingleEndpointAdvancedOpen(false);
      invalidateInventoryAndMonitorQueries();
    }
  });

  const startDeleteByGroupJobMutation = useMutation({
    mutationFn: (groupID: number) => startDeleteByGroupJob(groupID),
    onSuccess: () => {
      setEditingEndpointID(null);
      setEditingPatch(null);
      setDeleteJobNotice(null);
      queryClient.invalidateQueries({ queryKey: ["inventory-delete-job-current"] });
    }
  });

  const startDeleteAllJobMutation = useMutation({
    mutationFn: (confirmPhrase: string) => startDeleteAllJob(confirmPhrase),
    onSuccess: () => {
      setEditingEndpointID(null);
      setEditingPatch(null);
      setDeleteAllArmed(false);
      setDeleteAllPhrase("");
      setDeleteJobNotice(null);
      queryClient.invalidateQueries({ queryKey: ["inventory-delete-job-current"] });
    }
  });

  const deleteJobStatus: InventoryDeleteJobStatus | undefined = deleteJobStatusQuery.data;
  const deleteInProgress = Boolean(deleteJobStatus?.active);

  useEffect(() => {
    const status = deleteJobStatus;
    if (!status || !status.job_id || status.active) {
      return;
    }
    const completionKey = completionNoticeKey(status);
    if (!completionKey) {
      return;
    }
    if (lastHandledDeleteJobRef.current === completionKey) {
      return;
    }
    lastHandledDeleteJobRef.current = completionKey;
    if (dismissedDeleteJobKey === completionKey) {
      invalidateInventoryAndMonitorQueries();
      return;
    }

    const startedAt = formatDateTime(status.started_at);
    const completedAt = formatDateTime(status.completed_at);

    if (status.state === "completed") {
      const matched = status.matched_endpoints ?? 0;
      const deleted = status.deleted_endpoints ?? 0;
      if (matched === 0) {
        setDeleteJobNotice({
          type: "info",
          message: `Selected target has no endpoints to delete. Started: ${startedAt}. Completed: ${completedAt}.`
        });
      } else {
        setDeleteJobNotice({
          type: "success",
          message: `Deletion completed: deleted ${deleted} endpoint(s) out of ${matched} matched endpoint(s). Started: ${startedAt}. Completed: ${completedAt}.`
        });
      }
    } else if (status.state === "failed") {
      setDeleteJobNotice({
        type: "error",
        message: `${status.error || "Inventory deletion job failed."} Started: ${startedAt}. Completed: ${completedAt}.`
      });
    }

    invalidateInventoryAndMonitorQueries();
  }, [deleteJobStatus, dismissedDeleteJobKey]);

  const summary = useMemo(() => {
    if (!preview) {
      return null;
    }
    return preview.candidates.reduce(
      (acc, item) => {
        acc[item.action] += 1;
        return acc;
      },
      { add: 0, update: 0, unchanged: 0, invalid: 0 } as Record<ImportCandidate["action"], number>
    );
  }, [preview]);

  const deleteJobTargetLabel = useMemo(() => {
    if (!deleteJobStatus || !deleteJobStatus.mode) {
      return "Target: —";
    }
    if (deleteJobStatus.mode === "all") {
      return "Target: All endpoints";
    }
    const targetGroup = (groupsQuery.data || []).find((group) => group.id === deleteJobStatus.group_id);
    return `Target: ${targetGroup?.name || `Group ${deleteJobStatus.group_id}`}`;
  }, [deleteJobStatus, groupsQuery.data]);

  const deleteJobEtaLabel = useMemo(() => {
    if (!deleteInProgress) {
      return "";
    }
    return formatEta(deleteJobStatus?.eta_seconds);
  }, [deleteInProgress, deleteJobStatus?.eta_seconds]);

  const deleteJobPingLabel = useMemo(() => {
    const totalPingRows = deleteJobStatus?.total_ping_rows || 0;
    if (totalPingRows <= 0) {
      return "";
    }
    const deletedPingRows = deleteJobStatus?.deleted_ping_rows || 0;
    return `${deletedPingRows}/${totalPingRows} ping rows purged`;
  }, [deleteJobStatus?.total_ping_rows, deleteJobStatus?.deleted_ping_rows]);

  const groupAssignmentInvalid =
    assignToGroup &&
    ((groupAssignmentMode === "existing" && !selectedGroupID) ||
      (groupAssignmentMode === "create" && newGroupName.trim() === ""));
  const exportDisabled =
    exportCSVMutation.isPending || inventoryQuery.isLoading || (inventoryQuery.data?.length || 0) === 0;

  const dismissDeleteNotice = () => {
    const key = completionNoticeKey(deleteJobStatus);
    if (key && typeof window !== "undefined") {
      window.localStorage.setItem(deleteJobDismissedStorageKey, key);
      setDismissedDeleteJobKey(key);
    }
    setDeleteJobNotice(null);
  };

  return (
    <div className="inventory-page-v13">
      <section
        className={`panel inventory-import-panel inventory-collapsible ${importExpanded ? "is-expanded" : "is-collapsed"}`}
      >
        <div className="panel-header inventory-section-header">
          <div className="inventory-section-heading">
            <h2 className="panel-title">Inventory Import</h2>
            <p className="panel-subtitle">Upload CSV/XLSX, review diff, and apply selected Add/Update actions.</p>
            {lastImportSummary ? (
              <div className="inventory-inline-summary" role="status" aria-live="polite">
                Last import: Added {lastImportSummary.added}, Updated {lastImportSummary.updated}, Errors{" "}
                {lastImportSummary.errors}
                {lastImportSummary.group_name ? (
                  <> · Group "{lastImportSummary.group_name}" assigned {lastImportSummary.assigned_added || 0}</>
                ) : null}
              </div>
            ) : null}
          </div>
          <button className="btn btn-small" type="button" onClick={() => setImportExpanded((current) => !current)}>
            {importExpanded ? "Collapse" : "Expand"}
          </button>
        </div>

        {importExpanded ? (
          <div className="inventory-panel-body">
          <div className="inventory-actions">
            <input
              key={importFileInputKey}
              type="file"
              accept=".csv,.xlsx,.xls,.xlsm"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
            <button className="btn btn-primary" type="button" onClick={() => file && previewMutation.mutate(file)} disabled={!file}>
              Preview
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => applyMutation.mutate()}
              disabled={!preview || Object.keys(selection).length === 0 || groupAssignmentInvalid}
            >
              Apply Selected
            </button>
          </div>

          <div className="inventory-import-assignment">
            <label className="inventory-import-assignment-toggle">
              <input
                type="checkbox"
                checked={assignToGroup}
                onChange={(event) => setAssignToGroup(event.target.checked)}
              />
              Assign uploaded endpoints to a group
            </label>
            {assignToGroup ? (
              <div className="inventory-import-assignment-controls">
                <label>
                  Assignment Mode
                  <select
                    value={groupAssignmentMode}
                    onChange={(event) => setGroupAssignmentMode(event.target.value as "existing" | "create")}
                  >
                    <option value="existing">Existing Group</option>
                    <option value="create">Create Group</option>
                  </select>
                </label>

                {groupAssignmentMode === "existing" ? (
                  <label>
                    Select Group
                    <select
                      value={selectedGroupID}
                      onChange={(event) => setSelectedGroupID(event.target.value)}
                      disabled={groupsQuery.isLoading}
                    >
                      <option value="">Select a group</option>
                      {(groupsQuery.data || []).map((group) => (
                        <option key={group.id} value={String(group.id)}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    New Group Name
                    <input
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)}
                      placeholder="NOC-Upload-2026-02-09"
                    />
                  </label>
                )}
              </div>
            ) : null}
            <div className="field-help">
              All valid rows in this upload (add/update/unchanged) will be added to the selected group. Existing group
              members are kept.
            </div>
          </div>

          {previewMutation.error && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(previewMutation.error as Error).message}
            </div>
          )}
          {applyMutation.error && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(applyMutation.error as Error).message}
            </div>
          )}
          {applyMutation.data && (
            <div className="success-banner" role="status" aria-live="polite">
              Added: {applyMutation.data.added}, Updated: {applyMutation.data.updated}, Errors: {applyMutation.data.errors.length}
              {applyMutation.data.group_assignment ? (
                <div>
                  Group "{applyMutation.data.group_assignment.group_name}": added {applyMutation.data.group_assignment.assigned_added}{" "}
                  member links ({applyMutation.data.group_assignment.resolved_endpoints}/
                  {applyMutation.data.group_assignment.valid_upload_ips} resolved).
                </div>
              ) : null}
            </div>
          )}
          {applyMutation.data?.group_assignment?.used_existing_by_name && (
            <div className="info-banner" role="status" aria-live="polite">
              Group "{applyMutation.data.group_assignment.group_name}" already exists; using existing group.
            </div>
          )}
          {applyMutation.data?.group_assignment && applyMutation.data.group_assignment.unresolved_ips > 0 && (
            <div className="info-banner" role="status" aria-live="polite">
              {applyMutation.data.group_assignment.unresolved_ips} valid uploaded IP(s) were not found in inventory at apply
              time, so they could not be assigned to the group.
            </div>
          )}

          {summary && (
            <div className="summary-row">
              <span className="status-chip">Add: {summary.add}</span>
              <span className="status-chip">Update: {summary.update}</span>
              <span className="status-chip">Unchanged: {summary.unchanged}</span>
              <span className="status-chip">Invalid: {summary.invalid}</span>
            </div>
          )}

          {preview && (
            <div className="table-scroll import-preview-table">
              <table className="monitor-table">
                <thead>
                  <tr>
                    <th>Apply</th>
                    <th>Action</th>
                    <th>Row</th>
                    <th>IP</th>
                    <th>MAC</th>
                    <th>VLAN</th>
                    <th>Switch</th>
                    <th>Port</th>
                    <th>Port Type</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.candidates.map((candidate) => {
                    const eligible = candidate.action === "add" || candidate.action === "update";
                    const selected = selection[candidate.row_id];
                    return (
                      <tr key={candidate.row_id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={Boolean(selected)}
                            disabled={!eligible}
                            onChange={(event) => {
                              setSelection((prev) => {
                                const next = { ...prev };
                                if (!event.target.checked) {
                                  delete next[candidate.row_id];
                                } else {
                                  next[candidate.row_id] = eligible ? (candidate.action as "add" | "update") : "add";
                                }
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className={badgeClass(candidate.action)}>{candidate.action}</span>
                            <select
                              value={selected || candidate.action}
                              disabled={!eligible || !selected}
                              onChange={(event) =>
                                setSelection((prev) => ({
                                  ...prev,
                                  [candidate.row_id]: event.target.value as "add" | "update"
                                }))
                              }
                            >
                              <option value="add">add</option>
                              <option value="update">update</option>
                            </select>
                          </div>
                        </td>
                        <td>{candidate.source_row}</td>
                        <td>{candidate.ip}</td>
                        <td>{candidate.mac}</td>
                        <td>{candidate.vlan}</td>
                        <td>{candidate.switch}</td>
                        <td>{candidate.port}</td>
                        <td>{candidate.port_type || "-"}</td>
                        <td>{candidate.message}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </div>
        ) : null}
      </section>

      <section
        className={`panel inventory-single-add-panel inventory-collapsible ${singleEndpointExpanded ? "is-expanded" : "is-collapsed"}`}
      >
        <div className="panel-header inventory-section-header">
          <div className="inventory-section-heading">
            <h2 className="panel-title">Add Single Endpoint</h2>
            <p className="panel-subtitle">Quickly add one endpoint. If hostname is blank, IP will be used.</p>
            {createSingleEndpointMutation.data ? (
              <div className="inventory-inline-summary" role="status" aria-live="polite">
                Last added: {createSingleEndpointMutation.data.ip_address} ({createSingleEndpointMutation.data.hostname})
              </div>
            ) : null}
          </div>
          <button className="btn btn-small" type="button" onClick={() => setSingleEndpointExpanded((current) => !current)}>
            {singleEndpointExpanded ? "Collapse" : "Expand"}
          </button>
        </div>

        {singleEndpointExpanded ? (
          <div className="inventory-panel-body">
          <div className="inventory-single-grid">
            <label>
              IP Address (required)
              <input
                value={singleEndpoint.ip_address || ""}
                onChange={(event) =>
                  setSingleEndpoint((prev) => ({
                    ...prev,
                    ip_address: event.target.value
                  }))
                }
                placeholder="10.20.30.40"
              />
            </label>
            <label>
              Hostname (optional)
              <input
                value={singleEndpoint.hostname || ""}
                onChange={(event) =>
                  setSingleEndpoint((prev) => ({
                    ...prev,
                    hostname: event.target.value
                  }))
                }
                placeholder="server-a-01"
              />
            </label>
            <label>
              Group (optional)
              <select
                value={singleEndpoint.group_id ? String(singleEndpoint.group_id) : ""}
                onChange={(event) =>
                  setSingleEndpoint((prev) => ({
                    ...prev,
                    group_id: event.target.value ? Number(event.target.value) : undefined
                  }))
                }
                disabled={groupsQuery.isLoading}
              >
                <option value="">Default (no group)</option>
                {(groupsQuery.data || []).map((group) => (
                  <option key={group.id} value={String(group.id)}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details
            className="inventory-single-advanced"
            open={singleEndpointAdvancedOpen}
            onToggle={(event) => setSingleEndpointAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>Advanced Fields</summary>
            <div className="inventory-single-advanced-grid">
              <label>
                MAC Address
                <input
                  value={singleEndpoint.mac_address || ""}
                  onChange={(event) =>
                    setSingleEndpoint((prev) => ({
                      ...prev,
                      mac_address: event.target.value.toUpperCase()
                    }))
                  }
                  placeholder="AA:BB:CC:DD:EE:FF"
                />
              </label>
              <label>
                VLAN
                <input
                  value={singleEndpoint.vlan || ""}
                  onChange={(event) =>
                    setSingleEndpoint((prev) => ({
                      ...prev,
                      vlan: event.target.value
                    }))
                  }
                  placeholder="100"
                />
              </label>
              <label>
                Switch
                <input
                  value={singleEndpoint.switch || ""}
                  onChange={(event) =>
                    setSingleEndpoint((prev) => ({
                      ...prev,
                      switch: event.target.value
                    }))
                  }
                  placeholder="sw1"
                />
              </label>
              <label>
                Port
                <input
                  value={singleEndpoint.port || ""}
                  onChange={(event) =>
                    setSingleEndpoint((prev) => ({
                      ...prev,
                      port: event.target.value
                    }))
                  }
                  placeholder="1/10"
                />
              </label>
              <label>
                Port Type
                <select
                  value={singleEndpoint.port_type || ""}
                  onChange={(event) =>
                    setSingleEndpoint((prev) => ({
                      ...prev,
                      port_type: event.target.value
                    }))
                  }
                >
                  <option value="">Select port type</option>
                  <option value="access">access</option>
                  <option value="trunk">trunk</option>
                </select>
              </label>
              <label>
                Description
                <input
                  value={singleEndpoint.description || ""}
                  onChange={(event) =>
                    setSingleEndpoint((prev) => ({
                      ...prev,
                      description: event.target.value
                    }))
                  }
                  placeholder="Core uplink"
                />
              </label>
              {enabledCustomFields.map((field) => (
                <label key={`single-custom-field-${field.slot}`}>
                  {field.name}
                  <input
                    value={customFieldValueBySlot(
                      {
                        custom_field_1_value: singleEndpoint.custom_field_1_value || "",
                        custom_field_2_value: singleEndpoint.custom_field_2_value || "",
                        custom_field_3_value: singleEndpoint.custom_field_3_value || ""
                      },
                      field.slot
                    )}
                    onChange={(event) =>
                      setSingleEndpoint((prev) =>
                        setCreateRequestCustomFieldValue(prev, field.slot, event.target.value)
                      )
                    }
                    placeholder={`Value for ${field.name}`}
                  />
                </label>
              ))}
            </div>
          </details>

          <div className="field-help">If hostname is blank, the IP address will be used as hostname.</div>

          {createSingleEndpointMutation.error && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(createSingleEndpointMutation.error as Error).message}
            </div>
          )}
          {createSingleEndpointMutation.data && (
            <div className="success-banner" role="status" aria-live="polite">
              Added endpoint {createSingleEndpointMutation.data.ip_address} (
              {createSingleEndpointMutation.data.hostname}).
            </div>
          )}

          <div className="inventory-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={!singleEndpoint.ip_address?.trim() || createSingleEndpointMutation.isPending}
              onClick={() =>
                createSingleEndpointMutation.mutate({
                  ip_address: singleEndpoint.ip_address?.trim() || "",
                  hostname: singleEndpoint.hostname?.trim() || "",
                  mac_address: singleEndpoint.mac_address?.trim() || "",
                  custom_field_1_value: singleEndpoint.custom_field_1_value?.trim() || "",
                  custom_field_2_value: singleEndpoint.custom_field_2_value?.trim() || "",
                  custom_field_3_value: singleEndpoint.custom_field_3_value?.trim() || "",
                  vlan: singleEndpoint.vlan?.trim() || "",
                  switch: singleEndpoint.switch?.trim() || "",
                  port: singleEndpoint.port?.trim() || "",
                  port_type: singleEndpoint.port_type?.trim() || "",
                  description: singleEndpoint.description?.trim() || "",
                  group_id: singleEndpoint.group_id
                })
              }
            >
              Add Endpoint
            </button>
          </div>
          </div>
        ) : null}
      </section>

      <section className="panel inventory-list-panel">
        <div className="panel-header">
          <div className="inventory-title-row">
            <h2 className="panel-title">Current Inventory</h2>
            <div className="button-row inventory-header-actions">
              <button
                className="btn btn-small"
                type="button"
                disabled={exportDisabled}
                onClick={() => exportCSVMutation.mutate()}
              >
                {exportCSVMutation.isPending ? "Exporting..." : "Export CSV"}
              </button>
              <button
                className="btn btn-small"
                type="button"
                onClick={() => {
                  setFilters(defaultFilters);
                  setCustomSearch(defaultCustomSearch);
                }}
              >
                Clear All Filters
              </button>
            </div>
          </div>
          <p className="panel-subtitle">Filter and maintain endpoint metadata (IP is immutable).</p>
        </div>

        <div className="inventory-panel-body">
          <div className="inventory-filter-section">
            <div className="inventory-filter-grid">
              {enabledCustomFields.map((field) => {
                const currentValue = customSearchValueBySlot(customSearch, field.slot);
                const hasValue = currentValue.trim().length > 0;
                return (
                  <details key={`inventory-custom-search-${field.slot}`} className="filter-card" open={hasValue}>
                    <summary className="filter-card-summary">
                      <span>{field.name} Search</span>
                      <span className="count-badge">{hasValue ? 1 : 0}</span>
                    </summary>
                    <div className="filter-card-body">
                      <div className="filter-card-actions">
                        <span>{hasValue ? "Contains match active" : "Contains match"}</span>
                        <button
                          className="btn-link"
                          type="button"
                          onClick={() => setCustomSearch((prev) => setCustomSearchBySlot(prev, field.slot, ""))}
                        >
                          Clear
                        </button>
                      </div>
                      <label>
                        Contains match
                        <input
                          type="text"
                          value={currentValue}
                          onChange={(event) =>
                            setCustomSearch((prev) => setCustomSearchBySlot(prev, field.slot, event.target.value))
                          }
                          placeholder={`Search ${field.name}`}
                        />
                      </label>
                    </div>
                  </details>
                );
              })}
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
                        <button className="btn-link" type="button" onClick={() => setFilters((prev) => ({ ...prev, [filterCard.key]: [] }))}>
                          Clear
                        </button>
                      </div>
                      <select
                        multiple
                        value={selectedValues}
                        onChange={(event) =>
                          setFilters((prev) => ({
                            ...prev,
                            [filterCard.key]: multiSelectValue(event)
                          }))
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

          {(inventoryQuery.error ||
            exportCSVMutation.error ||
            updateMutation.error ||
            startDeleteByGroupJobMutation.error ||
            startDeleteAllJobMutation.error ||
            settingsQuery.error ||
            deleteJobStatusQuery.error) && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(inventoryQuery.error as Error | undefined)?.message ||
                (exportCSVMutation.error as Error | undefined)?.message ||
                (updateMutation.error as Error | undefined)?.message ||
                (startDeleteByGroupJobMutation.error as Error | undefined)?.message ||
                (startDeleteAllJobMutation.error as Error | undefined)?.message ||
                (settingsQuery.error as Error | undefined)?.message ||
                (deleteJobStatusQuery.error as Error | undefined)?.message}
            </div>
          )}
          {updateMutation.isSuccess && (
            <div className="success-banner" role="status" aria-live="polite">
              Inventory endpoint updated.
            </div>
          )}
          {deleteJobNotice ? (
            <div
              className={
                deleteJobNotice.type === "success"
                  ? "success-banner banner-dismissible"
                  : deleteJobNotice.type === "info"
                    ? "info-banner banner-dismissible"
                    : "error-banner banner-dismissible"
              }
              role={deleteJobNotice.type === "error" ? "alert" : "status"}
              aria-live={deleteJobNotice.type === "error" ? "assertive" : "polite"}
            >
              <span>{deleteJobNotice.message}</span>
              <button
                className="banner-close"
                type="button"
                aria-label="Dismiss deletion message"
                onClick={dismissDeleteNotice}
              >
                ×
              </button>
            </div>
          ) : null}

          {inventoryQuery.isLoading ? (
            <div className="state-panel inventory-state-panel">
              <div>
                <span className="skeleton-bar" style={{ width: 220 }} />
                <p style={{ marginTop: 10 }}>Loading inventory records…</p>
              </div>
            </div>
          ) : (inventoryQuery.data || []).length === 0 ? (
            <div className="state-panel inventory-state-panel">No inventory rows match the active filters.</div>
          ) : (
            <div className="table-scroll inventory-table-scroll">
              <table className="monitor-table">
                <thead>
                  <tr>
                    <th>Hostname</th>
                    <th>IP Address</th>
                    <th>MAC</th>
                    <th>VLAN</th>
                    <th>Switch</th>
                    <th>Port</th>
                    <th>Port Type</th>
                    <th>Description</th>
                    <th>Group</th>
                    {enabledCustomFields.map((field) => (
                      <th key={`inventory-column-custom-${field.slot}`}>{field.name}</th>
                    ))}
                    <th>Updated At</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(inventoryQuery.data || []).map((row) => {
                    const isEditing = editingEndpointID === row.endpoint_id && editingPatch !== null;
                    return (
                      <tr key={row.endpoint_id} className={isEditing ? "row-selected" : ""}>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.hostname}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, hostname: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.hostname || "-"
                          )}
                        </td>
                        <td>{row.ip_address}</td>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.mac_address}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, mac_address: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.mac_address || "-"
                          )}
                        </td>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.vlan}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, vlan: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.vlan || "-"
                          )}
                        </td>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.switch}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, switch: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.switch || "-"
                          )}
                        </td>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.port}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, port: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.port || "-"
                          )}
                        </td>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.port_type}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, port_type: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.port_type || "-"
                          )}
                        </td>
                        <td>
                          {isEditing ? (
                            <input
                              value={editingPatch.description}
                              onChange={(event) =>
                                setEditingPatch((prev) => (prev ? { ...prev, description: event.target.value } : prev))
                              }
                            />
                          ) : (
                            row.description || "-"
                          )}
                        </td>
                        <td>{row.group.join(", ") || "-"}</td>
                        {enabledCustomFields.map((field) => (
                          <td key={`inventory-row-${row.endpoint_id}-custom-${field.slot}`}>
                            {isEditing ? (
                              <input
                                value={customFieldValueBySlot(
                                  {
                                    custom_field_1_value: editingPatch.custom_field_1_value,
                                    custom_field_2_value: editingPatch.custom_field_2_value,
                                    custom_field_3_value: editingPatch.custom_field_3_value
                                  },
                                  field.slot
                                )}
                                onChange={(event) =>
                                  setEditingPatch((prev) =>
                                    prev ? setInventoryPatchCustomFieldValue(prev, field.slot, event.target.value) : prev
                                  )
                                }
                              />
                            ) : (
                              customFieldValueBySlot(
                                {
                                  custom_field_1_value: row.custom_field_1_value || "",
                                  custom_field_2_value: row.custom_field_2_value || "",
                                  custom_field_3_value: row.custom_field_3_value || ""
                                },
                                field.slot
                              ) || "-"
                            )}
                          </td>
                        ))}
                        <td>{new Date(row.updated_at).toLocaleString()}</td>
                        <td>
                          <div className="button-row">
                            {isEditing ? (
                              <>
                                <button className="btn btn-primary" type="button" onClick={() => updateMutation.mutate()}>
                                  Save
                                </button>
                                <button
                                  className="btn"
                                  type="button"
                                  onClick={() => {
                                    setEditingEndpointID(null);
                                    setEditingPatch(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                className="btn"
                                type="button"
                                onClick={() => {
                                  setEditingEndpointID(row.endpoint_id);
                                  setEditingPatch(toPatch(row));
                                }}
                              >
                                Edit
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <section className="inventory-danger-zone" aria-label="Inventory danger zone">
            <h3 className="inventory-danger-title">Danger Zone</h3>
            <p className="field-help">
              Deleting endpoints permanently removes inventory membership and probe history records.
            </p>
            {deleteInProgress ? (
              <div className="inventory-delete-progress" role="status" aria-live="polite">
                <div className="inventory-delete-progress-head">
                  <strong>Deletion in progress</strong>
                  <span>
                    {Math.round(deleteJobStatus?.progress_pct || 0)}% · {deleteJobEtaLabel}
                  </span>
                </div>
                <div className="inventory-delete-progress-track">
                  <div
                    className="inventory-delete-progress-fill"
                    style={{ width: `${Math.max(2, Math.min(100, deleteJobStatus?.progress_pct || 0))}%` }}
                  />
                </div>
                <div className="field-help">
                  {deleteJobTargetLabel} · {(deleteJobStatus?.phase || "processing")}
                  {deleteJobPingLabel ? ` · ${deleteJobPingLabel}` : ""}
                  {" · "}
                  {deleteJobStatus?.processed_endpoints || 0}/{deleteJobStatus?.matched_endpoints || 0} endpoints processed ·{" "}
                  {deleteJobStatus?.deleted_endpoints || 0} deleted
                </div>
              </div>
            ) : null}
            <div className="inventory-danger-grid">
              <div className="inventory-danger-card">
                <h4>Delete Endpoints By Group</h4>
                <label>
                  Group
                  <select value={deleteGroupID} onChange={(event) => setDeleteGroupID(event.target.value)}>
                    <option value="">Select a group</option>
                    {(groupsQuery.data || []).map((group) => (
                      <option key={group.id} value={String(group.id)}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="button-row">
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={!deleteGroupID || startDeleteByGroupJobMutation.isPending || deleteInProgress}
                    onClick={() => {
                      const groupID = Number(deleteGroupID);
                      const groupName = (groupsQuery.data || []).find((group) => group.id === groupID)?.name || "selected group";
                      const isNoGroup = groupName.trim().toLowerCase() === "no group";
                      const confirmMessage = isNoGroup
                        ? `Delete all endpoints assigned to "${groupName}"? This may delete a large number of endpoints and historical probe data. Continue?`
                        : `Delete all endpoints assigned to "${groupName}"? This cannot be undone.`;
                      const confirmed = window.confirm(confirmMessage);
                      if (!confirmed) {
                        return;
                      }
                      setDeleteJobNotice(null);
                      startDeleteByGroupJobMutation.mutate(groupID);
                    }}
                  >
                    Delete Group Endpoints
                  </button>
                </div>
              </div>

              <div className="inventory-danger-card">
                <h4>Delete All Endpoints</h4>
                <p className="field-help">
                  This removes every endpoint and all related probe data from the database.
                </p>
                {!deleteAllArmed ? (
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={deleteInProgress}
                    onClick={() => {
                      setDeleteAllArmed(true);
                      setDeleteAllPhrase("");
                    }}
                  >
                    Start Delete-All
                  </button>
                ) : (
                  <div className="inventory-delete-all-confirm">
                    <p className="field-help">
                      Type <code>DELETE ALL ENDPOINTS</code> to confirm.
                    </p>
                    <input
                      value={deleteAllPhrase}
                      onChange={(event) => setDeleteAllPhrase(event.target.value)}
                      placeholder="DELETE ALL ENDPOINTS"
                    />
                    <div className="button-row">
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          setDeleteAllArmed(false);
                          setDeleteAllPhrase("");
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={
                          deleteAllPhrase.trim() !== "DELETE ALL ENDPOINTS" ||
                          startDeleteAllJobMutation.isPending ||
                          deleteInProgress
                        }
                        onClick={() => {
                          const finalConfirm = window.confirm(
                            "Final confirmation: delete ALL endpoints and related data?"
                          );
                          if (!finalConfirm) {
                            return;
                          }
                          setDeleteJobNotice(null);
                          startDeleteAllJobMutation.mutate(deleteAllPhrase.trim());
                        }}
                      >
                        Delete All Endpoints
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
