export const THEME_KEY = "aliasmode.shell.theme";

export type ThemeChoice = "system" | "light" | "dark";

function validTheme(value: string | null | undefined): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemeChoice(cookieHeader: string, stored: string | null): ThemeChoice {
  const prefix = `${THEME_KEY}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    const value = cookie.slice(prefix.length);
    if (validTheme(value)) return value;
  }
  return validTheme(stored) ? stored : "light";
}

export function themeCookie(choice: ThemeChoice): string {
  return `${THEME_KEY}=${choice}; Path=/; Max-Age=31536000; SameSite=Strict`;
}
