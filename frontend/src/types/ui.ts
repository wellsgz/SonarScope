export type ThemeMode = "light" | "dark";

export type AppViewKey = "monitor" | "inventory" | "groups" | "settings";

export type AppIconKey = "monitor" | "inventory" | "groups" | "settings";

export type AppViewMeta = {
  key: AppViewKey;
  label: string;
  title: string;
  subtitle: string;
  icon: AppIconKey;
};
