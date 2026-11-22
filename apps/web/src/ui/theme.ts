import { createSignal } from "solid-js";

export type ThemeSetting = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";

const storageKey = "ballast.theme";

export const readThemeSetting = (): ThemeSetting => {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

const systemScheme = (): ColorScheme => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const resolveTheme = (setting: ThemeSetting): ColorScheme =>
  setting === "system" ? systemScheme() : setting;

export const applyTheme = (setting: ThemeSetting): ColorScheme => {
  const scheme = resolveTheme(setting);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.colorScheme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }
  try {
    window.localStorage.setItem(storageKey, setting);
  } catch {
    // Storage may be disabled; the in-memory setting still works.
  }
  return scheme;
};

const [setting, setSettingSignal] = createSignal<ThemeSetting>(readThemeSetting());
const [scheme, setScheme] = createSignal<ColorScheme>(resolveTheme(setting()));

export const themeSetting = setting;
export const colorScheme = scheme;

export const setThemeSetting = (next: ThemeSetting): void => {
  setSettingSignal(next);
  setScheme(applyTheme(next));
};

export const initialiseTheme = (): void => {
  setScheme(applyTheme(setting()));
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (setting() === "system") setScheme(applyTheme("system"));
    });
  }
};
