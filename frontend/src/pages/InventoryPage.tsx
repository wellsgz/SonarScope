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
    description: row.description,
  };
}

function multiSelectValue(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.target.selectedOptions).map((option) => option.value);
}

export function InventoryPage() {
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<Record<string, "add" | "update">>({});

  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [editingEndpointID, setEditingEndpointID] = useState<number | null>(null);
  const [editingPatch, setEditingPatch] = useState<InventoryPatch | null>(null);

  const filterOptionsQuery = useQuery({
    queryKey: ["inventory-filter-options"],
    queryFn: listInventoryFilterOptions
  });

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
    <div className="inventory-v11-page">
      <div className="panel inventory-import-panel">
        <h2>Inventory Import</h2>
        <p>Upload CSV/XLSX and apply selected Add/Update changes after preview.</p>

        <div className="inventory-actions">
          <input
            type="file"
            accept=".csv,.xlsx,.xls,.xlsm"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
          <button className="btn btn-primary" onClick={() => file && previewMutation.mutate(file)} disabled={!file}>
            Preview
          </button>
          <button
            className="btn"
            onClick={() => applyMutation.mutate()}
            disabled={!preview || Object.keys(selection).length === 0}
          >
            Apply Selected
          </button>
        </div>

        {previewMutation.error && <div className="error-banner">{(previewMutation.error as Error).message}</div>}
        {applyMutation.error && <div className="error-banner">{(applyMutation.error as Error).message}</div>}
        {applyMutation.data && (
          <div className="success-banner">
            Added: {applyMutation.data.added}, Updated: {applyMutation.data.updated}, Errors:
            {applyMutation.data.errors.length}
          </div>
        )}

        {summary && (
          <div className="summary-row">
            <span>Add: {summary.add}</span>
            <span>Update: {summary.update}</span>
            <span>Unchanged: {summary.unchanged}</span>
            <span>Invalid: {summary.invalid}</span>
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
                      </td>
                      <td>{candidate.source_row}</td>
                      <td>{candidate.ip}</td>
                      <td>{candidate.mac}</td>
                      <td>{candidate.vlan}</td>
                      <td>{candidate.switch}</td>
                      <td>{candidate.port}</td>
                      <td>{candidate.port_type}</td>
                      <td>{candidate.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel inventory-list-panel">
        <div className="inventory-title-row">
          <h2>Current Inventory</h2>
          <button className="btn btn-small" onClick={() => setFilters({ vlan: [], switches: [], ports: [], groups: [] })}>
            Clear All Filters
          </button>
        </div>

        <div className="inventory-filter-grid">
          <label>
            <span className="filter-label-row">
              <span>VLAN</span>
              <button className="btn-link" type="button" onClick={() => setFilters((prev) => ({ ...prev, vlan: [] }))}>
                Clear
              </button>
            </span>
            <select
              multiple
              value={filters.vlan}
              onChange={(event) => setFilters((prev) => ({ ...prev, vlan: multiSelectValue(event) }))}
            >
              {(filterOptionsQuery.data?.vlan || []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="filter-label-row">
              <span>Switch</span>
              <button
                className="btn-link"
                type="button"
                onClick={() => setFilters((prev) => ({ ...prev, switches: [] }))}
              >
                Clear
              </button>
            </span>
            <select
              multiple
              value={filters.switches}
              onChange={(event) => setFilters((prev) => ({ ...prev, switches: multiSelectValue(event) }))}
            >
              {(filterOptionsQuery.data?.switch || []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="filter-label-row">
              <span>Port</span>
              <button className="btn-link" type="button" onClick={() => setFilters((prev) => ({ ...prev, ports: [] }))}>
                Clear
              </button>
            </span>
            <select
              multiple
              value={filters.ports}
              onChange={(event) => setFilters((prev) => ({ ...prev, ports: multiSelectValue(event) }))}
            >
              {(filterOptionsQuery.data?.port || []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="filter-label-row">
              <span>Group</span>
              <button
                className="btn-link"
                type="button"
                onClick={() => setFilters((prev) => ({ ...prev, groups: [] }))}
              >
                Clear
              </button>
            </span>
            <select
              multiple
              value={filters.groups}
              onChange={(event) => setFilters((prev) => ({ ...prev, groups: multiSelectValue(event) }))}
            >
              {(filterOptionsQuery.data?.group || []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>

        {(inventoryQuery.error || updateMutation.error) && (
          <div className="error-banner">
            {(inventoryQuery.error as Error | undefined)?.message || (updateMutation.error as Error | undefined)?.message}
          </div>
        )}
        {updateMutation.isSuccess && <div className="success-banner">Inventory endpoint updated.</div>}

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
                  <tr key={row.endpoint_id}>
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
                            <button className="btn btn-primary" onClick={() => updateMutation.mutate()}>
                              Save
                            </button>
                            <button
                              className="btn"
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
      </div>
    </div>
  );
}
