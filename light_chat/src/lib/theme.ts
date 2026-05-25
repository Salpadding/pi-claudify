export interface ThemeDef {
  id: string;
  name: string;
}

export const themes: ThemeDef[] = [
  { id: "night", name: "Dusk" },
  { id: "dawn", name: "Dawn" },
  { id: "midnight", name: "Midnight" },
  { id: "clean", name: "Clean" },
  { id: "terracotta", name: "Terracotta" },
  { id: "sage", name: "Sage" },
];

const STORAGE_KEY = "pi-claudify-chat-theme";

export function getCurrentTheme(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && themes.some((t) => t.id === saved)) return saved;
  const tauTheme = localStorage.getItem("tau-theme");
  if (tauTheme && themes.some((t) => t.id === tauTheme)) return tauTheme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "terracotta" : "night";
}

export function applyTheme(themeId: string): void {
  if (!themes.some((t) => t.id === themeId)) themeId = "night";
  document.documentElement.setAttribute("data-theme", themeId);
  localStorage.setItem(STORAGE_KEY, themeId);
}

export function watchOsTheme(): void {
  if (!localStorage.getItem(STORAGE_KEY)) {
    window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) applyTheme(e.matches ? "terracotta" : "night");
    });
  }
}
