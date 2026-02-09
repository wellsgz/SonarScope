import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createGroup, deleteGroup, listGroups, listMonitorEndpoints, updateGroup } from "../api/client";

function parseManualIPList(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[,\n\r\t ]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

function isReservedGroupName(value: string): boolean {
  return value.trim().toLowerCase() === "no group";
}

export function GroupsPage() {
  const queryClient = useQueryClient();
  const [editingID, setEditingID] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpointIDs, setEndpointIDs] = useState<number[]>([]);
  const [manualIPList, setManualIPList] = useState("");
  const [groupUpdateNotice, setGroupUpdateNotice] = useState<string | null>(null);

  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const endpointsQuery = useQuery({
    queryKey: ["group-endpoint-options"],
    queryFn: () => listMonitorEndpoints({})
  });

  const saveMutation = useMutation({
    mutationFn: (payload: {
      groupID: number | null;
      name: string;
      description: string;
      endpointIDs: number[];
      notice: string | null;
    }) => {
      const body = {
        name: payload.name,
        description: payload.description,
        endpoint_ids: payload.endpointIDs
      };
      if (payload.groupID) {
        return updateGroup(payload.groupID, body);
      }
      return createGroup(body);
    },
    onSuccess: (_group, variables) => {
      setEditingID(null);
      setName("");
      setDescription("");
      setEndpointIDs([]);
      setManualIPList("");
      setGroupUpdateNotice(variables.notice);
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
        ip: endpoint.ip_address,
        label: `${endpoint.ip_address} (${endpoint.switch}/${endpoint.port})`
      })),
    [endpointsQuery.data]
  );

  const endpointIDByIP = useMemo(() => {
    const map = new Map<string, number>();
    endpointOptions.forEach((option) => map.set(option.ip, option.id));
    return map;
  }, [endpointOptions]);

  const endpointIPByID = useMemo(() => {
    const map = new Map<number, string>();
    endpointOptions.forEach((option) => map.set(option.id, option.ip));
    return map;
  }, [endpointOptions]);

  const manualIPs = useMemo(() => parseManualIPList(manualIPList), [manualIPList]);

  const resolveSaveRequest = () => {
    const groupID = editingID;
    let resolvedEndpointIDs = endpointIDs;
    const noticeParts: string[] = [];

    if (manualIPs.length > 0) {
      const unknownIPs: string[] = [];
      const resolved: number[] = [];
      manualIPs.forEach((ip) => {
        const endpointID = endpointIDByIP.get(ip);
        if (endpointID === undefined) {
          unknownIPs.push(ip);
          return;
        }
        resolved.push(endpointID);
      });

      resolvedEndpointIDs = resolved;

      if (unknownIPs.length > 0) {
        noticeParts.push(`Unknown IPs ignored: ${unknownIPs.join(", ")}`);
      }

      if (groupID !== null) {
        const currentGroup = (groupsQuery.data || []).find((group) => group.id === groupID);
        const currentEndpointIDs = currentGroup?.endpoint_ids || [];
        const nextEndpointSet = new Set(resolvedEndpointIDs);
        const removedEndpointIDs = currentEndpointIDs.filter((id) => !nextEndpointSet.has(id));
        if (removedEndpointIDs.length > 0) {
          const removedMembers = removedEndpointIDs.map((id) => endpointIPByID.get(id) || `endpoint_id:${id}`);
          noticeParts.push(`Removed from group (not in provided IP list): ${removedMembers.join(", ")}`);
        }
      }
    }

    return {
      groupID,
      name: name.trim(),
      description,
      endpointIDs: resolvedEndpointIDs,
      notice: noticeParts.length > 0 ? noticeParts.join(" | ") : null
    };
  };

  const editingGroup = editingID ? (groupsQuery.data || []).find((group) => group.id === editingID) : null;
  const reservedGroupName = isReservedGroupName(name);

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
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setGroupUpdateNotice(null);
              }}
              placeholder="DB Core"
            />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setGroupUpdateNotice(null);
              }}
              placeholder="Critical database nodes"
            />
          </label>
          <label>
            Endpoint IP List (Manual Update)
            <textarea
              rows={3}
              value={manualIPList}
              onChange={(event) => {
                setManualIPList(event.target.value);
                setGroupUpdateNotice(null);
              }}
              placeholder="10.0.0.1,10.0.0.2 or newline separated"
            />
            <span className="field-help">
              If provided, this list overrides endpoint multi-select for create/update.
            </span>
          </label>
          <label>
            Endpoints
            <select
              multiple
              value={endpointIDs.map(String)}
              disabled={manualIPs.length > 0}
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
            <span className="field-help">
              {manualIPs.length > 0
                ? "Manual IP list override is active."
                : "Hold Ctrl/Cmd to multi-select endpoints."}
            </span>
          </label>

          {groupUpdateNotice && (
            <div className="info-banner" role="status" aria-live="polite">
              {groupUpdateNotice}
            </div>
          )}
          {reservedGroupName && (
            <div className="error-banner" role="alert" aria-live="assertive">
              Group name "no group" is reserved for system assignment and cannot be created or edited.
            </div>
          )}
          {editingGroup?.is_system && (
            <div className="info-banner" role="status" aria-live="polite">
              System group settings are read-only.
            </div>
          )}

          <div className="button-row">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                const payload = resolveSaveRequest();
                saveMutation.mutate(payload);
              }}
              disabled={!name.trim() || reservedGroupName || Boolean(editingGroup?.is_system)}
            >
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
                  setManualIPList("");
                  setGroupUpdateNotice(null);
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
                        {group.is_system ? (
                          <span className="status-chip">System</span>
                        ) : (
                          <>
                            <button
                              className="btn"
                              type="button"
                              onClick={() => {
                                setEditingID(group.id);
                                setName(group.name);
                                setDescription(group.description);
                                setEndpointIDs(group.endpoint_ids || []);
                                setManualIPList("");
                                setGroupUpdateNotice(null);
                              }}
                            >
                              Edit
                            </button>
                            <button className="btn btn-danger" type="button" onClick={() => deleteMutation.mutate(group.id)}>
                              Delete
                            </button>
                          </>
                        )}
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
