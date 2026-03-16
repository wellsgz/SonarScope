import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applySwitchDirectoryPreview,
  cancelSwitchDirectoryPreview,
  deleteSwitchDirectoryEntry,
  downloadSwitchDirectoryImportTemplateCSV,
  getSettings,
  importSwitchDirectoryPreview,
  listSwitchDirectory,
  updateSettings,
  upsertSwitchDirectoryEntry
} from "../api/client";
import type {
  CustomFieldConfig,
  Settings,
  SwitchDirectoryImportCandidate,
  SwitchDirectoryImportPreview
} from "../types/api";

const defaultCustomFields: CustomFieldConfig[] = [
  { slot: 1, enabled: false, name: "" },
  { slot: 2, enabled: false, name: "" },
  { slot: 3, enabled: false, name: "" }
];

const reservedCustomFieldNames = new Set([
  "hostname",
  "ip address",
  "mac",
  "mac address",
  "vlan",
  "switch",
  "port",
  "port type",
  "description",
  "group",
  "updated at",
  "last failed on",
  "reply ip",
  "last success on",
  "success count",
  "failed count",
  "consecutive failed",
  "max consecutive failed",
  "max consec failed time",
  "failed",
  "failed pct",
  "total sent ping",
  "last ping status",
  "last ping latency",
  "average latency"
]);

type CustomFieldValidationIssue = {
  slot: number;
  message: string;
};

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

function normalizeCustomFieldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCustomFields(fields?: CustomFieldConfig[]): CustomFieldConfig[] {
  const bySlot = new Map<number, CustomFieldConfig>();
  defaultCustomFields.forEach((field) => {
    bySlot.set(field.slot, { ...field });
  });
  (fields || []).forEach((field) => {
    if (field.slot < 1 || field.slot > 3) {
      return;
    }
    bySlot.set(field.slot, {
      slot: field.slot,
      enabled: Boolean(field.enabled),
      name: (field.name || "").trim()
    });
  });

  return [1, 2, 3].map((slot) => bySlot.get(slot) || { slot, enabled: false, name: "" });
}

function validateCustomFields(fields: CustomFieldConfig[]): CustomFieldValidationIssue[] {
  const issues: CustomFieldValidationIssue[] = [];
  const usedNames = new Map<string, number>();

  normalizeCustomFields(fields).forEach((field) => {
    if (!field.enabled) {
      return;
    }
    if (!field.name.trim()) {
      issues.push({
        slot: field.slot,
        message: `Custom Field ${field.slot}: field name is required when enabled.`
      });
      return;
    }

    const normalizedName = normalizeCustomFieldName(field.name);
    if (!normalizedName) {
      issues.push({
        slot: field.slot,
        message: `Custom Field ${field.slot}: field name is required when enabled.`
      });
      return;
    }
    if (reservedCustomFieldNames.has(normalizedName)) {
      issues.push({
        slot: field.slot,
        message: `Custom Field ${field.slot}: "${field.name}" conflicts with a reserved built-in field name.`
      });
      return;
    }
    if (usedNames.has(normalizedName)) {
      const existingSlot = usedNames.get(normalizedName);
      issues.push({
        slot: field.slot,
        message: `Custom Field ${field.slot}: "${field.name}" duplicates Custom Field ${existingSlot}.`
      });
      return;
    }
    usedNames.set(normalizedName, field.slot);
  });

  return issues;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const switchDirectoryQuery = useQuery({ queryKey: ["switch-directory"], queryFn: listSwitchDirectory });
  const [draft, setDraft] = useState<Settings>({
    ping_interval_sec: 1,
    icmp_payload_bytes: 56,
    icmp_timeout_ms: 500,
    auto_refresh_sec: 30,
    custom_fields: normalizeCustomFields()
  });
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

  useEffect(() => {
    if (settingsQuery.data) {
      setDraft({
        ...settingsQuery.data,
        custom_fields: normalizeCustomFields(settingsQuery.data.custom_fields)
      });
    }
  }, [settingsQuery.data]);

  const normalizedCustomFields = useMemo(
    () => normalizeCustomFields(draft.custom_fields),
    [draft.custom_fields]
  );
  const customFieldIssues = useMemo(
    () => validateCustomFields(normalizedCustomFields),
    [normalizedCustomFields]
  );
  const enabledCustomFieldCount = useMemo(
    () => normalizedCustomFields.filter((field) => field.enabled && field.name.trim().length > 0).length,
    [normalizedCustomFields]
  );
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

  const saveMutation = useMutation({
    mutationFn: (payload: Settings) => updateSettings(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] })
  });
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
    <div className="settings-layout">
      <section className="panel settings-page">
        <div className="panel-header">
          <h2 className="panel-title">Probe Policy</h2>
          <p className="panel-subtitle">Configure global probe cadence and packet parameters.</p>
        </div>

        <div className="settings-panel-body">
          <div className="setting-grid">
            <label>
              Ping Interval (1-30s)
              <input
                type="number"
                min={1}
                max={30}
                value={draft.ping_interval_sec}
                onChange={(event) => setDraft((prev) => ({ ...prev, ping_interval_sec: Number(event.target.value) }))}
              />
              <span className="settings-inline-help">Lower values improve granularity but increase probe volume.</span>
            </label>

            <label>
              ICMP Payload Size (8-1400 bytes)
              <input
                type="number"
                min={8}
                max={1400}
                value={draft.icmp_payload_bytes}
                onChange={(event) => setDraft((prev) => ({ ...prev, icmp_payload_bytes: Number(event.target.value) }))}
              />
              <span className="settings-inline-help">56 bytes is standard and safe for most environments.</span>
            </label>

            <label>
              ICMP Timeout (20-1000ms)
              <input
                type="number"
                min={20}
                max={1000}
                value={draft.icmp_timeout_ms}
                onChange={(event) => setDraft((prev) => ({ ...prev, icmp_timeout_ms: Number(event.target.value) }))}
              />
              <span className="settings-inline-help">
                Lower values fail faster; higher values tolerate transient network jitter.
              </span>
            </label>

            <label>
              Auto Refresh (1-60s)
              <input
                type="number"
                min={1}
                max={60}
                value={draft.auto_refresh_sec}
                onChange={(event) => setDraft((prev) => ({ ...prev, auto_refresh_sec: Number(event.target.value) }))}
              />
              <span className="settings-inline-help">Applies to monitor refresh cadence and live table updates.</span>
            </label>
          </div>
        </div>
      </section>

      <section className="panel settings-page">
        <div className="panel-header">
          <h2 className="panel-title">Inventory Policy</h2>
          <p className="panel-subtitle">Configure custom endpoint metadata fields for inventory and monitor views.</p>
        </div>

        <div className="settings-panel-body">
          <section className="settings-custom-fields">
            <div className="settings-custom-fields-head">
              <div>
                <h3 className="panel-title">Custom Fields</h3>
                <p className="settings-inline-help">
                  Enable up to three custom endpoint fields. Enabled fields require unique non-overlapping names.
                </p>
              </div>
              <span className="status-chip">{enabledCustomFieldCount}/3 enabled</span>
            </div>

            <div className="settings-custom-field-list">
              {normalizedCustomFields.map((field) => {
                const nameMissing = field.enabled && field.name.trim().length === 0;

                return (
                  <div
                    key={field.slot}
                    className={`settings-custom-field-item ${field.enabled ? "is-enabled" : ""} ${nameMissing ? "is-invalid" : ""}`}
                  >
                    <div className="settings-custom-field-item-head">
                      <span className="settings-custom-field-name">Custom Field {field.slot}</span>
                      <label className="settings-custom-field-toggle">
                        <input
                          type="checkbox"
                          checked={field.enabled}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              custom_fields: normalizeCustomFields(prev.custom_fields).map((item) =>
                                item.slot === field.slot ? { ...item, enabled: event.target.checked } : item
                              )
                            }))
                          }
                        />
                        <span className={`settings-custom-field-toggle-label ${field.enabled ? "is-enabled" : "is-disabled"}`}>
                          {field.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </div>
                    <div className="settings-custom-field-form">
                      <label>
                        Field Name
                        <input
                          value={field.name}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              custom_fields: normalizeCustomFields(prev.custom_fields).map((item) =>
                                item.slot === field.slot ? { ...item, name: event.target.value } : item
                              )
                            }))
                          }
                          placeholder={`Custom Field ${field.slot}`}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="button-row settings-save-row">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() =>
                saveMutation.mutate({
                  ...draft,
                  custom_fields: normalizedCustomFields
                })
              }
              disabled={saveMutation.isPending || customFieldIssues.length > 0}
            >
              Save Settings
            </button>
          </div>

          {(settingsQuery.error || saveMutation.error) && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {(settingsQuery.error as Error | undefined)?.message ||
                (saveMutation.error as Error | undefined)?.message}
            </div>
          )}
          {customFieldIssues.length > 0 && (
            <div className="error-banner" role="alert" aria-live="assertive">
              {customFieldIssues.map((issue) => (
                <div key={`${issue.slot}-${issue.message}`}>{issue.message}</div>
              ))}
            </div>
          )}
          {saveMutation.isSuccess && (
            <div className="success-banner" role="status" aria-live="polite">
              Settings updated.
            </div>
          )}
        </div>
      </section>

      <section className="panel settings-page settings-switch-directory">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Switch Directory</h2>
            <p className="panel-subtitle">Maintain switch management IP mappings used by the monitor tooltip and dashboard workflows.</p>
          </div>
          <span className="status-chip">{switchDirectoryQuery.data?.length ?? 0} entries</span>
        </div>

        <div className="settings-panel-body">
          <div className="settings-switch-directory-tabs">
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
          </div>

          {switchDirectoryTab === "manage" ? (
            <>
              {lastSwitchDirectorySave ? (
                <div className="info-banner" role="status" aria-live="polite">
                  Saved {lastSwitchDirectorySave.name} → {lastSwitchDirectorySave.ip_address}.
                </div>
              ) : null}

              <div className="settings-switch-directory-form">
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
                <div className="button-row settings-switch-directory-form-actions">
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

              <div className="table-scroll import-preview-scroll settings-switch-directory-table">
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
                  Errors: {lastSwitchDirectoryImportSummary.errors}
                </div>
              ) : null}

              <div className="inventory-actions settings-switch-directory-import-actions">
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
                      ×
                    </button>
                  </div>
                  <div className="table-scroll import-preview-table import-preview-scroll settings-switch-directory-table">
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
                                <div className="settings-switch-directory-preview-action">
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
                <div className="settings-switch-directory-empty">
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
      </section>
    </div>
  );
}
