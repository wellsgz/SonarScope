import { useMemo, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { useTheme } from "./hooks/useTheme";
import { GroupsPage } from "./pages/GroupsPage";
import { InventoryPage } from "./pages/InventoryPage";
import { MonitorPage } from "./pages/MonitorPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AppViewKey, AppViewMeta } from "./types/ui";

const viewMeta: AppViewMeta[] = [
  {
    key: "monitor",
    label: "Monitor",
    title: "Operations Monitor",
    subtitle: "Real-time endpoint reachability and latency analytics.",
    icon: "monitor"
  },
  {
    key: "inventory",
    label: "Inventory",
    title: "Endpoint Inventory",
    subtitle: "Import, filter, and maintain monitored infrastructure targets.",
    icon: "inventory"
  },
  {
    key: "groups",
    label: "Groups",
    title: "Group Management",
    subtitle: "Organize endpoints for targeted monitoring and control.",
    icon: "groups"
  },
  {
    key: "settings",
    label: "Settings",
    title: "Platform Settings",
    subtitle: "Global probe and refresh behavior for SonarScope.",
    icon: "settings"
  }
];

export default function App() {
  const [view, setView] = useState<AppViewKey>("monitor");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { mode, followSystem, toggleMode } = useTheme();

  const page = useMemo(() => {
    if (view === "inventory") return <InventoryPage />;
    if (view === "groups") return <GroupsPage />;
    if (view === "settings") return <SettingsPage />;
    return <MonitorPage />;
  }, [view]);

  return (
    <AppShell
      activeView={view}
      views={viewMeta}
      mode={mode}
      followSystem={followSystem}
      sidebarOpen={sidebarOpen}
      onOpenSidebar={() => setSidebarOpen(true)}
      onCloseSidebar={() => setSidebarOpen(false)}
      onToggleTheme={toggleMode}
      onViewChange={setView}
    >
      {page}
    </AppShell>
  );
}
