import { useEffect, useMemo, useState } from "react";

const COLUMN_VISIBILITY_KEY = "sonarscope.monitor.column_visibility";
const COLUMN_ORDER_KEY = "sonarscope.monitor.column_order";
const MIN_VISIBLE_COLUMNS = 3;

function safeParseVisibility(raw: string | null): Record<string, boolean> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean")
    );
  } catch {
    return {};
  }
}

function safeParseOrder(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown[];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  values.forEach((value) => {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    out.push(value);
  });
  return out;
}

function visibleColumnCount(allColumnKeys: string[], visibility: Record<string, boolean>): number {
  return allColumnKeys.reduce((count, key) => count + (visibility[key] !== false ? 1 : 0), 0);
}

function reconcileVisibility(allColumnKeys: string[], visibility: Record<string, boolean>): Record<string, boolean> {
  const keySet = new Set(allColumnKeys);
  const next = Object.fromEntries(Object.entries(visibility).filter(([key, value]) => keySet.has(key) && value === false));

  if (visibleColumnCount(allColumnKeys, next) >= Math.min(MIN_VISIBLE_COLUMNS, allColumnKeys.length)) {
    return next;
  }

  for (const key of allColumnKeys) {
    if (next[key] !== false) {
      continue;
    }
    delete next[key];
    if (visibleColumnCount(allColumnKeys, next) >= Math.min(MIN_VISIBLE_COLUMNS, allColumnKeys.length)) {
      break;
    }
  }

  return next;
}

function reconcileOrder(allColumnKeys: string[], order: string[]): string[] {
  const keySet = new Set(allColumnKeys);
  const next = dedupeStrings(order).filter((key) => keySet.has(key));
  allColumnKeys.forEach((key) => {
    if (!next.includes(key)) {
      next.push(key);
    }
  });
  return next;
}

export function useColumnPreferences(allColumnKeys: string[]) {
  const allColumnKeySignature = useMemo(() => allColumnKeys.join("|"), [allColumnKeys]);
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") {
      return {};
    }
    return reconcileVisibility(allColumnKeys, safeParseVisibility(window.localStorage.getItem(COLUMN_VISIBILITY_KEY)));
  });
  const [order, setOrder] = useState<string[]>(() => {
    if (typeof window === "undefined") {
      return allColumnKeys;
    }
    return reconcileOrder(allColumnKeys, safeParseOrder(window.localStorage.getItem(COLUMN_ORDER_KEY)));
  });

  useEffect(() => {
    setVisibility((current) => reconcileVisibility(allColumnKeys, current));
    setOrder((current) => reconcileOrder(allColumnKeys, current));
  }, [allColumnKeySignature, allColumnKeys]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(visibility));
  }, [visibility]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(order));
  }, [order]);

  const isColumnVisible = (key: string) => visibility[key] !== false;

  const toggleColumnVisibility = (key: string) => {
    setVisibility((current) => {
      const next = { ...current };
      const isVisible = next[key] !== false;
      const minimumVisible = Math.min(MIN_VISIBLE_COLUMNS, allColumnKeys.length);
      if (isVisible && visibleColumnCount(allColumnKeys, next) <= minimumVisible) {
        return current;
      }
      if (isVisible) {
        next[key] = false;
      } else {
        delete next[key];
      }
      return reconcileVisibility(allColumnKeys, next);
    });
  };

  const setColumnOrder = (nextOrder: string[]) => {
    setOrder(reconcileOrder(allColumnKeys, nextOrder));
  };

  const resetToDefaults = () => {
    setVisibility({});
    setOrder(allColumnKeys);
  };

  return {
    visibility,
    order,
    isColumnVisible,
    toggleColumnVisibility,
    setColumnOrder,
    resetToDefaults
  };
}
