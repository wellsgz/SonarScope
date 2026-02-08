import type { AppViewMeta, ThemeMode } from "../../types/ui";
import { ThemeToggle } from "./ThemeToggle";

type Props = {
  activeView: AppViewMeta;
  mode: ThemeMode;
  followSystem: boolean;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
};

export function TopBar({ activeView, mode, followSystem, onToggleTheme, onOpenSidebar }: Props) {
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

        <div className="topbar-actions">
          <span className="status-chip status-chip-live">
            <span className="status-dot status-dot-live" aria-hidden />
            Live Telemetry
          </span>
          <span className="status-chip">Density: Compact</span>
          <span className="status-chip">Theme: {followSystem ? `System (${mode})` : mode}</span>
          <ThemeToggle mode={mode} onToggle={onToggleTheme} />
        </div>
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
