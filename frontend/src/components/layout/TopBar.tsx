import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../../api/client";
import type { Settings } from "../../types/api";
import type { AppViewMeta } from "../../types/ui";

type Props = {
  activeView: AppViewMeta;
  onOpenSidebar: () => void;
  showOpenDashboardButton?: boolean;
  onOpenDashboard?: () => void;
};

export function TopBar({ activeView, onOpenSidebar, showOpenDashboardButton, onOpenDashboard }: Props) {
  const queryClient = useQueryClient();
  const isMonitorView = activeView.key === "monitor";

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    enabled: isMonitorView
  });

  const settingsMutation = useMutation({
    mutationFn: (next: Settings) => updateSettings(next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const handleAutoRefreshChange = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const current = settingsQuery.data;
    if (!current || current.auto_refresh_sec === parsed) {
      return;
    }
    settingsMutation.mutate({
      ...current,
      auto_refresh_sec: parsed
    });
  };

  return (
    <header className="topbar" role="banner">
      <div className="topbar-frame">
        <div className="topbar-title-group">
          <button className="mobile-nav-toggle" type="button" onClick={onOpenSidebar} aria-label="Open navigation menu">
            <MenuIcon />
          </button>

          <div>
            <h1 className="topbar-title">{activeView.title}</h1>
            <p className="topbar-subtitle">{activeView.subtitle}</p>
          </div>
        </div>

        {isMonitorView ? (
          <div className="topbar-controls" aria-label="Monitor controls">
            <label className="topbar-control">
              <span className="topbar-control-label">Auto Refresh (s)</span>
              <input
                type="number"
                min={1}
                max={60}
                value={settingsQuery.data?.auto_refresh_sec ?? 10}
                disabled={settingsMutation.isPending}
                onChange={(event) => handleAutoRefreshChange(event.target.value)}
                aria-label="Auto refresh interval in seconds"
              />
            </label>
            {showOpenDashboardButton && onOpenDashboard ? (
              <button className="btn btn-small topbar-dashboard-button" type="button" onClick={onOpenDashboard}>
                Open Dashboard
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
