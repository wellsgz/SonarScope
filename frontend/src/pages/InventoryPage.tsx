import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { applyInventoryPreview, importInventoryPreview } from "../api/client";
import type { ImportCandidate, ImportPreview } from "../types/api";

export function InventoryPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selection, setSelection] = useState<Record<string, "add" | "update">>({});

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
        : Promise.reject(new Error("No preview available"))
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
    <div className="panel inventory-page">
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
        <div className="table-scroll">
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
                <th>Status</th>
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
                    <td>{candidate.status}</td>
                    <td>{candidate.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
