import { currentLang, t } from '../i18n'
import { returnRangeLabel } from '../data/return-range'
import type { ReturnRange } from '../data/return-range'
import type { Currency } from '../data/portfolio'
import { SignedAmount, Unavailable } from './ui'

export function seriesChange(points: readonly { valueCents: number }[]) {
  const first = points[0]?.valueCents
  const last = points.at(-1)?.valueCents
  if (first === undefined || last === undefined) return { change: null, percentage: null }
  const change = last - first
  return { change, percentage: first > 0 ? change / first * 100 : null }
}

export function PeriodChange({ range, points, currency, hidden }: { range: ReturnRange; points: readonly { valueCents: number }[]; currency: Currency; hidden: boolean }) {
  const { change, percentage } = seriesChange(points)
  const percent = hidden || percentage === null ? '—' : `${percentage > 0 ? '+' : ''}${percentage.toFixed(2)}%`
  const tone = percentage === null || percentage === 0 ? '' : percentage < 0 ? ' negative' : ' positive'
  return <span className="period-change"><span>{returnRangeLabel(range)}{currentLang() === 'en' ? ' ' : ''}{t('变化')}</span>{change === null ? <strong className="numeric muted"><Unavailable hidden={hidden} reason={t('缺少可对比的期初或期末估值记录。')} /></strong> : <SignedAmount value={change} currency={currency} hidden={hidden} />}<span className={`change-pill${tone}`}>{percent}</span></span>
}
