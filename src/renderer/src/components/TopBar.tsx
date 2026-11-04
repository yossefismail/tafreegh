import type { JobSummary } from '@shared/types'
import { useApp, useT } from '../store'
import { Icon } from './Icon'
import { ShareMenu } from './ShareMenu'

export function TopBar({ job }: { job: JobSummary | null }): React.JSX.Element {
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const selectJob = useApp((state) => state.selectJob)
  const t = useT()
  const title = view === 'settings' ? t('settingsTitle') : job?.title || t('studio')
  const canShare = Boolean(job && job.status === 'done' && job.files.html)

  return (
    <header className="app-topbar">
      <span className="tech tech--muted">{t('appName')}</span>
      <span className="app-topbar__title" title={title}>
        {title}
      </span>
      <span className="app-topbar__spacer" />
      <div className="app-topbar__actions">
        {canShare && job && <ShareMenu job={job} />}
        {!canShare && view === 'settings' && (
          <button type="button" className="btn btn--ghost" onClick={() => selectJob(null)}>
            <Icon name="arrowRight" size={16} />
            {t('studio')}
          </button>
        )}
        <button
          type="button"
          className={`icon-btn${view === 'settings' ? ' is-active' : ''}`}
          aria-label={t('settings')}
          aria-pressed={view === 'settings'}
          onClick={() => setView(view === 'settings' ? 'studio' : 'settings')}
          style={view === 'settings' ? { background: 'var(--wash-strong)' } : undefined}
        >
          <Icon name="settings" size={19} />
        </button>
      </div>
    </header>
  )
}
