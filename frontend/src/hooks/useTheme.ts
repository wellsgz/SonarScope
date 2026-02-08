import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThemeMode } from "../types/ui";

const THEME_STORAGE_KEY = "sonarscope.theme";

function getSystemTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredTheme(): ThemeMode | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (value === "light" || value === "dark") {
    return value;
  }
  return null;
}

export function useTheme() {
  const initialStoredTheme = useMemo(readStoredTheme, []);
  const [mode, setModeState] = useState<ThemeMode>(initialStoredTheme ?? getSystemTheme());
  const [followSystem, setFollowSystem] = useState(initialStoredTheme === null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", mode);
  }, [mode]);

  useEffect(() => {
    if (!followSystem || typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setModeState(event.matches ? "dark" : "light");
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [followSystem]);

  const setMode = useCallback((next: ThemeMode) => {
    setFollowSystem(false);
    setModeState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  return {
    mode,
    followSystem,
    toggleMode,
    setMode
  };
}
