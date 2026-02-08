import { useState } from "react";
import { InventoryPage } from "./pages/InventoryPage";
import { MonitorPage } from "./pages/MonitorPage";
import { GroupsPage } from "./pages/GroupsPage";
import { SettingsPage } from "./pages/SettingsPage";

type ViewKey = "monitor" | "inventory" | "groups" | "settings";

export default function App() {
  const [view, setView] = useState<ViewKey>("monitor");

  return (
    <div className="app-shell">
      <header className="top-header">
        <div>
          <h1>SonarScope</h1>
          <p>Endpoint reachability analytics for NOC troubleshooting.</p>
        </div>
        <nav className="nav-row">
          <button className={`nav-button ${view === "monitor" ? "active" : ""}`} onClick={() => setView("monitor")}>
            Monitor
          </button>
          <button
            className={`nav-button ${view === "inventory" ? "active" : ""}`}
            onClick={() => setView("inventory")}
          >
            Inventory
          </button>
          <button className={`nav-button ${view === "groups" ? "active" : ""}`} onClick={() => setView("groups")}>
            Groups
          </button>
          <button
            className={`nav-button ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </nav>
      </header>

      <main className="content-area">
        {view === "monitor" && <MonitorPage />}
        {view === "inventory" && <InventoryPage />}
        {view === "groups" && <GroupsPage />}
        {view === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
