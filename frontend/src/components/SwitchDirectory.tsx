import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applySwitchDirectoryPreview,
  cancelSwitchDirectoryPreview,
  deleteSwitchDirectoryEntry,
  downloadSwitchDirectoryImportTemplateCSV,
  exportSwitchDirectoryCSV,
  importSwitchDirectoryPreview,
  listSwitchDirectory,
  upsertSwitchDirectoryEntry
} from "../api/client";
import type {
  SwitchDirectoryImportCandidate,
  SwitchDirectoryImportPreview
} from "../types/api";

type SwitchDirectoryTab = "manage" | "import";

function switchImportBadgeClass(action: SwitchDirectoryImportCandidate["action"]) {
  if (action === "add") return "badge badge-add";
  if (action === "update") return "badge badge-update";
  if (action === "invalid") return "badge badge-invalid";
  return "badge badge-unchanged";
}

function downloadBlob(blob: Blob, filename: string) {
  const downloadURL = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = downloadURL;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadURL), 0);
}

export function SwitchDirectory() {
  const queryClient = useQueryClient();
  const switchDirectoryQuery = useQuery({ queryKey: ["switch-directory"], queryFn: listSwitchDirectory });
  const [expanded, setExpanded] = useState(false);
  const [switchDirectoryTab, setSwitchDirectoryTab] = useState<SwitchDirectoryTab>("manage");
  const [switchDirectoryDraft, setSwitchDirectoryDraft] = useState({ name: "", ip_address: "" });
  const [switchDirectoryFile, setSwitchDirectoryFile] = useState<File | null>(null);
  const [switchDirectoryFileInputKey, setSwitchDirectoryFileInputKey] = useState(0);
  const [switchDirectoryPreview, setSwitchDirectoryPreview] = useState<SwitchDirectoryImportPreview | null>(null);
  const [switchDirectorySelection, setSwitchDirectorySelection] = useState<Record<string, "add" | "update">>({});
  const [lastSwitchDirectoryImportSummary, setLastSwitchDirectoryImportSummary] = useState<{
    added: number;
    updated: number;
    errors: number;
  } | null>(null);
  const [lastSwitchDirectorySave, setLastSwitchDirectorySave] = useState<{ name: string; ip_address: string } | null>(null);
  const [deletingSwitchDirectoryID, setDeletingSwitchDirectoryID] = useState<number | null>(null);

  const switchDirectoryPreviewSummary = useMemo(() => {
    if (!switchDirectoryPreview) {
      return null;
    }
    return switchDirectoryPreview.candidates.reduce(
      (acc, item) => {
        acc[item.action] += 1;
        return acc;
      },
      { add: 0, update: 0, unchanged: 0, invalid: 0 } as Record<SwitchDirectoryImportCandidate["action"], number>
    );
  }, [switchDirectoryPreview]);

  const headerSummary = useMemo(() => {
    if (lastSwitchDirectoryImportSummary) {
      return `Last import: Added ${lastSwitchDirectoryImportSummary.added}, Updated ${lastSwitchDirectoryImportSummary.updated}, Errors ${lastSwitchDirectoryImportSummary.errors}`;
    }
    if (lastSwitchDirectorySave) {
      return `Last saved: ${lastSwitchDirectorySave.name} (${lastSwitchDirectorySave.ip_address})`;
    }
    return "";
  }, [lastSwitchDirectoryImportSummary, lastSwitchDirectorySave]);

  function invalidateSwitchDirectoryQueries() {
    queryClient.invalidateQueries({ queryKey: ["switch-directory"] });
    queryClient.invalidateQueries({ queryKey: ["monitor-switch-ips"] });
  }

  function resetSwitchDirectoryPreviewState(resetMutationState = false) {
    setSwitchDirectoryPreview(null);
    setSwitchDirectorySelection({});
    setSwitchDirectoryFile(null);
    setSwitchDirectoryFileInputKey((value) => value + 1);
    if (resetMutationState) {
      switchDirectoryPreviewMutation.reset();
      switchDirectoryApplyMutation.reset();
    }
  }

  const switchDirectoryUpsertMutation = useMutation({
    mutationFn: (payload: { name: string; ip_address: string }) => upsertSwitchDirectoryEntry(payload),
    onSuccess: (data) => {
      setLastSwitchDirectorySave({ name: data.name, ip_address: data.ip_address });
      setSwitchDirectoryDraft({ name: "", ip_address: "" });
      invalidateSwitchDirectoryQueries();
    }
  });
  const switchDirectoryDeleteMutation = useMutation({
    mutationFn: (id: number) => deleteSwitchDirectoryEntry(id),
    onMutate: (id) => {
      setDeletingSwitchDirectoryID(id);
    },
    onSuccess: () => {
      invalidateSwitchDirectoryQueries();
    },
    onSettled: () => {
      setDeletingSwitchDirectoryID(null);
    }
  });
  const switchDirectoryTemplateMutation = useMutation({
    mutationFn: () => downloadSwitchDirectoryImportTemplateCSV(),
    onSuccess: ({ blob, filename }) => {
      downloadBlob(blob, filename);
    }
  });
  const switchDirectoryExportMutation = useMutation({
    mutationFn: () => exportSwitchDirectoryCSV(),
    onSuccess: ({ blob, filename }) => {
      downloadBlob(blob, filename);
    }
  });
  const switchDirectoryPreviewMutation = useMutation({
    mutationFn: (file: File) => importSwitchDirectoryPreview(file),
    onSuccess: (preview) => {
      setSwitchDirectoryPreview(preview);
      const initial: Record<string, "add" | "update"> = {};
      preview.candidates.forEach((candidate) => {
        if (candidate.action === "add" || candidate.action === "update") {
          initial[candidate.row_id] = candidate.action;
        }
      });
      setSwitchDirectorySelection(initial);
    }
  });
  const switchDirectoryApplyMutation = useMutation({
    mutationFn: () =>
      switchDirectoryPreview
        ? applySwitchDirectoryPreview({
            preview_id: switchDirectoryPreview.preview_id,
            selections: Object.entries(switchDirectorySelection).map(([row_id, action]) => ({ row_id, action }))
          })
        : Promise.reject(new Error("No switch directory preview available")),
    onSuccess: (data) => {
      setLastSwitchDirectoryImportSummary({
        added: data.added,
        updated: data.updated,
        errors: data.errors.length
      });
      resetSwitchDirectoryPreviewState();
      invalidateSwitchDirectoryQueries();
    }
  });

  const handleCancelSwitchDirectoryPreview = async () => {
    const previewID = switchDirectoryPreview?.preview_id;
    if (previewID) {
      try {
        await cancelSwitchDirectoryPreview(previewID);
      } catch {
        // best-effort cleanup only
      }
    }
    resetSwitchDirectoryPreviewState(true);
  };

  return (
    <section
      className={`panel inventory-switch-directory-panel inventory-collapsible ${expanded ? "is-expanded" : "is-collapsed"}`}
    >
      <div className="panel-header inventory-section-header">
        <div className="inventory-section-heading">
          <h2 className="panel-title">Switch Directory</h2>
          <p className="panel-subtitle">Maintain switch management IP mappings used by the monitor tooltip and dashboard workflows.</p>
          {headerSummary ? (
            <div className="inventory-inline-summary" role="status" aria-live="polite">
              {headerSummary}
            </div>
          ) : null}
        </div>
        <button className="btn btn-small" type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {expanded ? (
        <div className="inventory-panel-body">
          <div className="button-row inventory-header-actions">
            <button
              className="btn btn-small"
              type="button"
              onClick={() => switchDirectoryTemplateMutation.mutate()}
              disabled={switchDirectoryTemplateMutation.isPending}
            >
              {switchDirectoryTemplateMutation.isPending ? "Downloading..." : "Download Template"}
            </button>
            <button
              className="btn btn-small"
              type="button"
              onClick={() => switchDirectoryExportMutation.mutate()}
              disabled={switchDirectoryExportMutation.isPending}
            >
              {switchDirectoryExportMutation.isPending ? "Exporting..." : "Export CSV"}
            </button>
          </div>

          <div className="inventory-switch-directory-tabs">
            <button
              type="button"
              className={`chip ${switchDirectoryTab === "manage" ? "chip-active" : ""}`}
              onClick={() => setSwitchDirectoryTab("manage")}
            >
              Manage
            </button>
            <button
              type="button"
              className={`chip ${switchDirectoryTab === "import" ? "chip-active" : ""}`}
              onClick={() => setSwitchDirectoryTab("import")}
            >
              Import
            </button>
            <span className="status-chip">{switchDirectoryQuery.data?.length ?? 0} entries</span>
          </div>

          {switchDirectoryTab === "manage" ? (
            <>
              {lastSwitchDirectorySave ? (
                <div className="info-banner" role="status" aria-live="polite">
                  Saved {lastSwitchDirectorySave.name} -&gt; {lastSwitchDirectorySave.ip_address}.
                </div>
              ) : null}

              <div className="inventory-switch-directory-form">
                <label>
                  Switch Name
                  <input
                    value={switchDirectoryDraft.name}
                    onChange={(event) => setSwitchDirectoryDraft((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="core-sw-01"
                  />
                </label>
                <label>
                  Management IP
                  <input
                    value={switchDirectoryDraft.ip_address}
                    onChange={(event) => setSwitchDirectoryDraft((prev) => ({ ...prev, ip_address: event.target.value }))}
                    placeholder="10.0.0.10"
                  />
                </label>
                <div className="button-row inventory-switch-directory-form-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() =>
                      switchDirectoryUpsertMutation.mutate({
                        name: switchDirectoryDraft.name.trim(),
                        ip_address: switchDirectoryDraft.ip_address.trim()
                      })
                    }
                    disabled={
                      switchDirectoryUpsertMutation.isPending ||
                      switchDirectoryDraft.name.trim().length === 0 ||
                      switchDirectoryDraft.ip_address.trim().length === 0
                    }
                  >
                    {switchDirectoryUpsertMutation.isPending ? "Saving..." : "Add / Update"}
                  </button>
                </div>
              </div>

              <div className="table-scroll import-preview-scroll inventory-switch-directory-table">
                <table className="monitor-table">
                  <thead>
                    <tr>
                      <th>Switch</th>
                      <th>Mgmt IP</th>
                      <th>Updated</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(switchDirectoryQuery.data || []).length === 0 ? (
                      <tr className="monitor-table-empty-row">
                        <td colSpan={4}>No switch mappings saved yet.</td>
                      </tr>
                    ) : (
                      (switchDirectoryQuery.data || []).map((entry) => (
                        <tr key={`switch-directory-${entry.id}`}>
                          <td>{entry.name}</td>
                          <td>{entry.ip_address}</td>
                          <td>{new Date(entry.updated_at).toLocaleString()}</td>
                          <td>
                            <button
                              className="btn btn-small"
                              type="button"
                              onClick={() => switchDirectoryDeleteMutation.mutate(entry.id)}
                              disabled={switchDirectoryDeleteMutation.isPending && deletingSwitchDirectoryID === entry.id}
                            >
                              {switchDirectoryDeleteMutation.isPending && deletingSwitchDirectoryID === entry.id ? "Deleting..." : "Delete"}
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              {lastSwitchDirectoryImportSummary ? (
                <div className="success-banner" role="status" aria-live="polite">
                  Imported mappings. Added: {lastSwitchDirectoryImportSummary.added}, Updated: {lastSwitchDirectoryImportSummary.updated},
                  {" "}Errors: {lastSwitchDirectoryImportSummary.errors}
                </div>
              ) : null}

              <div className="inventory-actions inventory-switch-directory-import-actions">
                <input
                  key={switchDirectoryFileInputKey}
                  type="file"
                  accept=".csv"
                  onChange={(event) => setSwitchDirectoryFile(event.target.files?.[0] || null)}
                />
                <button
                  className="btn"
                  type="button"
                  onClick={() => switchDirectoryTemplateMutation.mutate()}
                  disabled={switchDirectoryTemplateMutation.isPending}
                >
                  {switchDirectoryTemplateMutation.isPending ? "Downloading..." : "Download Template"}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => switchDirectoryFile && switchDirectoryPreviewMutation.mutate(switchDirectoryFile)}
                  disabled={!switchDirectoryFile || switchDirectoryPreviewMutation.isPending}
                >
                  {switchDirectoryPreviewMutation.isPending ? "Preparing..." : "Preview"}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => switchDirectoryApplyMutation.mutate()}
                  disabled={
                    !switchDirectoryPreview ||
                    Object.keys(switchDirectorySelection).length === 0 ||
                    switchDirectoryApplyMutation.isPending
                  }
                >
                  {switchDirectoryApplyMutation.isPending ? "Applying..." : "Apply Selected"}
                </button>
              </div>

              {switchDirectoryPreview ? (
                <>
                  <div className="import-preview-head">
                    {switchDirectoryPreviewSummary ? (
                      <div className="summary-row import-preview-summary">
                        <span className="status-chip">Add: {switchDirectoryPreviewSummary.add}</span>
                        <span className="status-chip">Update: {switchDirectoryPreviewSummary.update}</span>
                        <span className="status-chip">Unchanged: {switchDirectoryPreviewSummary.unchanged}</span>
                        <span className="status-chip">Invalid: {switchDirectoryPreviewSummary.invalid}</span>
                      </div>
                    ) : null}
                    <button
                      className="banner-close import-preview-close"
                      type="button"
                      aria-label="Cancel switch directory import preview"
                      onClick={() => {
                        void handleCancelSwitchDirectoryPreview();
                      }}
                      disabled={switchDirectoryApplyMutation.isPending}
                    >
                      x
                    </button>
                  </div>
                  <div className="table-scroll import-preview-table import-preview-scroll inventory-switch-directory-table">
                    <table className="monitor-table">
                      <thead>
                        <tr>
                          <th>Apply</th>
                          <th>Action</th>
                          <th>Row</th>
                          <th>Switch</th>
                          <th>Mgmt IP</th>
                          <th>Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {switchDirectoryPreview.candidates.map((candidate) => {
                          const eligible = candidate.action === "add" || candidate.action === "update";
                          const selected = switchDirectorySelection[candidate.row_id];
                          return (
                            <tr key={candidate.row_id}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(selected)}
                                  disabled={!eligible}
                                  onChange={(event) => {
                                    setSwitchDirectorySelection((prev) => {
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
                                <div className="inventory-switch-directory-preview-action">
                                  <span className={switchImportBadgeClass(candidate.action)}>{candidate.action}</span>
                                  <select
                                    value={selected || candidate.action}
                                    disabled={!eligible || !selected}
                                    onChange={(event) =>
                                      setSwitchDirectorySelection((prev) => ({
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
                              <td>{candidate.name || "-"}</td>
                              <td>{candidate.ip_address || "-"}</td>
                              <td>{candidate.message}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="inventory-switch-directory-empty">
                  Upload a CSV with `name` and `ip_address` columns to preview adds and updates before applying them.
                </div>
              )}
            </>
          )}

          {(switchDirectoryQuery.error ||
            switchDirectoryUpsertMutation.error ||
            switchDirectoryDeleteMutation.error ||
            switchDirectoryTemplateMutation.error ||
            switchDirectoryPreviewMutation.error ||
            switchDirectoryApplyMutation.error) && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(switchDirectoryQuery.error as Error | undefined)?.message ||
                (switchDirectoryUpsertMutation.error as Error | undefined)?.message ||
                (switchDirectoryDeleteMutation.error as Error | undefined)?.message ||
                (switchDirectoryTemplateMutation.error as Error | undefined)?.message ||
                (switchDirectoryPreviewMutation.error as Error | undefined)?.message ||
                (switchDirectoryApplyMutation.error as Error | undefined)?.message}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
