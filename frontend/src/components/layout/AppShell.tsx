import { useEffect, type ReactNode } from "react";
import type { AppViewKey, AppViewMeta, ThemeMode } from "../../types/ui";
import { SidebarNav } from "./SidebarNav";
import { TopBar } from "./TopBar";

type Props = {
  activeView: AppViewKey;
  views: AppViewMeta[];
  mode: ThemeMode;
  followSystem: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onCloseSidebar: () => void;
  onToggleTheme: () => void;
  onViewChange: (view: AppViewKey) => void;
  children: ReactNode;
};

export function AppShell({
  activeView,
  views,
  mode,
  followSystem,
  sidebarOpen,
  onOpenSidebar,
  onCloseSidebar,
  onToggleTheme,
  onViewChange,
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
    <div className="app-shell-v13">
      <SidebarNav
        activeView={activeView}
        views={views}
        open={sidebarOpen}
        onClose={onCloseSidebar}
        onViewChange={onViewChange}
      />

      {sidebarOpen && <button className="shell-backdrop" onClick={onCloseSidebar} aria-label="Close navigation" />}

      <div className="app-main">
        <TopBar
          activeView={activeMeta}
          mode={mode}
          followSystem={followSystem}
          onToggleTheme={onToggleTheme}
          onOpenSidebar={onOpenSidebar}
        />

        <main className="app-content" id="main-content" tabIndex={-1}>
          <div className="app-content-frame">{children}</div>
        </main>
      </div>
    </div>
  );
}
