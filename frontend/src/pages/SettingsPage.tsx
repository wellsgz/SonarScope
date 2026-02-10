import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../api/client";
import type { CustomFieldConfig, Settings } from "../types/api";

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
  const [draft, setDraft] = useState<Settings>({
    ping_interval_sec: 1,
    icmp_payload_bytes: 56,
    icmp_timeout_ms: 500,
    auto_refresh_sec: 10,
    custom_fields: normalizeCustomFields()
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setDraft({
        ...settingsQuery.data,
        custom_fields: normalizeCustomFields(settingsQuery.data.custom_fields)
      });
    }
  }, [settingsQuery.data]);

  const customFieldIssues = useMemo(
    () => validateCustomFields(draft.custom_fields),
    [draft.custom_fields]
  );

  const saveMutation = useMutation({
    mutationFn: (payload: Settings) => updateSettings(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] })
  });

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

          <section className="settings-custom-fields">
            <h3 className="panel-title settings-section-title">Custom Fields</h3>
            <p className="panel-subtitle">
              Enable up to three custom endpoint fields. Enabled fields require unique non-overlapping names.
            </p>
            <div className="settings-custom-field-list">
              {normalizeCustomFields(draft.custom_fields).map((field) => (
                <div key={field.slot} className="settings-custom-field-row">
                  <div className="settings-custom-field-meta">
                    <strong>Custom Field {field.slot}</strong>
                    <label className="settings-toggle-row">
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
                      Enabled
                    </label>
                  </div>
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
              ))}
            </div>
          </section>

          <div className="button-row settings-save-row">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() =>
                saveMutation.mutate({
                  ...draft,
                  custom_fields: normalizeCustomFields(draft.custom_fields)
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

      <section className="panel settings-page">
        <div className="panel-header">
          <h2 className="panel-title">Operational Guidance</h2>
          <p className="panel-subtitle">Recommended defaults for stable high-volume monitoring.</p>
        </div>

        <div className="settings-panel-body settings-guidance-stack">
          <div className="info-banner">
            <strong>10,000 endpoints baseline</strong>
            <p>Use intervals above 1s unless infrastructure is sized for sustained high PPS.</p>
          </div>
          <div className="info-banner">
            <strong>Data quality</strong>
            <p>Keep payload size consistent across environments for comparable latency trends.</p>
          </div>
          <div className="info-banner">
            <strong>NOC readiness</strong>
            <p>Pair monitor auto-refresh with websocket updates to reduce blind spots during incidents.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
