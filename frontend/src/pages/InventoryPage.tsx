import { useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyInventoryPreview,
  importInventoryPreview,
  listInventoryEndpoints,
  listInventoryFilterOptions,
  updateInventoryEndpoint
} from "../api/client";
import type { ImportCandidate, ImportPreview, InventoryEndpoint } from "../types/api";

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

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<Record<string, "add" | "update">>({});

  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [editingEndpointID, setEditingEndpointID] = useState<number | null>(null);
  const [editingPatch, setEditingPatch] = useState<InventoryPatch | null>(null);

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
            selections: Object.entries(selection).map(([row_id, action]) => ({ row_id, action }))
          })
        : Promise.reject(new Error("No preview available")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory-endpoints"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-filter-options"] });
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
      queryClient.invalidateQueries({ queryKey: ["inventory-endpoints"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-filter-options"] });
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

  return (
    <div className="inventory-page-v13">
      <section className="panel inventory-import-panel">
        <div className="panel-header" style={{ margin: "-1rem -1rem 0" }}>
          <h2 className="panel-title">Inventory Import</h2>
          <p className="panel-subtitle">Upload CSV/XLSX, review diff, and apply selected Add/Update actions.</p>
        </div>

        <div className="inventory-actions">
          <input type="file" accept=".csv,.xlsx,.xls,.xlsm" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          <button className="btn btn-primary" type="button" onClick={() => file && previewMutation.mutate(file)} disabled={!file}>
            Preview
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={!preview || Object.keys(selection).length === 0}
          >
            Apply Selected
          </button>
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
      </section>

      <section className="panel inventory-list-panel">
        <div className="panel-header" style={{ margin: "-1rem -1rem 0" }}>
          <div className="inventory-title-row">
            <h2 className="panel-title">Current Inventory</h2>
            <button className="btn btn-small" type="button" onClick={() => setFilters(defaultFilters)}>
              Clear All Filters
            </button>
          </div>
          <p className="panel-subtitle">Filter and maintain endpoint metadata (IP is immutable).</p>
        </div>

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

        {(inventoryQuery.error || updateMutation.error) && (
          <div className="error-banner" role="alert" aria-live="assertive">
            {(inventoryQuery.error as Error | undefined)?.message || (updateMutation.error as Error | undefined)?.message}
          </div>
        )}
        {updateMutation.isSuccess && (
          <div className="success-banner" role="status" aria-live="polite">
            Inventory endpoint updated.
          </div>
        )}

        {inventoryQuery.isLoading ? (
          <div className="panel state-panel" style={{ minHeight: 220 }}>
            <div>
              <span className="skeleton-bar" style={{ width: 220 }} />
              <p style={{ marginTop: 10 }}>Loading inventory records…</p>
            </div>
          </div>
        ) : (inventoryQuery.data || []).length === 0 ? (
          <div className="panel state-panel" style={{ minHeight: 220 }}>
            No inventory rows match the active filters.
          </div>
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
      </section>
    </div>
  );
}
