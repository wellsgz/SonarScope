import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyInventoryPreview,
  createInventoryEndpoint,
  deleteAllInventoryEndpoints,
  deleteInventoryEndpointsByGroup,
  importInventoryPreview,
  listGroups,
  listInventoryEndpoints,
  listInventoryFilterOptions,
  updateInventoryEndpoint
} from "../api/client";
import type { ImportCandidate, ImportPreview, InventoryEndpoint, InventoryEndpointCreateRequest } from "../types/api";

type FilterState = {
  vlan: string[];
  switches: string[];
  ports: string[];
  groups: string[];
};

type InventoryPatch = {
  hostname: string;
  mac_address: string;
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

function toPatch(row: InventoryEndpoint): InventoryPatch {
  return {
    hostname: row.hostname,
    mac_address: row.mac_address,
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

export function InventoryPage() {
  const queryClient = useQueryClient();

  const initialSingleEndpoint: InventoryEndpointCreateRequest = {
    ip_address: "",
    hostname: "",
    mac_address: "",
    vlan: "",
    switch: "",
    port: "",
    port_type: "",
    description: ""
  };

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<Record<string, "add" | "update">>({});
  const [assignToGroup, setAssignToGroup] = useState(false);
  const [groupAssignmentMode, setGroupAssignmentMode] = useState<"existing" | "create">("existing");
  const [selectedGroupID, setSelectedGroupID] = useState("");
  const [newGroupName, setNewGroupName] = useState("");

  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [editingEndpointID, setEditingEndpointID] = useState<number | null>(null);
  const [editingPatch, setEditingPatch] = useState<InventoryPatch | null>(null);
  const [singleEndpoint, setSingleEndpoint] = useState<InventoryEndpointCreateRequest>(initialSingleEndpoint);
  const [singleEndpointAdvancedOpen, setSingleEndpointAdvancedOpen] = useState(false);
  const [deleteGroupID, setDeleteGroupID] = useState("");
  const [deleteAllArmed, setDeleteAllArmed] = useState(false);
  const [deleteAllPhrase, setDeleteAllPhrase] = useState("");

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

  filterCards[0].options = filterOptionsQuery.data?.vlan || [];
  filterCards[1].options = filterOptionsQuery.data?.switch || [];
  filterCards[2].options = filterOptionsQuery.data?.port || [];
  filterCards[3].options = filterOptionsQuery.data?.group || [];

  const inventoryQuery = useQuery({
    queryKey: ["inventory-endpoints", filters],
    queryFn: () =>
      listInventoryEndpoints({
        vlan: filters.vlan,
        switches: filters.switches,
        ports: filters.ports,
        groups: filters.groups
      })
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
    onSuccess: () => {
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

  const deleteByGroupMutation = useMutation({
    mutationFn: (groupID: number) => deleteInventoryEndpointsByGroup(groupID),
    onSuccess: () => {
      setEditingEndpointID(null);
      setEditingPatch(null);
      invalidateInventoryAndMonitorQueries();
    }
  });

  const deleteAllMutation = useMutation({
    mutationFn: (confirmPhrase: string) => deleteAllInventoryEndpoints(confirmPhrase),
    onSuccess: () => {
      setEditingEndpointID(null);
      setEditingPatch(null);
      setDeleteAllArmed(false);
      setDeleteAllPhrase("");
      invalidateInventoryAndMonitorQueries();
    }
  });

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

  const groupAssignmentInvalid =
    assignToGroup &&
    ((groupAssignmentMode === "existing" && !selectedGroupID) ||
      (groupAssignmentMode === "create" && newGroupName.trim() === ""));

  return (
    <div className="inventory-page-v13">
      <section className="panel inventory-import-panel">
        <div className="panel-header">
          <h2 className="panel-title">Inventory Import</h2>
          <p className="panel-subtitle">Upload CSV/XLSX, review diff, and apply selected Add/Update actions.</p>
        </div>

        <div className="inventory-panel-body">
          <div className="inventory-actions">
            <input type="file" accept=".csv,.xlsx,.xls,.xlsm" onChange={(event) => setFile(event.target.files?.[0] || null)} />
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
      </section>

      <section className="panel inventory-single-add-panel">
        <div className="panel-header">
          <h2 className="panel-title">Add Single Endpoint</h2>
          <p className="panel-subtitle">Quickly add one endpoint. If hostname is blank, IP will be used.</p>
        </div>

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
                  vlan: singleEndpoint.vlan?.trim() || "",
                  switch: singleEndpoint.switch?.trim() || "",
                  port: singleEndpoint.port?.trim() || "",
                  port_type: singleEndpoint.port_type?.trim() || "",
                  description: singleEndpoint.description?.trim() || ""
                })
              }
            >
              Add Endpoint
            </button>
          </div>
        </div>
      </section>

      <section className="panel inventory-list-panel">
        <div className="panel-header">
          <div className="inventory-title-row">
            <h2 className="panel-title">Current Inventory</h2>
            <button className="btn btn-small" type="button" onClick={() => setFilters(defaultFilters)}>
              Clear All Filters
            </button>
          </div>
          <p className="panel-subtitle">Filter and maintain endpoint metadata (IP is immutable).</p>
        </div>

        <div className="inventory-panel-body">
          <div className="inventory-filter-section">
            <div className="inventory-filter-grid">
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

          {(inventoryQuery.error || updateMutation.error || deleteByGroupMutation.error || deleteAllMutation.error) && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(inventoryQuery.error as Error | undefined)?.message ||
                (updateMutation.error as Error | undefined)?.message ||
                (deleteByGroupMutation.error as Error | undefined)?.message ||
                (deleteAllMutation.error as Error | undefined)?.message}
            </div>
          )}
          {updateMutation.isSuccess && (
            <div className="success-banner" role="status" aria-live="polite">
              Inventory endpoint updated.
            </div>
          )}
          {deleteByGroupMutation.data && (
            <div className="success-banner" role="status" aria-live="polite">
              Deleted {deleteByGroupMutation.data.deleted_count} endpoint(s) from selected group.
            </div>
          )}
          {deleteAllMutation.data && (
            <div className="success-banner" role="status" aria-live="polite">
              Deleted {deleteAllMutation.data.deleted_count} endpoint(s) from inventory.
            </div>
          )}

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
                    disabled={!deleteGroupID || deleteByGroupMutation.isPending}
                    onClick={() => {
                      const groupID = Number(deleteGroupID);
                      const groupName = (groupsQuery.data || []).find((group) => group.id === groupID)?.name || "selected group";
                      const confirmed = window.confirm(
                        `Delete all endpoints assigned to "${groupName}"? This cannot be undone.`
                      );
                      if (!confirmed) {
                        return;
                      }
                      deleteByGroupMutation.mutate(groupID);
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
                        disabled={deleteAllPhrase.trim() !== "DELETE ALL ENDPOINTS" || deleteAllMutation.isPending}
                        onClick={() => {
                          const finalConfirm = window.confirm(
                            "Final confirmation: delete ALL endpoints and related data?"
                          );
                          if (!finalConfirm) {
                            return;
                          }
                          deleteAllMutation.mutate(deleteAllPhrase.trim());
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
