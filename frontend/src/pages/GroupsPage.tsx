import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createGroup,
  deleteGroup,
  getSettings,
  listGroups,
  listMonitorEndpoints,
  previewInventoryBatchGroupAssignment,
  updateGroup
} from "../api/client";
import { InventoryBatchMatchBuilder, type InventoryBatchMatchFieldOption, type InventoryBatchMatchFormState } from "../components/InventoryBatchMatchBuilder";
import type {
  CustomFieldConfig,
  InventoryBatchGroupPreviewResponse,
  InventoryBatchMatchField,
  InventoryEndpoint
} from "../types/api";

type GroupUpdateNotice = {
  tone: "info" | "success";
  message: string;
};

type MembershipMode = "manual" | "regex";

type CustomFieldSlot = 1 | 2 | 3;

type EnabledCustomField = {
  slot: CustomFieldSlot;
  name: string;
};

const defaultBatchMatchState: InventoryBatchMatchFormState = {
  mode: "criteria",
  field: "hostname",
  regex: "",
  ipListText: ""
};

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

function normalizeEnabledCustomFields(fields?: CustomFieldConfig[]): EnabledCustomField[] {
  const bySlot: Record<CustomFieldSlot, EnabledCustomField | null> = {
    1: null,
    2: null,
    3: null
  };
  (fields || []).forEach((field) => {
    if (field.slot < 1 || field.slot > 3) {
      return;
    }
    if (!field.enabled || !field.name.trim()) {
      return;
    }
    const slot = field.slot as CustomFieldSlot;
    bySlot[slot] = {
      slot,
      name: field.name.trim()
    };
  });
  return [bySlot[1], bySlot[2], bySlot[3]].filter((field): field is EnabledCustomField => field !== null);
}

function BatchPreviewStatsChips({
  matchedCount,
  submittedCount,
  uniqueCount,
  invalidCount,
  unmatchedCount
}: {
  matchedCount: number;
  submittedCount?: number;
  uniqueCount?: number;
  invalidCount?: number;
  unmatchedCount?: number;
}) {
  return (
    <div className="summary-row inventory-batch-summary-row">
      <span className="status-chip">Matched: {matchedCount}</span>
      {submittedCount !== undefined ? <span className="status-chip">Submitted: {submittedCount}</span> : null}
      {uniqueCount !== undefined ? <span className="status-chip">Unique: {uniqueCount}</span> : null}
      {invalidCount ? <span className="status-chip status-chip-warning">Invalid IPs: {invalidCount}</span> : null}
      {unmatchedCount ? <span className="status-chip">Unmatched: {unmatchedCount}</span> : null}
    </div>
  );
}

function BatchPreviewTable({
  rows,
  emptyMessage
}: {
  rows: InventoryEndpoint[];
  emptyMessage: string;
}) {
  return (
    <div className="table-scroll inventory-batch-preview-table">
      <table className="monitor-table">
        <thead>
          <tr>
            <th>Hostname</th>
            <th>IP Address</th>
            <th>Group</th>
            <th>Switch</th>
            <th>Port</th>
            <th>Updated At</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="inventory-batch-preview-empty">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={`group-batch-preview-${row.endpoint_id}`}>
                <td>{row.hostname || "-"}</td>
                <td>{row.ip_address}</td>
                <td>{row.group.join(", ") || "-"}</td>
                <td>{row.switch || "-"}</td>
                <td>{row.port || "-"}</td>
                <td>{new Date(row.updated_at).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function GroupsPage() {
  const queryClient = useQueryClient();
  const [editingID, setEditingID] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpointIDs, setEndpointIDs] = useState<number[]>([]);
  const [manualIPList, setManualIPList] = useState("");
  const [membershipMode, setMembershipMode] = useState<MembershipMode>("manual");
  const [groupUpdateNotice, setGroupUpdateNotice] = useState<GroupUpdateNotice | null>(null);
  const [batchGroupMatch, setBatchGroupMatch] = useState<InventoryBatchMatchFormState>(defaultBatchMatchState);
  const [batchGroupPreview, setBatchGroupPreview] = useState<InventoryBatchGroupPreviewResponse | null>(null);

  const groupsQuery = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const endpointsQuery = useQuery({
    queryKey: ["group-endpoint-options"],
    queryFn: () => listMonitorEndpoints({})
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings
  });

  async function invalidateGroupRelatedQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["groups"] }),
      queryClient.invalidateQueries({ queryKey: ["inventory-endpoints"] }),
      queryClient.invalidateQueries({ queryKey: ["inventory-filter-options"] }),
      queryClient.invalidateQueries({ queryKey: ["monitor-endpoints-page"] }),
      queryClient.invalidateQueries({ queryKey: ["monitor-endpoints"] }),
      queryClient.invalidateQueries({ queryKey: ["filter-options"] })
    ]);
  }

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
    onSuccess: async (_group, variables) => {
      setEditingID(null);
      setName("");
      setDescription("");
      setEndpointIDs([]);
      setManualIPList("");
      setMembershipMode("manual");
      setGroupUpdateNotice({
        tone: variables.notice ? "info" : "success",
        message: variables.notice || (variables.groupID ? "Group updated." : "Group created.")
      });
      await invalidateGroupRelatedQueries();
    }
  });

  const previewRegexMutation = useMutation({
    mutationFn: (payload: {
      match: { mode: "criteria"; field: InventoryBatchMatchField; regex: string };
      target: { mode: "existing" | "create"; group_id?: number; group_name?: string };
    }) => previewInventoryBatchGroupAssignment(payload),
    onSuccess: (preview) => {
      setBatchGroupPreview(preview);
    }
  });

  const applyRegexMutation = useMutation({
    mutationFn: async (preview: InventoryBatchGroupPreviewResponse) => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error("Group name is required.");
      }

      const matchedEndpointIDs = preview.preview.endpoint_ids;

      if (editingID !== null) {
        const currentGroup = (groupsQuery.data || []).find((group) => group.id === editingID);
        if (!currentGroup) {
          throw new Error("Selected group could not be found.");
        }

        return updateGroup(editingID, {
          name: trimmedName,
          description,
          endpoint_ids: Array.from(new Set([...(currentGroup.endpoint_ids || []), ...matchedEndpointIDs]))
        });
      }

      if (preview.used_existing_by_name && preview.group_id) {
        const existingGroup = (groupsQuery.data || []).find((group) => group.id === preview.group_id);
        if (!existingGroup) {
          throw new Error("Existing group could not be found for the current preview.");
        }

        return updateGroup(existingGroup.id, {
          name: existingGroup.name,
          description: existingGroup.description,
          endpoint_ids: Array.from(new Set([...(existingGroup.endpoint_ids || []), ...matchedEndpointIDs]))
        });
      }

      return createGroup({
        name: trimmedName,
        description,
        endpoint_ids: matchedEndpointIDs
      });
    },
    onSuccess: async (group, preview) => {
      await invalidateGroupRelatedQueries();
      const refreshedGroups = await queryClient.fetchQuery({
        queryKey: ["groups"],
        queryFn: listGroups
      });
      const nextGroup = refreshedGroups.find((item) => item.id === group.id) || group;

      setEditingID(nextGroup.id);
      setName(nextGroup.name);
      setDescription(nextGroup.description);
      setEndpointIDs(nextGroup.endpoint_ids || []);
      setManualIPList("");
      setBatchGroupPreview(null);
      setGroupUpdateNotice({
        tone: "success",
        message: `Moved ${preview.would_assign} endpoint(s) into "${nextGroup.name}".${
          preview.already_in_group > 0 ? ` ${preview.already_in_group} already matched that group.` : ""
        }${preview.used_existing_by_name ? " Existing group reused by name." : ""}`
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteGroup(id),
    onSuccess: async () => {
      await invalidateGroupRelatedQueries();
    }
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

  const enabledCustomFields = useMemo(
    () => normalizeEnabledCustomFields(settingsQuery.data?.custom_fields),
    [settingsQuery.data?.custom_fields]
  );

  const batchMatchFieldOptions = useMemo<InventoryBatchMatchFieldOption[]>(
    () => [
      { value: "hostname", label: "Hostname" },
      { value: "ip_address", label: "IP Address" },
      { value: "mac_address", label: "MAC Address" },
      { value: "vlan", label: "VLAN" },
      { value: "switch", label: "Switch" },
      { value: "port", label: "Port" },
      { value: "port_type", label: "Port Type" },
      { value: "description", label: "Description" },
      ...enabledCustomFields.map((field) => ({
        value: (`custom_field_${field.slot}_value` as InventoryBatchMatchField),
        label: field.name
      }))
    ],
    [enabledCustomFields]
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

  function resetRegexAssignmentState() {
    setBatchGroupPreview(null);
    previewRegexMutation.reset();
    applyRegexMutation.reset();
  }

  function resetEditorToCreate() {
    setEditingID(null);
    setName("");
    setDescription("");
    setEndpointIDs([]);
    setManualIPList("");
    setGroupUpdateNotice(null);
    resetRegexAssignmentState();
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
    resetRegexAssignmentState();
  }

  function updateMembershipMode(nextMode: MembershipMode) {
    setMembershipMode(nextMode);
    setGroupUpdateNotice(null);
    resetRegexAssignmentState();
    if (nextMode === "regex") {
      setBatchGroupMatch((current) => ({ ...current, mode: "criteria" }));
    }
  }

  function updateRegexMatch(next: InventoryBatchMatchFormState) {
    setBatchGroupMatch({ ...next, mode: "criteria" });
    setGroupUpdateNotice(null);
    resetRegexAssignmentState();
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

  function summarizeReassignment(endpointIDsToAssign: number[], targetGroupID: number | null) {
    const impactByGroup = new Map<string, { groupName: string; count: number }>();
    endpointIDsToAssign.forEach((endpointID) => {
      const currentGroup = endpointCurrentGroupByID.get(endpointID);
      if (!currentGroup) {
        return;
      }
      if (targetGroupID !== null && currentGroup.groupID === targetGroupID) {
        return;
      }
      if (isReservedGroupName(currentGroup.groupName)) {
        return;
      }
      const key = `${currentGroup.groupID}:${currentGroup.groupName}`;
      const existing = impactByGroup.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      impactByGroup.set(key, { groupName: currentGroup.groupName, count: 1 });
    });

    const impact = Array.from(impactByGroup.values()).sort((a, b) =>
      a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" })
    );
    return {
      impact,
      count: impact.reduce((total, item) => total + item.count, 0)
    };
  }

  const manualReassignment = summarizeReassignment(saveRequest.endpointIDs, editingID);
  const regexTargetGroupID =
    editingID !== null ? editingID : batchGroupPreview?.used_existing_by_name ? (batchGroupPreview.group_id ?? null) : null;
  const regexReassignment = summarizeReassignment(batchGroupPreview?.preview.endpoint_ids || [], regexTargetGroupID);
  const activeReassignment = membershipMode === "regex" ? regexReassignment : manualReassignment;
  const targetGroupLabel =
    membershipMode === "regex"
      ? batchGroupPreview?.group_name || name.trim() || "the selected group"
      : editingID
        ? (name.trim() || "this group")
        : "the new group";

  const editingGroup = editingID ? (groupsQuery.data || []).find((group) => group.id === editingID) : null;
  const reservedGroupName = isReservedGroupName(name);
  const regexTargetInvalid = !name.trim() || reservedGroupName || Boolean(editingGroup?.is_system);
  const regexMatchInvalid = !batchGroupMatch.regex.trim();

  useEffect(() => {
    const availableFields = new Set(batchMatchFieldOptions.map((option) => option.value));
    if (!availableFields.has(batchGroupMatch.field)) {
      setBatchGroupMatch((current) => ({ ...current, field: "hostname", mode: "criteria" }));
      resetRegexAssignmentState();
    }
  }, [batchGroupMatch.field, batchMatchFieldOptions]);

  const handlePreviewRegexAssignment = () => {
    if (regexMatchInvalid || regexTargetInvalid) {
      return;
    }
    previewRegexMutation.mutate({
      match: {
        mode: "criteria",
        field: batchGroupMatch.field,
        regex: batchGroupMatch.regex.trim()
      },
      target:
        editingID !== null
          ? { mode: "existing", group_id: editingID }
          : { mode: "create", group_name: name.trim() }
    });
  };

  return (
    <div className="groups-layout">
      <section className="panel groups-panel">
        <div className="panel-header">
          <h2 className="panel-title">Group Editor</h2>
          <p className="panel-subtitle">Create or update endpoint groups for selective probing workflows.</p>
        </div>

        <div className="groups-panel-body">
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
                  if (editingID === null) {
                    resetRegexAssignmentState();
                  }
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

            <div className="group-membership-mode">
              <span className="group-membership-mode-label">Membership Input</span>
              <div className="inventory-batch-mode-row" role="group" aria-label="Group membership input mode">
                <button
                  className={`btn btn-small ${membershipMode === "manual" ? "btn-primary" : ""}`}
                  type="button"
                  onClick={() => updateMembershipMode("manual")}
                  aria-pressed={membershipMode === "manual"}
                >
                  Manual IP List
                </button>
                <button
                  className={`btn btn-small ${membershipMode === "regex" ? "btn-primary" : ""}`}
                  type="button"
                  onClick={() => updateMembershipMode("regex")}
                  aria-pressed={membershipMode === "regex"}
                >
                  Regex Match
                </button>
              </div>
              <span className="field-help">
                Manual IP List keeps the current editor workflow. Regex Match previews the full inventory and moves the
                matches into this group.
              </span>
            </div>

            {membershipMode === "manual" ? (
              <>
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
              </>
            ) : (
              <>
                <InventoryBatchMatchBuilder
                  value={{ ...batchGroupMatch, mode: "criteria" }}
                  onChange={updateRegexMatch}
                  fieldOptions={batchMatchFieldOptions}
                  modeOptions={["criteria"]}
                />
                <div className="field-help">
                  Regex matching is evaluated against the full inventory, not the current Inventory page filters. Matching
                  endpoints already in this group stay where they are; the rest will be moved into it.
                </div>
                {previewRegexMutation.error ? (
                  <div className="error-banner" role="alert" aria-live="assertive">
                    {(previewRegexMutation.error as Error).message}
                  </div>
                ) : null}
                {applyRegexMutation.error ? (
                  <div className="error-banner" role="alert" aria-live="assertive">
                    {(applyRegexMutation.error as Error).message}
                  </div>
                ) : null}
                {batchGroupPreview?.used_existing_by_name ? (
                  <div className="info-banner" role="status" aria-live="polite">
                    Group "{batchGroupPreview.group_name}" already exists; matched endpoints will be moved into that
                    existing group.
                  </div>
                ) : null}
                {batchGroupPreview ? (
                  <div className="inventory-batch-preview-card">
                    <BatchPreviewStatsChips
                      matchedCount={batchGroupPreview.preview.stats.matched_count}
                      submittedCount={batchGroupPreview.preview.stats.submitted_count}
                      uniqueCount={batchGroupPreview.preview.stats.unique_count}
                      invalidCount={batchGroupPreview.preview.stats.invalid_count}
                      unmatchedCount={batchGroupPreview.preview.stats.unmatched_count}
                    />
                    <div className="summary-row inventory-batch-summary-row">
                      <span className="status-chip">Already in target: {batchGroupPreview.already_in_group}</span>
                      <span className="status-chip">Will assign: {batchGroupPreview.would_assign}</span>
                      <span className="status-chip">Target: {batchGroupPreview.group_name}</span>
                    </div>
                    {batchGroupPreview.preview.stats.unmatched_sample?.length ? (
                      <div className="field-help">
                        Unmatched sample: {batchGroupPreview.preview.stats.unmatched_sample.join(", ")}
                      </div>
                    ) : null}
                    <BatchPreviewTable
                      rows={batchGroupPreview.preview.sample}
                      emptyMessage="No endpoints matched the current regex assignment preview."
                    />
                  </div>
                ) : null}
              </>
            )}

            {activeReassignment.count > 0 && (
              <div className="info-banner group-impact-warning" role="status" aria-live="polite">
                Warning: {activeReassignment.count} selected endpoint{activeReassignment.count === 1 ? "" : "s"} currently
                belong{activeReassignment.count === 1 ? "s" : ""} to other groups and will be moved to "{targetGroupLabel}
                ". Each endpoint can belong to only one group. Affected groups:{" "}
                {activeReassignment.impact.map((item) => `${item.groupName} (${item.count})`).join(", ")}.
              </div>
            )}

            {groupUpdateNotice ? (
              <div
                className={groupUpdateNotice.tone === "success" ? "success-banner" : "info-banner"}
                role="status"
                aria-live="polite"
              >
                {groupUpdateNotice.message}
              </div>
            ) : null}
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
              {membershipMode === "manual" ? (
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
              ) : (
                <>
                  <button
                    className="btn"
                    type="button"
                    onClick={handlePreviewRegexAssignment}
                    disabled={regexMatchInvalid || regexTargetInvalid || previewRegexMutation.isPending}
                  >
                    {previewRegexMutation.isPending ? "Previewing..." : "Preview Matches"}
                  </button>
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => {
                      if (!batchGroupPreview) {
                        return;
                      }
                      applyRegexMutation.mutate(batchGroupPreview);
                    }}
                    disabled={
                      !batchGroupPreview ||
                      batchGroupPreview.preview.endpoint_ids.length === 0 ||
                      regexTargetInvalid ||
                      applyRegexMutation.isPending
                    }
                  >
                    {applyRegexMutation.isPending ? "Applying..." : "Apply Regex Assignment"}
                  </button>
                </>
              )}
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
        </div>
      </section>

      <section className="panel groups-panel">
        <div className="panel-header">
          <h2 className="panel-title">Group List</h2>
          <p className="panel-subtitle">Manage existing groups and membership counts.</p>
        </div>

        <div className="groups-panel-body">
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
                <p className="state-loading-copy">Loading groups…</p>
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
        </div>
      </section>
    </div>
  );
}
