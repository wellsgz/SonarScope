import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createGroup, deleteGroup, listGroups, listMonitorEndpoints, updateGroup } from "../api/client";

export function GroupsPage() {
  const queryClient = useQueryClient();
  const [editingID, setEditingID] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpointIDs, setEndpointIDs] = useState<number[]>([]);

  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const endpointsQuery = useQuery({
    queryKey: ["group-endpoint-options"],
    queryFn: () => listMonitorEndpoints({})
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = { name, description, endpoint_ids: endpointIDs };
      if (editingID) {
        return updateGroup(editingID, payload);
      }
      return createGroup(payload);
    },
    onSuccess: () => {
      setEditingID(null);
      setName("");
      setDescription("");
      setEndpointIDs([]);
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteGroup(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups"] })
  });

  const endpointOptions = useMemo(
    () =>
      (endpointsQuery.data || []).map((endpoint) => ({
        id: endpoint.endpoint_id,
        label: `${endpoint.ip_address} (${endpoint.switch}/${endpoint.port})`
      })),
    [endpointsQuery.data]
  );

  return (
    <div className="groups-layout">
      <section className="panel">
        <div className="panel-header" style={{ margin: "-1rem -1rem 0" }}>
          <h2 className="panel-title">Group Editor</h2>
          <p className="panel-subtitle">Create or update endpoint groups for selective probing workflows.</p>
        </div>

        <div className="group-form">
          <label>
            Group Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="DB Core" />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Critical database nodes"
            />
          </label>
          <label>
            Endpoints
            <select
              multiple
              value={endpointIDs.map(String)}
              onChange={(event) =>
                setEndpointIDs(Array.from(event.target.selectedOptions).map((option) => Number(option.value)))
              }
            >
              {endpointOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="field-help">Hold Ctrl/Cmd to multi-select endpoints.</span>
          </label>

          <div className="button-row">
            <button className="btn btn-primary" type="button" onClick={() => saveMutation.mutate()} disabled={!name.trim()}>
              {editingID ? "Update Group" : "Create Group"}
            </button>
            {editingID && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setEditingID(null);
                  setName("");
                  setDescription("");
                  setEndpointIDs([]);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header" style={{ margin: "-1rem -1rem 0" }}>
          <h2 className="panel-title">Group List</h2>
          <p className="panel-subtitle">Manage existing groups and membership counts.</p>
        </div>

        {(groupsQuery.error || saveMutation.error || deleteMutation.error) && (
          <div className="error-banner" role="alert" aria-live="assertive">
            {(groupsQuery.error as Error | undefined)?.message ||
              (saveMutation.error as Error | undefined)?.message ||
              (deleteMutation.error as Error | undefined)?.message}
          </div>
        )}

        {groupsQuery.isLoading ? (
          <div className="state-panel">
            <div>
              <span className="skeleton-bar" style={{ width: 180 }} />
              <p style={{ marginTop: 10 }}>Loading groups…</p>
            </div>
          </div>
        ) : (groupsQuery.data || []).length === 0 ? (
          <div className="state-panel">No groups defined yet. Create your first group from the editor.</div>
        ) : (
          <div className="table-scroll">
            <table className="monitor-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Members</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(groupsQuery.data || []).map((group) => (
                  <tr key={group.id} className={editingID === group.id ? "row-selected" : ""}>
                    <td>{group.name}</td>
                    <td>{group.description || "-"}</td>
                    <td>{group.endpoint_ids?.length || 0}</td>
                    <td>{new Date(group.updated_at).toLocaleString()}</td>
                    <td>
                      <div className="button-row">
                        <button
                          className="btn"
                          type="button"
                          onClick={() => {
                            setEditingID(group.id);
                            setName(group.name);
                            setDescription(group.description);
                            setEndpointIDs(group.endpoint_ids || []);
                          }}
                        >
                          Edit
                        </button>
                        <button className="btn btn-danger" type="button" onClick={() => deleteMutation.mutate(group.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
