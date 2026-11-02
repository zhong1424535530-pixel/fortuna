import { t } from '../i18n'
import { ArrowUpRight } from 'lucide-react'
import { awaitingLiveBalances, contractSummary, formatMoney, personalBalance } from '../data/portfolio'
import type { Currency } from '../data/portfolio'
import { HiddenChart, Panel, IssueHint, Unavailable } from './ui'
import '../personal-balance.css'

type Props = { currency: Currency; hidden: boolean; onManage: () => void }
export function PersonalBalance({ currency, hidden, onManage }: Props) {
  const balance = personalBalance()
  return <section className="personal-balance" aria-label={t('总资产减去总负债等于净资产')}>
    <div className="personal-balance-grid">
      <div><span>{t('总资产')}{!hidden && contractSummary.pnlMissingCount > 0 && <IssueHint message={t('部分合约浮动盈亏尚未取得，金额仅含已知部分。')} />}</span><strong className="numeric">{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : balance.grossCents === null ? <Unavailable hidden={hidden} reason={t('缺少有效汇率，暂时无法折算完整金额。')} /> : formatMoney(balance.grossCents, currency, hidden)}</strong></div>
      <div><button type="button" onClick={onManage}>{t('总负债')}<ArrowUpRight size={13} /></button><strong className="numeric debt-value">{balance.liabilitiesCents === null ? <Unavailable hidden={hidden} reason={t('缺少有效汇率，暂时无法折算完整金额。')} /> : formatMoney(balance.liabilitiesCents, currency, hidden)}</strong></div>
      <div><span>{t('净资产')}{!hidden && contractSummary.pnlMissingCount > 0 && <IssueHint message={t('部分合约浮动盈亏尚未取得，净资产仅含已知部分。')} />}</span><strong className={`numeric ${!hidden && balance.netCents !== null && balance.netCents < 0 ? 'negative' : ''}`}>{awaitingLiveBalances() ? <Unavailable hidden={hidden} reason={t('尚未成功读到账户余额，不显示为零。')} /> : balance.netCents === null ? <Unavailable hidden={hidden} reason={t('缺少有效汇率，暂时无法折算完整金额。')} /> : formatMoney(balance.netCents, currency, hidden)}</strong></div>
    </div>

  </section>
}
export function LiabilityDistribution({ currency, hidden, onManage }: Props) {
  const balance = personalBalance()
  const groups = balance.groups.filter(group => group.valueCents > 0)
  return <Panel title={t('负债构成')} className="liability-distribution" action={<button type="button" className="text-action" onClick={onManage}>{t('管理负债')}<ArrowUpRight size={13} /></button>}>
    {hidden ? <HiddenChart className="liability-bars" /> : balance.liabilitiesCents === null ? <div className="liability-empty"><Unavailable reason={t('缺少有效汇率，人民币负债暂未折算。')} /></div> : groups.length ? <div className="liability-bars" role="img" aria-label={t('各类剩余负债金额与占比')}>{groups.map(group => <div key={group.kind} className="liability-bar-row"><div><span>{group.kind}</span><strong className="numeric">{formatMoney(group.valueCents, currency)}<small>{(group.valueCents / balance.liabilitiesCents! * 100).toFixed(1)}%</small></strong></div><div className="liability-track"><span style={{ width: `${group.valueCents / balance.liabilitiesCents! * 100}%` }} /></div></div>)}</div> : <div className="liability-empty"><strong>{balance.activeCount ? '负债金额小于当前计价精度' : '暂无未结清负债'}</strong><button type="button" className="text-action" onClick={onManage}>{t('管理负债')}<ArrowUpRight size={13} /></button></div>}
  </Panel>
}
