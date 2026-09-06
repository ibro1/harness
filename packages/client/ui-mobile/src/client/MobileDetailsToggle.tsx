import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** The framework supplies `t` (namespace-scoped); the registration injects the
 *  two details controls. */
export type MobileDetailsToggleProps = PropsLocale<'mobile'> & {
  openDetails(): void
  closeDetails(): void
}

export function MobileDetailsToggle({ openDetails, closeDetails, t }: MobileDetailsToggleProps) {
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    const el = document.querySelector('[data-shell-frame]')
    if (!el) return
    const update = () => {
      setCollapsed(el.hasAttribute('data-details-collapsed'))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ['data-details-collapsed'] })
    return () => { observer.disconnect() }
  }, [])

  const onClickToggle = () => {
    if (collapsed) openDetails()
    else closeDetails()
  }

  return (
    <>
      <div
        data-details-scrim
        onClick={() => { closeDetails() }}
      />
      <button
        type="button"
        data-details-toggle
        aria-label={collapsed ? t('toggle.open') : t('toggle.close')}
        onClick={onClickToggle}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <path d="M1.5 2.5C1.5 1.94772 1.94772 1.5 2.5 1.5H13.5C14.0523 1.5 14.5 1.94772 14.5 2.5V13.5C14.5 14.0523 14.0523 14.5 13.5 14.5H2.5C1.94772 14.5 1.5 14.0523 1.5 13.5V2.5Z" stroke="currentColor" strokeWidth="1.2"/>
          <path d="M10.5 1.5V14.5" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      </button>
    </>
  )
}
