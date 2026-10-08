import { useState } from 'react'
import { saveSetting } from './storage'

export type Theme = 'dark' | 'light'

/*
 * The theme is the data-theme attribute on <html>; src/index.css picks the
 * colors from it. A small script in index.html sets it before the first paint:
 * the saved choice if there is one, otherwise the operating system's setting.
 * Keep the storage key in sync with that script.
 */
export const THEME_STORAGE_KEY = 'pagewalk-theme'

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/** The current theme and a function that switches to the other one and remembers the choice. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    saveSetting(THEME_STORAGE_KEY, next)
    setTheme(next)
  }

  return { theme, toggleTheme }
}
