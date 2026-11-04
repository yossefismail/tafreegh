import { useEffect, useRef, useState } from 'react'
import type { ExportKind, JobSummary } from '@shared/types'
import { Icon } from './Icon'
import { useApp, useT } from '../store'

const ITEMS: Array<{
  kind: ExportKind
  icon: 'download' | 'file' | 'external'
  titleKey: 'downloadAudio' | 'downloadTxt' | 'downloadHtml'
  hintKey: 'downloadAudioHint' | 'downloadTxtHint' | 'downloadHtmlHint'
}> = [
  { kind: 'audio', icon: 'download', titleKey: 'downloadAudio', hintKey: 'downloadAudioHint' },
  { kind: 'txt', icon: 'file', titleKey: 'downloadTxt', hintKey: 'downloadTxtHint' },
  { kind: 'html', icon: 'external', titleKey: 'downloadHtml', hintKey: 'downloadHtmlHint' }
]

export function ShareMenu({ job }: { job: JobSummary }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportKind | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  const toast = useApp((state) => state.toast)

  useEffect(() => {
    if (!open) return
    firstRef.current?.focus()
    const onDoc = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const save = async (kind: ExportKind): Promise<void> => {
    setBusy(kind)
    try {
      const result = await window.tafreegh.jobs.export(job.id, kind)
      if (result.ok) {
        toast(t('downloaded'), 'success')
        setOpen(false)
      } else if (!result.canceled) {
        toast(result.error ?? t('exportFailed'), 'error')
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const reveal = async (): Promise<void> => {
    try {
      await window.tafreegh.jobs.reveal(job.id)
      setOpen(false)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  return (
    <div className="share-wrap" ref={wrapRef}>
      <button
        type="button"
        className="btn btn--primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="share" size={17} />
        {t('share')}
      </button>
      {open && (
        <div className="share-menu" role="menu" aria-label={t('share')}>
          <div className="share-menu__head">
            <span className="tech tech--muted">{t('exportFiles')}</span>
            <span className="tech tech--accent">{t('ready')}</span>
          </div>
          {ITEMS.map((item, index) => (
            <button
              key={item.kind}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              role="menuitem"
              className="share-item"
              disabled={busy !== null}
              onClick={() => void save(item.kind)}
            >
              <span className="dropzone__file-icon" style={{ width: 30, height: 30, borderWidth: 1 }}>
                <Icon name={item.icon} size={16} />
              </span>
              <span>
                <span className="share-item__title">{t(item.titleKey)}</span>
                <span className="share-item__hint">{t(item.hintKey)}</span>
              </span>
              <span className="mono muted" aria-hidden="true">
                {busy === item.kind ? '…' : '↓'}
              </span>
            </button>
          ))}
          <div className="share-menu__foot">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void reveal()}>
              <Icon name="folder" size={15} />
              {t('reveal')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                void window.tafreegh.jobs.openOutput(job.id)
                setOpen(false)
              }}
            >
              <Icon name="external" size={15} />
              {t('openInBrowser')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
