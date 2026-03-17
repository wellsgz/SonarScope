import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

type Options = {
  value: number | undefined;
  min: number;
  max: number;
  delayMs?: number;
  isPending?: boolean;
  onCommit: (next: number) => void;
};

type Result = {
  draft: string;
  setDraft: (next: string) => void;
  commitNow: () => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
};

function normalize(raw: string, min: number, max: number): number | null {
  if (raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function useDebouncedNumberInput({
  value,
  min,
  max,
  delayMs = 300,
  isPending = false,
  onCommit
}: Options): Result {
  const currentValue = value ?? min;
  const [draft, setDraft] = useState(() => String(currentValue));
  const timeoutRef = useRef<number | null>(null);

  const clearPendingCommit = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const commitRawValue = useCallback(
    (raw: string, resetOnInvalid: boolean) => {
      clearPendingCommit();
      const normalized = normalize(raw, min, max);
      if (normalized === null) {
        if (resetOnInvalid) {
          setDraft(String(currentValue));
        }
        return;
      }
      if (String(normalized) !== raw) {
        setDraft(String(normalized));
      }
      if (!isPending && normalized !== currentValue) {
        onCommit(normalized);
      }
    },
    [clearPendingCommit, currentValue, isPending, max, min, onCommit]
  );

  useEffect(() => {
    setDraft(String(currentValue));
  }, [currentValue]);

  useEffect(() => {
    clearPendingCommit();
    const normalized = normalize(draft, min, max);
    if (normalized === null || normalized === currentValue || isPending) {
      return;
    }
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      onCommit(normalized);
    }, delayMs);
    return clearPendingCommit;
  }, [clearPendingCommit, currentValue, delayMs, draft, isPending, max, min, onCommit]);

  useEffect(() => clearPendingCommit, [clearPendingCommit]);

  const commitNow = useCallback(() => {
    commitRawValue(draft, true);
  }, [commitRawValue, draft]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitNow();
      }
    },
    [commitNow]
  );

  return {
    draft,
    setDraft,
    commitNow,
    handleKeyDown
  };
}
