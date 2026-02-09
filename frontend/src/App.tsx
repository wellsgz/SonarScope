import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentDeleteJobStatus, getProbeStatus, listGroups, startProbe, stopProbe } from "./api/client";
import { AppShell } from "./components/layout/AppShell";
import { useTheme } from "./hooks/useTheme";
import { GroupsPage } from "./pages/GroupsPage";
import { InventoryPage } from "./pages/InventoryPage";
import { MonitorPage } from "./pages/MonitorPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { InventoryDeleteJobStatus, ProbeStatus } from "./types/api";
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

const defaultProbeStatus: ProbeStatus = {
  running: false,
  scope: "",
  group_ids: []
};

const defaultDeleteJobStatus: InventoryDeleteJobStatus = {
  active: false
};

export default function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<AppViewKey>("monitor");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedProbeGroupIDs, setSelectedProbeGroupIDs] = useState<number[]>([]);
  const { mode, toggleMode } = useTheme();

  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: listGroups
  });

  const probeStatusQuery = useQuery({
    queryKey: ["probe-status"],
    queryFn: getProbeStatus,
    refetchInterval: 4000
  });

  const deleteJobStatusQuery = useQuery({
    queryKey: ["inventory-delete-job-current"],
    queryFn: getCurrentDeleteJobStatus,
    refetchInterval: 1000
  });

  useEffect(() => {
    const groups = groupsQuery.data;
    if (!groups) {
      return;
    }
    const validIDs = new Set(groups.map((group) => group.id));
    setSelectedProbeGroupIDs((current) => current.filter((id) => validIDs.has(id)));
  }, [groupsQuery.data]);

  const startProbeMutation = useMutation({
    mutationFn: (payload: { scope: "all" | "groups"; group_ids?: number[] }) => startProbe(payload),
    onSuccess: (result) => {
      const scope = result.scope === "groups" ? "groups" : "all";
      queryClient.setQueryData<ProbeStatus>(["probe-status"], {
        running: true,
        scope,
        group_ids: result.group_ids || []
      });
      queryClient.invalidateQueries({ queryKey: ["probe-status"] });
    }
  });

  const stopProbeMutation = useMutation({
    mutationFn: stopProbe,
    onSuccess: () => {
      queryClient.setQueryData<ProbeStatus>(["probe-status"], defaultProbeStatus);
      queryClient.invalidateQueries({ queryKey: ["probe-status"] });
    }
  });

  const probeStatus = probeStatusQuery.data ?? defaultProbeStatus;
  const deleteJobStatus = deleteJobStatusQuery.data ?? defaultDeleteJobStatus;
  const deleteInProgress = Boolean(deleteJobStatus.active);
  const probeBusy = startProbeMutation.isPending || stopProbeMutation.isPending;

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
      sidebarOpen={sidebarOpen}
      onOpenSidebar={() => setSidebarOpen(true)}
      onCloseSidebar={() => setSidebarOpen(false)}
      onToggleTheme={toggleMode}
      onViewChange={setView}
      probeStatus={probeStatus}
      groups={groupsQuery.data || []}
      selectedProbeGroupIDs={selectedProbeGroupIDs}
      onProbeGroupSelectionChange={setSelectedProbeGroupIDs}
      onStartProbeAll={() => startProbeMutation.mutate({ scope: "all" })}
      onStartProbeGroups={() => {
        if (!selectedProbeGroupIDs.length) {
          return;
        }
        startProbeMutation.mutate({ scope: "groups", group_ids: selectedProbeGroupIDs });
      }}
      onStopProbe={() => stopProbeMutation.mutate()}
      probeBusy={probeBusy}
      deleteInProgress={deleteInProgress}
    >
      {page}
    </AppShell>
  );
}
