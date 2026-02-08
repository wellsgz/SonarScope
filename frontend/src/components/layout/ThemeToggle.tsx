import type { ThemeMode } from "../../types/ui";

type Props = {
  mode: ThemeMode;
  onToggle: () => void;
};

export function ThemeToggle({ mode, onToggle }: Props) {
  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} theme`}
    >
      <span className="theme-toggle-icon" aria-hidden>
        {mode === "dark" ? <SunIcon /> : <MoonIcon />}
      </span>
      <span className="theme-toggle-label">{mode === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 1 0 11.5 11.5z" />
    </svg>
  );
}
