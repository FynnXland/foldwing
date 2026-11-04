import { Logo } from './Logo'
import { Icon } from './Icon'
import { APP_NAME } from '../brand'

type View = 'shares' | 'settings'

interface Props {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  view: View
  onNavigate: (view: View) => void
}

/**
 * Kopfzeile = Titelleiste: Marke, zwei Reiter (Teilen, Einstellungen) und rechts
 * der Hell/Dunkel-Knopf. Sie ist so hoch wie die nativen Fenster-Knöpfe, die
 * Windows oben rechts zeichnet; dort hält das CSS Platz frei.
 */
export function Header({ theme, onToggleTheme, view, onNavigate }: Props): JSX.Element {
  const tab = (target: View, label: string): JSX.Element => (
    <button
      className="nav__item"
      aria-current={view === target ? 'page' : undefined}
      onClick={() => onNavigate(target)}
    >
      {label}
    </button>
  )
  const nextTheme = theme === 'dark' ? 'Helles Design' : 'Dunkles Design'

  return (
    <header className="topbar">
      <div className="brand">
        <Logo size={24} />
        <span>{APP_NAME}</span>
      </div>
      <nav className="nav" aria-label="Ansichten">
        {tab('shares', 'Teilen')}
        {tab('settings', 'Einstellungen')}
      </nav>
      <div className="topbar__end">
        <button className="icon-btn" onClick={onToggleTheme} title={nextTheme} aria-label={nextTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </div>
    </header>
  )
}
