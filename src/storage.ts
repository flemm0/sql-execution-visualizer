/*
 * Small per-browser settings (theme, pane sizes) kept in localStorage.
 * localStorage can throw, for example when the browser blocks site data, so
 * every access is wrapped: a failure just means the setting isn't remembered.
 * The database itself is stored separately, in IndexedDB (see src/db/).
 */

export function readSetting(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Not remembered; the app works the same.
  }
}

/** The same functions in the shape react-resizable-panels expects for saving pane sizes. */
export const settingsStorage = { getItem: readSetting, setItem: saveSetting }
