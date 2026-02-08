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
    <div className="panel settings-page">
      <h2>Settings</h2>
      <p>Global probe and dashboard refresh configuration.</p>

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
        </label>
      </div>

      <div className="button-row">
        <button className="btn btn-primary" onClick={() => saveMutation.mutate(draft)}>
          Save Settings
        </button>
      </div>

      {(settingsQuery.error || saveMutation.error) && (
        <div className="error-banner">
          {(settingsQuery.error as Error | undefined)?.message ||
            (saveMutation.error as Error | undefined)?.message}
        </div>
      )}
      {saveMutation.isSuccess && <div className="success-banner">Settings updated.</div>}
    </div>
  );
}
