import type { AppViewKey, AppViewMeta } from "../../types/ui";

type Props = {
  activeView: AppViewKey;
  views: AppViewMeta[];
  open: boolean;
  onClose: () => void;
  onViewChange: (view: AppViewKey) => void;
};

export function SidebarNav({ activeView, views, open, onClose, onViewChange }: Props) {
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="Primary">
      <div className="sidebar-brand-row">
        <div className="brand-mark" aria-hidden>
          <RadarIcon />
        </div>
        <div>
          <div className="brand-name">SonarScope</div>
          <div className="brand-subtitle">Network Observability</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {views.map((view) => {
          const active = activeView === view.key;
          return (
            <button
              key={view.key}
              className={`sidebar-nav-item ${active ? "sidebar-nav-item-active" : ""}`}
              type="button"
              onClick={() => {
                onViewChange(view.key);
                onClose();
              }}
              aria-current={active ? "page" : undefined}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <NavIcon icon={view.icon} />
              </span>
              <span>{view.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <span className="status-dot status-dot-live" aria-hidden />
        Live NOC Mode
      </div>
    </aside>
  );
}

function NavIcon({ icon }: { icon: AppViewMeta["icon"] }) {
  switch (icon) {
    case "inventory":
      return <InventoryIcon />;
    case "groups":
      return <GroupsIcon />;
    case "settings":
      return <SettingsIcon />;
    case "monitor":
    default:
      return <PulseIcon />;
  }
}

function iconBase(path: string) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d={path} />
    </svg>
  );
}

function RadarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 12 20 8" />
    </svg>
  );
}

function PulseIcon() {
  return iconBase("M3 12h4l2.2-4 4.2 8 2.2-4H21");
}

function InventoryIcon() {
  return iconBase("M4 5h16v5H4zM4 14h16v5H4z");
}

function GroupsIcon() {
  return iconBase("M7 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 19a4.5 4.5 0 0 1 9 0M12.5 19a4.5 4.5 0 0 1 9 0");
}

function SettingsIcon() {
  return iconBase("M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5-1.6-.5a6.9 6.9 0 0 0-.5-1.2l.8-1.5-1.8-1.8-1.5.8c-.4-.2-.8-.4-1.2-.5L12 4l-2 .6c-.4.1-.8.3-1.2.5l-1.5-.8-1.8 1.8.8 1.5c-.2.4-.4.8-.5 1.2L4 12l.6 2c.1.4.3.8.5 1.2l-.8 1.5 1.8 1.8 1.5-.8c.4.2.8.4 1.2.5l2 .6 2-.6c.4-.1.8-.3 1.2-.5l1.5.8 1.8-1.8-.8-1.5c.2-.4.4-.8.5-1.2Z");
}
