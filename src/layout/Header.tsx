import { useTheme } from '../theme'

export const APP_NAME = 'Pagewalk'

export function Header() {
  const { theme, toggleTheme } = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface-1 px-4 py-2">
      <Logo />
      <h1 className="text-lg leading-none">{APP_NAME}</h1>
      <p className="truncate text-fg-muted">Watch PostgreSQL run your query, one step at a time.</p>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className="icon-btn"
          onClick={toggleTheme}
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <a className="icon-btn" href="https://github.com/flemm0/sql-execution-visualizer" aria-label="Source on GitHub">
          <GitHubIcon />
        </a>
      </div>
    </header>
  )
}

/** Three linked pages walked in order: an index page, a heap page, a result. Same drawing as public/favicon.svg. */
function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden="true">
      <path d="M4.5 8v4h4M12 15.5v4h4" fill="none" stroke="currentColor" strokeOpacity={0.5} strokeWidth={1.5} />
      <rect x="1" y="1" width="7" height="7" rx="1.75" className="fill-index" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.75" className="fill-heap" />
      <rect x="16" y="16" width="7" height="7" rx="1.75" className="fill-result" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  )
}
