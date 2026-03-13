import type { InventoryBatchMatchField, InventoryBatchMatchMode } from "../types/api";

export type InventoryBatchMatchFieldOption = {
  value: InventoryBatchMatchField;
  label: string;
};

export type InventoryBatchMatchFormState = {
  mode: InventoryBatchMatchMode;
  field: InventoryBatchMatchField;
  regex: string;
  ipListText: string;
};

type Props = {
  value: InventoryBatchMatchFormState;
  onChange: (next: InventoryBatchMatchFormState) => void;
  fieldOptions: InventoryBatchMatchFieldOption[];
  modeOptions?: InventoryBatchMatchMode[];
};

export function InventoryBatchMatchBuilder({
  value,
  onChange,
  fieldOptions,
  modeOptions = ["criteria", "ip_list"]
}: Props) {
  const selectedFieldLabel = fieldOptions.find((option) => option.value === value.field)?.label || "selected field";
  const showModeToggle = modeOptions.length > 1;
  const effectiveMode = showModeToggle ? value.mode : modeOptions[0];

  return (
    <div className="inventory-batch-builder">
      {showModeToggle ? (
        <div className="inventory-batch-mode-row" role="group" aria-label="Batch match mode">
          {modeOptions.includes("criteria") ? (
            <button
              className={`btn btn-small ${value.mode === "criteria" ? "btn-primary" : ""}`}
              type="button"
              onClick={() => onChange({ ...value, mode: "criteria" })}
              aria-pressed={value.mode === "criteria"}
            >
              Regex Match
            </button>
          ) : null}
          {modeOptions.includes("ip_list") ? (
            <button
              className={`btn btn-small ${value.mode === "ip_list" ? "btn-primary" : ""}`}
              type="button"
              onClick={() => onChange({ ...value, mode: "ip_list" })}
              aria-pressed={value.mode === "ip_list"}
            >
              IP List
            </button>
          ) : null}
        </div>
      ) : null}

      {effectiveMode === "criteria" ? (
        <div className="inventory-batch-grid">
          <label>
            Field
            <select
              value={value.field}
              onChange={(event) =>
                onChange({
                  ...value,
                  field: event.target.value as InventoryBatchMatchField
                })
              }
            >
              {fieldOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Regex
            <input
              value={value.regex}
              onChange={(event) =>
                onChange({
                  ...value,
                  regex: event.target.value
                })
              }
              placeholder="-N.{2}$"
              spellCheck={false}
            />
          </label>
          <div className="field-help inventory-batch-help">
            Regex matching is case-insensitive and is evaluated against the full inventory. Example:{" "}
            <code>-N.{"{2}"}$</code> on {selectedFieldLabel} matches hostnames ending in <code>-Nxx</code>.
          </div>
        </div>
      ) : (
        <label>
          IP List
          <textarea
            className="inventory-batch-textarea"
            value={value.ipListText}
            onChange={(event) =>
              onChange({
                ...value,
                ipListText: event.target.value
              })
            }
            placeholder={"10.0.0.10\n10.0.0.11,10.0.0.12"}
            spellCheck={false}
          />
          <span className="field-help inventory-batch-help">
            Paste IPs separated by commas or new lines. Duplicate entries are deduplicated before matching.
          </span>
        </label>
      )}
    </div>
  );
}
