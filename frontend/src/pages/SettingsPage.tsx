import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../api/client";
import type { Settings } from "../types/api";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const [draft, setDraft] = useState<Settings>({
    ping_interval_sec: 1,
    icmp_payload_bytes: 56,
    auto_refresh_sec: 10
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setDraft(settingsQuery.data);
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: Settings) => updateSettings(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] })
  });

  return (
    <div className="settings-layout">
      <section className="panel settings-page">
        <div className="panel-header" style={{ margin: "-1rem -1rem 0" }}>
          <h2 className="panel-title">Probe Policy</h2>
          <p className="panel-subtitle">Configure global probe cadence and packet parameters.</p>
        </div>

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

        <div className="button-row">
          <button className="btn btn-primary" type="button" onClick={() => saveMutation.mutate(draft)}>
            Save Settings
          </button>
        </div>

        {(settingsQuery.error || saveMutation.error) && (
          <div className="error-banner" role="alert" aria-live="assertive">
            {(settingsQuery.error as Error | undefined)?.message ||
              (saveMutation.error as Error | undefined)?.message}
          </div>
        )}
        {saveMutation.isSuccess && (
          <div className="success-banner" role="status" aria-live="polite">
            Settings updated.
          </div>
        )}
      </section>

      <section className="panel settings-page">
        <div className="panel-header" style={{ margin: "-1rem -1rem 0" }}>
          <h2 className="panel-title">Operational Guidance</h2>
          <p className="panel-subtitle">Recommended defaults for stable high-volume monitoring.</p>
        </div>

        <div className="setting-grid">
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
