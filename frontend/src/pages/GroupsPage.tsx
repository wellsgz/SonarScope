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

  const endpointLabelByID = useMemo(() => {
    const map = new Map<number, string>();
    endpointOptions.forEach((option) => map.set(option.id, option.label));
    return map;
  }, [endpointOptions]);

  const endpointCurrentGroupByID = useMemo(() => {
    const map = new Map<number, { groupID: number; groupName: string }>();
    (groupsQuery.data || []).forEach((group) => {
      (group.endpoint_ids || []).forEach((endpointID) => {
        map.set(endpointID, { groupID: group.id, groupName: group.name });
      });
    });
    return map;
  }, [groupsQuery.data]);

  const manualIPs = useMemo(() => parseManualIPList(manualIPList), [manualIPList]);

  function resetEditorToCreate() {
    setEditingID(null);
    setName("");
    setDescription("");
    setEndpointIDs([]);
    setManualIPList("");
    setGroupUpdateNotice(null);
  }

  function loadGroupIntoEditor(groupID: number) {
    const group = (groupsQuery.data || []).find((item) => item.id === groupID);
    if (!group) {
      return;
    }
    setEditingID(group.id);
    setName(group.name);
    setDescription(group.description);
    setEndpointIDs(group.endpoint_ids || []);
    setManualIPList("");
    setGroupUpdateNotice(null);
  }

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

  const saveRequest = resolveSaveRequest();
  const effectiveEndpointPreviews = saveRequest.endpointIDs
    .map((id) => ({
      id,
      label: endpointLabelByID.get(id) || endpointIPByID.get(id) || `endpoint_id:${id}`
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

  const reassignmentByGroup = new Map<string, { groupName: string; count: number }>();
  saveRequest.endpointIDs.forEach((endpointID) => {
    const currentGroup = endpointCurrentGroupByID.get(endpointID);
    if (!currentGroup) {
      return;
    }
    if (editingID !== null && currentGroup.groupID === editingID) {
      return;
    }
    if (isReservedGroupName(currentGroup.groupName)) {
      return;
    }
    const key = `${currentGroup.groupID}:${currentGroup.groupName}`;
    const existing = reassignmentByGroup.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    reassignmentByGroup.set(key, { groupName: currentGroup.groupName, count: 1 });
  });
  const reassignmentImpact = Array.from(reassignmentByGroup.values()).sort((a, b) =>
    a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" })
  );
  const reassignmentCount = reassignmentImpact.reduce((total, item) => total + item.count, 0);
  const targetGroupLabel = editingID ? (name.trim() || "this group") : "the new group";

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
            Group Selection
            <select
              value={editingID === null ? "__new__" : String(editingID)}
              onChange={(event) => {
                if (event.target.value === "__new__") {
                  resetEditorToCreate();
                  return;
                }
                loadGroupIntoEditor(Number(event.target.value));
              }}
              disabled={groupsQuery.isLoading}
            >
              <option value="__new__">Create New Group</option>
              {(groupsQuery.data || []).map((group) => (
                <option key={group.id} value={String(group.id)}>
                  {group.name}
                </option>
              ))}
            </select>
            <span className="field-help">
              Select an existing group to edit and inspect members, or keep "Create New Group" selected.
            </span>
          </label>

          <div className="group-membership-preview">
            <div className="group-membership-preview-head">
              <span>{editingID ? "Included Endpoints" : "Selected Endpoints"}</span>
              <span className="count-badge">{effectiveEndpointPreviews.length}</span>
            </div>
            {effectiveEndpointPreviews.length > 0 ? (
              <div className="group-membership-preview-list">
                {effectiveEndpointPreviews.map((item) => (
                  <span key={item.id} className="status-chip">
                    {item.label}
                  </span>
                ))}
              </div>
            ) : (
              <span className="field-help">
                {editingID ? "No endpoints currently included in this group." : "No endpoints selected yet."}
              </span>
            )}
          </div>

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

          {reassignmentCount > 0 && (
            <div className="info-banner group-impact-warning" role="status" aria-live="polite">
              Warning: {reassignmentCount} selected endpoint{reassignmentCount === 1 ? "" : "s"} currently belong
              {reassignmentCount === 1 ? "s" : ""} to other groups and will be moved to "{targetGroupLabel}". Each
              endpoint can belong to only one group. Affected groups:{" "}
              {reassignmentImpact.map((item) => `${item.groupName} (${item.count})`).join(", ")}.
            </div>
          )}

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
                saveMutation.mutate(saveRequest);
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
                  resetEditorToCreate();
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
                                loadGroupIntoEditor(group.id);
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
