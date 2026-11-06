import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert } from 'lucide-react'

export function IssueHint({ message, important = false }: { message: string; important?: boolean }) {
  const id = useId()
  const trigger = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const cancelHide = () => clearTimeout(timer.current)
  const hide = () => { cancelHide(); setPosition(null) }
  const show = () => {
    cancelHide()
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(300, window.innerWidth - 24)
    const above = rect.top >= window.innerHeight / 2
    setPosition({ left: Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)), top: above ? rect.top - 8 : rect.bottom + 8, above })
  }
  const hideLater = () => { cancelHide(); timer.current = setTimeout(hide, 120) }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!position || !important) return
    const close = () => setPosition(null)
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close() }
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true) }
  }, [position, important])
  if (!important) return null
  return <>
    <span ref={trigger} className="issue-hint" tabIndex={0} role="button" aria-label={'查看原因：' + message} aria-expanded={!!position} aria-describedby={position ? id : undefined}
      onMouseEnter={show} onMouseLeave={hideLater} onFocus={show} onBlur={hide}
      onClick={event => { event.stopPropagation(); show() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); show() } }}
      onKeyUp={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>
      <CircleAlert size={16} strokeWidth={2} aria-hidden />
    </span>
    {position && createPortal(<span ref={popup} id={id} role="tooltip" className="issue-tooltip" style={{ left: position.left, top: position.top, maxHeight: Math.max(60, position.above ? position.top - 12 : window.innerHeight - position.top - 12), transform: position.above ? 'translateY(-100%)' : undefined }} onMouseEnter={cancelHide} onMouseLeave={hideLater}>{message}</span>, document.body)}
  </>
}

export function Unavailable({ reason, hidden = false }: { reason: string; hidden?: boolean }) {
  return <span className="unavailable-value numeric" title={hidden ? undefined : reason}>{hidden ? '••••••' : '—'}</span>
}
