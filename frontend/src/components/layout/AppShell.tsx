import { useEffect, type ReactNode } from "react";
import type { Group, ProbeStatus } from "../../types/api";
import type { AppViewKey, AppViewMeta, ThemeMode } from "../../types/ui";
import { SidebarNav } from "./SidebarNav";
import { TopBar } from "./TopBar";

type Props = {
  activeView: AppViewKey;
  views: AppViewMeta[];
  mode: ThemeMode;
  immersiveMonitorMode: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onCloseSidebar: () => void;
  onToggleTheme: () => void;
  onViewChange: (view: AppViewKey) => void;
  probeStatus: ProbeStatus;
  groups: Group[];
  selectedProbeGroupIDs: number[];
  onProbeGroupSelectionChange: (ids: number[]) => void;
  onStartProbeAll: () => void;
  onStartProbeGroups: () => void;
  onStopProbe: () => void;
  probeBusy: boolean;
  deleteInProgress: boolean;
  children: ReactNode;
};

export function AppShell({
  activeView,
  views,
  mode,
  immersiveMonitorMode,
  sidebarOpen,
  onOpenSidebar,
  onCloseSidebar,
  onToggleTheme,
  onViewChange,
  probeStatus,
  groups,
  selectedProbeGroupIDs,
  onProbeGroupSelectionChange,
  onStartProbeAll,
  onStartProbeGroups,
  onStopProbe,
  probeBusy,
  deleteInProgress,
  children
}: Props) {
  const activeMeta =
    views.find((view) => view.key === activeView) ??
    ({
      key: activeView,
      label: activeView,
      title: activeView,
      subtitle: "",
      icon: activeView
    } as AppViewMeta);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCloseSidebar, sidebarOpen]);

  return (
    <div className={`app-shell-v13 ${immersiveMonitorMode ? "app-shell-immersive" : ""}`}>
      {!immersiveMonitorMode ? (
        <SidebarNav
          activeView={activeView}
          views={views}
          mode={mode}
          open={sidebarOpen}
          onClose={onCloseSidebar}
          onToggleTheme={onToggleTheme}
          onViewChange={onViewChange}
          probeStatus={probeStatus}
          groups={groups}
          selectedProbeGroupIDs={selectedProbeGroupIDs}
          onProbeGroupSelectionChange={onProbeGroupSelectionChange}
          onStartProbeAll={onStartProbeAll}
          onStartProbeGroups={onStartProbeGroups}
          onStopProbe={onStopProbe}
          probeBusy={probeBusy}
          deleteInProgress={deleteInProgress}
        />
      ) : null}

      {!immersiveMonitorMode && sidebarOpen ? (
        <button className="shell-backdrop" onClick={onCloseSidebar} aria-label="Close navigation" />
      ) : null}

      <div className="app-main">
        {!immersiveMonitorMode ? (
          <TopBar
            activeView={activeMeta}
            onOpenSidebar={onOpenSidebar}
          />
        ) : null}

        <main className={`app-content ${immersiveMonitorMode ? "app-content-immersive" : ""}`} id="main-content" tabIndex={-1}>
          <div className="app-content-frame">{children}</div>
        </main>
      </div>
    </div>
  );
}
