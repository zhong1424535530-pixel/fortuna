import { t } from '../i18n'
import { isReal } from '../data/live'
import { equityPoints } from '../data/equity-history'
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRight, ChevronRight, Layers3 } from 'lucide-react'
import { Avatar, Button, Modal, Panel, SignedAmount, IssueHint, Unavailable } from './ui'
import ReturnRangeFilter from './ReturnRangeFilter'
import { PeriodChange } from './PeriodChange'
import { ContractExposureChart, HistoryChart } from './Charts'
import {
  accounts, accountBalances, contracts, contractSummary, contractValueCents,
  filterContracts, formatMoney, formatPrice, formatQuantity, summarizeContracts,
} from '../data/portfolio'
import type { ContractPosition, Currency } from '../data/portfolio'
import type { ReturnRange } from '../data/return-range'
import { exitOrdersReadState } from '../data/contract-protection'

type MoneyProps = { currency: Currency; hidden: boolean }

function unreadExitOrders(position: ContractPosition) {
  return exitOrdersReadState(position.exitOrders) === 'missing'
}

function cachedExitOrdersMessage(position: ContractPosition) {
  const account = accounts.find(item => item.id === position.accountId)
  if (!account || exitOrdersReadState(position.exitOrders, account.status) !== 'cached') return undefined
  const time = account.updatedAt ? `（${new Date(account.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）` : ''
  return `本次账户尚未更新成功，显示上次成功读取的止盈止损${time}。委托可能已有变化，等待重新读取确认。`
}

function ContractExitPrices({ position, currency, hidden }: MoneyProps & { position: ContractPosition }) {
  const unread = unreadExitOrders(position)
  const cachedMessage = cachedExitOrdersMessage(position)
  // 每档一行，最多显示 2 档，更多的写"另有 N 档"；全部档位见持仓详情。
  const lines = (kind: '止盈' | '止损'): ReactNode[] => {
    if (hidden) return ['••••••']
    if (unread) return ['—']
    const rows = position.exitOrders!.filter(order => kind === '止盈' ? order.kind === '止盈' : order.kind !== '止盈')
    if (!rows.length) return ['—']
    const prices = rows.slice(0, 2).map(order => order.kind === '移动止损' ? '移动止损' : order.triggerPriceUsd === null ? '—' : formatPrice(order.triggerPriceUsd, currency))
    return rows.length > 2 ? [...prices, <small className="contract-exit-more">{t('另有')}{rows.length - 2}{t('档')}</small>] : prices
  }
  return <span className="contract-exit-prices" title={hidden ? undefined : unread ? '尚未读取、读取失败或无法确认委托对应的持仓。目前支持币安普通U本位合约。' : cachedMessage ?? '横杠表示未设置或报价暂不可用。账户上次读取时的触发价，实际成交价可能不同；全部档位及委托数量请查看持仓详情。'}>
    {(['止盈', '止损'] as const).map(kind => lines(kind).map((line, index) => <Fragment key={kind + index}><small>{index ? '' : kind}</small><span className="numeric">{line}</span></Fragment>))}
  </span>
}

function ContractBadges({ position, hidden }: { position: ContractPosition; hidden: boolean }) {
  return <span className="contract-badges">
    <span className={`direction-badge ${position.direction === '做多' ? 'is-long' : 'is-short'}`}>{position.direction}</span>
    <span className="leverage-badge">{hidden ? '—' : position.leverage === null ? isReal() ? <Unavailable reason={t('平台尚未返回此仓位的杠杆资料。')} /> : '组合保证金' : `${position.leverage}×`}</span>
  </span>
}

export function EquityBreakdown({ assetsCents, pnlCents, currency, hidden, filtered = false, pnlIncomplete = false, issue }: MoneyProps & { assetsCents: number; pnlCents: number; filtered?: boolean; pnlIncomplete?: boolean; issue?: string }) {
  return <div className="equity-breakdown" aria-label={t('资产与合约盈亏对账')}>
    <div><span>{filtered ? '匹配资产余额' : '资产余额'}</span><strong className="numeric">{formatMoney(assetsCents, currency, hidden)}</strong></div>
    <span className="equity-operator" aria-hidden>＋</span>
    <div><span>{filtered ? '匹配合约浮盈亏' : '合约浮动盈亏'}</span><strong><SignedAmount value={pnlIncomplete ? null : pnlCents} currency={currency} hidden={hidden} /></strong></div>
    <span className="equity-operator" aria-hidden>＝</span>
    <div><span>{filtered ? '筛选合计' : '账户资产净值'}{!hidden && (issue || pnlIncomplete) && <IssueHint message={issue || '部分合约浮盈尚未读取，净值仅包含已知部分。'} />}</span><strong className="numeric">{formatMoney(assetsCents + pnlCents, currency, hidden)}</strong></div>
  </div>
}

export function ContractExposureBar({ items, currency, hidden }: MoneyProps & { items: ContractPosition[] }) {
  const summary = summarizeContracts(items)
  if (!hidden && summary.priceMissingCount) return <div className="contract-exposure-bar"><span className="muted">{t('多空对比')} <Unavailable reason={`${summary.priceMissingCount}笔持仓缺少有效价格，无法完整比较仓位金额。`} /></span></div>
  const longShare = summary.notionalCents > 0 ? summary.longNotionalCents / summary.notionalCents * 100 : 0
  return <div className="contract-exposure-bar" aria-label={t('按仓位金额对比多空')}>
    <div className="contract-exposure-labels"><span>{t('做多')} <strong className="numeric">{formatMoney(summary.longNotionalCents, currency, hidden)}</strong></span><span>{t('做空')} <strong className="numeric">{formatMoney(summary.shortNotionalCents, currency, hidden)}</strong></span></div>
    <div className="contract-exposure-track" aria-hidden="true">{!hidden && summary.notionalCents > 0 && <><span className="is-long" style={{ width: `${longShare}%` }} /><span className="is-short" style={{ width: `${100 - longShare}%` }} /></>}</div>
  </div>
}

export function ContractsList({ items, currency, hidden, onSelect, compact = false }: MoneyProps & { items: ContractPosition[]; onSelect: (position: ContractPosition) => void; compact?: boolean }) {
  return <>
    {!compact && <div className="table-scroll"><table className="holdings-table contract-table">
      <thead><tr><th>{t('合约 / 方向 / 杠杆')}</th><th>{t('浮动盈亏')}</th><th>{t('入场价')}</th><th title={t('平台标记价格，随账户读取更新')}>{t('现价')}</th><th title={t('显示尚未触发的平仓委托触发价')}>{t('止盈 / 止损')}</th><th>{t('仓位金额')}</th><th className="contract-margin-column">{t('占用保证金')}</th><th className="contract-account-column">{t('所在账户')}</th><th><span className="sr-only">{t('详情')}</span></th></tr></thead>
      <tbody>{items.map(position => {
        const account = accounts.find(item => item.id === position.accountId)!
        return <tr key={position.id}>
          <td><button type="button" className="asset-name-button" onClick={() => onSelect(position)} aria-label={`查看 ${position.symbol} ${position.direction} ${account.name} 详情`}><Avatar src={position.icon} name={position.baseAsset} /><span><strong>{position.symbol}</strong><ContractBadges position={position} hidden={hidden} /></span></button></td>
          <td><SignedAmount value={position.unrealizedPnlCents} currency={currency} hidden={hidden} /></td>
          <td className="numeric">{position.entryPriceUsd === null ? <Unavailable hidden={hidden} reason={t('平台尚未返回此仓位的入场均价。')} /> : formatPrice(position.entryPriceUsd, currency, hidden)}</td>
          <td className="numeric" title={position.priceUpdatedAt && !hidden ? `行情时间：${new Date(position.priceUpdatedAt).toLocaleString('zh-CN')}` : undefined}>{position.markPriceUsd === null ? <Unavailable hidden={hidden} reason={t('缺少有效标记价格。')} /> : formatPrice(position.markPriceUsd, currency, hidden)}</td>
          <td><ContractExitPrices position={position} currency={currency} hidden={hidden} /></td>
          <td className="numeric value-cell">{position.markPriceUsd === null && !hidden ? <Unavailable reason={t('缺少有效标记价格，暂时无法估算仓位金额。')} /> : formatMoney(contractValueCents(position), currency, hidden)}</td>
          <td className="contract-margin-column numeric muted">{position.marginCents === null ? <Unavailable hidden={hidden} reason={t('平台未提供可单独拆分的此仓位保证金。')} /> : formatMoney(position.marginCents, currency, hidden)}</td>
          <td className="contract-account-column"><span className="source-label" title={account.name}>{account.name}</span></td>
          <td><Button variant="ghost" className="icon-button row-action" aria-label={`打开 ${position.symbol} ${position.direction} ${account.name} 详情`} onClick={() => onSelect(position)}><ChevronRight size={16} /></Button></td>
        </tr>
      })}</tbody>
    </table></div>}
    <div className={compact ? 'contract-compact-list' : 'mobile-holdings contract-mobile-list'}>
      {items.map(position => {
        const account = accounts.find(item => item.id === position.accountId)!
        return <button type="button" className="contract-card-row" key={position.id} onClick={() => onSelect(position)} aria-label={`查看 ${position.symbol} ${position.direction} ${account.name} 详情`}>
          <Avatar src={position.icon} name={position.baseAsset} size={compact ? 28 : 32} />
          <span className="contract-card-body">
            <span className="contract-card-line"><span className="contract-row-name"><strong>{position.symbol}</strong><ContractBadges position={position} hidden={hidden} /></span><SignedAmount value={position.unrealizedPnlCents} currency={currency} hidden={hidden} /></span>
            <span className="contract-card-line contract-card-sub"><small>{account.name}</small>{!compact && <small>{t('仓位')} {position.markPriceUsd === null && !hidden ? <Unavailable reason={t('缺少有效标记价格，暂时无法估算仓位金额。')} /> : formatMoney(contractValueCents(position), currency, hidden)}</small>}</span>
            {!compact && <span className="contract-row-prices">
              <span className="contract-quote-prices"><small>{t('入场价')}</small><span className="numeric">{position.entryPriceUsd === null ? hidden ? '••••••' : '—' : formatPrice(position.entryPriceUsd, currency, hidden)}</span><small>{t('现价')}</small><span className="numeric">{position.markPriceUsd === null ? hidden ? '••••••' : '—' : formatPrice(position.markPriceUsd, currency, hidden)}</span></span>
              <ContractExitPrices position={position} currency={currency} hidden={hidden} />
            </span>}
          </span>
        </button>
      })}
    </div>
  </>
}

export function ContractsOverview({ currency, hidden, onSelect, onViewAll }: MoneyProps & { onSelect: (position: ContractPosition) => void; onViewAll: () => void }) {
  return <Panel title={t('合约概况')} className="contracts-overview" action={<button type="button" className="text-action" onClick={onViewAll}>{t('全部合约')} {contracts.length} {t('笔')}<ArrowUpRight size={13} /></button>}>
    <div className="contract-metrics">
      <div><span>{t('合约浮动盈亏')}</span><strong><SignedAmount value={contractSummary.pnlMissingCount ? null : contractSummary.unrealizedPnlCents} currency={currency} hidden={hidden} /></strong></div>
      <div><span>{t('已知占用保证金')}</span><strong className="numeric">{formatMoney(contractSummary.knownMarginCents, currency, hidden)}</strong></div>
      <div><span>{t('合约仓位金额')}</span><strong className="numeric">{contractSummary.priceMissingCount && !hidden ? <Unavailable reason={t('部分仓位缺少有效价格，暂时无法计算完整仓位金额。')} /> : formatMoney(contractSummary.notionalCents, currency, hidden)}</strong></div>
    </div>
    <div className="contract-overview-grid">
      <div className="contract-exposure"><div className="contract-block-heading"><h3>{t('多空仓位对比')}</h3><span>{t('按仓位金额')}</span></div><ContractExposureChart items={contracts} currency={currency} hidden={hidden} /><div className="exposure-values"><span>{t('做多')} <strong className="numeric">{formatMoney(contractSummary.longNotionalCents, currency, hidden)}</strong></span><span>{t('做空')} <strong className="numeric">{formatMoney(contractSummary.shortNotionalCents, currency, hidden)}</strong></span></div></div>
      <div className="contract-preview"><div className="contract-block-heading"><h3>{t('主要合约')}</h3><span>{t('浮动盈亏')}</span></div><ContractsList items={filterContracts('').slice(0, 3)} currency={currency} hidden={hidden} onSelect={onSelect} compact /></div>
    </div>

  </Panel>
}

export function ContractDetail({ position, currency, hidden, onClose }: MoneyProps & { position: ContractPosition; onClose: () => void }) {
  const [range, setRange] = useState<ReturnRange>({ period: '30天' })
  const account = accountBalances.find(item => item.id === position.accountId)!
  const cachedMessage = cachedExitOrdersMessage(position)
  const money = (cents: number) => formatMoney(cents, currency, hidden)
  const chartPoints = isReal() ? equityPoints({ mode: 'contract-price', contractId: position.id, period: range }) : []
  const prices = [
    { label: '入场均价', price: position.entryPriceUsd },
    { label: '平台估值参考价', price: position.markPriceUsd },
    { label: '预估强平价', price: position.liquidationPriceUsd },
  ]
  return <Modal open onClose={onClose} title={`${position.symbol} · ${position.direction}持仓`} className="holding-dialog contract-dialog">
    <div className="detail-asset"><Avatar src={position.icon} name={position.baseAsset} size={46} /><div><h3>{position.name}</h3><ContractBadges position={position} hidden={hidden} /></div><span className="detail-asset-source">{account.name}<br />{position.marginMode}</span></div>
    <div className="detail-summary contract-detail-summary">
      <div><span title={t('平台报告值，以账户上次读取时间为准')}>{t('浮动盈亏')}</span><strong><SignedAmount value={position.unrealizedPnlCents} currency={currency} hidden={hidden} /></strong></div>
      <div><span>{t('仓位金额 · 不计入总资产')}</span><strong className="numeric">{money(contractValueCents(position))}</strong></div>
      <div><span>{t('持仓数量')}</span><strong className="numeric">{formatQuantity(position.quantity, hidden)} <small>{position.baseAsset}</small></strong></div>
    </div>
    <div className="contract-prices">{prices.map(item => <div key={item.label} title={item.label === '平台估值参考价' && position.priceUpdatedAt ? `行情时间：${new Date(position.priceUpdatedAt).toLocaleString('zh-CN')}` : undefined}><span>{item.label}</span><strong className="numeric">{hidden ? '••••••' : item.price === null ? '暂不可用' : formatPrice(item.price, currency)}</strong></div>)}</div>
    <section className="contract-exit-details" aria-label={t('止盈止损委托')} title={hidden ? undefined : cachedMessage}>
      <h4>{t('止盈 / 止损')}</h4>
      {hidden ? <p className="muted">••••••</p> : unreadExitOrders(position) ? <p className="muted" aria-label={t('止盈止损暂不可用')}>— <IssueHint message={t('当前资料尚未读取、读取失败或无法确认委托与持仓的对应关系。目前支持币安普通U本位合约。')} /></p>
        : !position.exitOrders!.length ? <p className="muted" aria-label={t('未设置止盈止损')}>—</p> : <dl>{position.exitOrders!.map(order => <div key={order.id}>
          <dt>{order.kind}{order.kind !== '移动止损' && '触发价'}</dt>
          <dd><strong className="numeric">{order.kind === '移动止损' ? '随价格移动' : order.triggerPriceUsd === null ? '—' : formatPrice(order.triggerPriceUsd, currency)}</strong>
            <small>{order.triggerBasis === '未知' ? '触发依据 —' : `${order.triggerBasis}触发`} · {order.quantity === null ? '全部持仓' : `${formatQuantity(order.quantity)} ${position.baseAsset}`}</small></dd>
        </div>)}</dl>}
    </section>
    <div className="detail-chart-heading"><span className="contract-chart-label">{isReal() ? '标记价 · 数量 × 现价' : '参考价示例走势'}</span><ReturnRangeFilter value={range} onChange={setRange} title={t('合约走势时间范围')} /></div>
    <PeriodChange range={range} points={chartPoints} currency={currency} hidden={hidden} />
    <HistoryChart historyPoints={isReal() ? chartPoints : undefined} period={range.period} currency={currency} hidden={hidden} endValue={position.markPriceUsd === null ? undefined : Math.round(position.markPriceUsd * 100)} price />

    <div className="contract-account-summary">
      <div className="contract-block-heading"><h4><Layers3 size={15} />{t('保证金与账户')}</h4><span>{isReal() ? 'U本位合约' : 'USDT 永续 · 示例'}</span></div>
      <dl>
        <div><dt>{t('本仓位占用保证金')}</dt><dd className="numeric">{position.marginCents === null ? <Unavailable hidden={hidden} reason={t('平台未提供可单独拆分的此仓位保证金。')} /> : money(position.marginCents)}</dd></div>
        <div><dt>{t('杠杆 / 保证金方式')}</dt><dd>{hidden ? '—' : position.leverage === null ? isReal() ? <Unavailable reason={t('平台尚未返回此仓位的杠杆资料。')} /> : '无单仓固定杠杆' : `${position.leverage}×`} / {position.marginMode}</dd></div>
        <div><dt>{t('所属账户资产余额')}</dt><dd className="numeric">{money(account.assetsCents)}</dd></div>
        <div><dt>{t('所属账户全部合约浮盈亏')}</dt><dd><SignedAmount value={account.pnlIncomplete ? null : account.pnlCents} currency={currency} hidden={hidden} /></dd></div>
        <div><dt>{t('所属账户净值')}</dt><dd className="numeric">{money(account.valueCents)}</dd></div>
      </dl>
    </div>

    
  </Modal>
}
