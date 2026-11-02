import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowDownUp, ArrowRightLeft, ArrowUpFromLine, ChartCandlestick, CircleCheck, CircleDot, CircleHelp, Coins, Gift, Layers3, RefreshCw } from 'lucide-react'
import Select from './Select'
import { exchanges, walletFamilies } from '../data/live-types'
import { liveState } from '../data/live'
import { returnRangeDates } from '../data/return-range'
import type { ReturnRange } from '../data/return-range'
import { walletTransactionUrl } from '../data/transactions'
import { feesAsUsdt } from '../data/fee-valuation'
import { formatPriceNumber } from '../data/portfolio'
import type { Transaction, TransactionFilters } from '../data/transactions'
import { rewardDescription, isTransactionReward, rewardUsdtValue } from '../data/transaction-rewards'
import { transactionCategories } from '../data/transaction-feed'
import type { TransactionCategory, TransactionEntry, TransactionPageResult } from '../data/transaction-feed'
import { transactionState } from '../data/transaction-client'
import { Button, Modal, Panel, IssueHint, Unavailable } from './ui'
import { ContractRoundCard, ContractRoundModal, RecordCard, clock } from './ContractHistory'
import TransactionSummary from './TransactionSummary'
import ReturnRangeFilter from './ReturnRangeFilter'
import { ClearFilters, FilterBar, FilterField, SearchField } from './FilterBar'
import '../records-pages.css'

const stamp = (time: number) => new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const zone = { timeZone: 'Asia/Shanghai' } as const
const weekday = (time: number) => new Date(time).toLocaleDateString('zh-CN', { ...zone, weekday: 'short' })
// 记录已按时间倒序返回，相邻同一天的归为一组。
const dayGroups = (entries: TransactionEntry[]) => entries.reduce<{ day: string; time: number; entries: TransactionEntry[] }[]>((groups, entry) => {
  const day = new Date(entry.time).toLocaleDateString('sv-SE', zone), last = groups.at(-1)
  if (last?.day === day) last.entries.push(entry)
  else groups.push({ day, time: entry.time, entries: [entry] })
  return groups
}, [])
const initialFilters = (): TransactionFilters => ({ query: '', type: '', account: '', source: '', ...returnRangeDates({ period: '30天' }) })
const categoryIcons = {
  全部: <Layers3 size={18} color="#9fb8a9" />,
  合约: <ChartCandlestick size={18} color="#b9a5ea" />,
  现货: <Coins size={18} color="#d2bb7f" />,
  转账: <ArrowRightLeft size={18} color="#93b9d7" />,
  充值: <ArrowDownToLine size={18} color="#8fd9b6" />,
  提现: <ArrowUpFromLine size={18} color="#d6a095" />,
  兑换: <RefreshCw size={18} color="#87c6c5" />,
  奖励: <Gift size={18} color="#d5a1c3" />,
}

export function TransactionsPage({ hidden }: { hidden: boolean }) {
  const [category, setCategory] = useState<TransactionCategory>('全部')
  const [result, setResult] = useState<TransactionPageResult | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [filters, setFilters] = useState<TransactionFilters>(initialFilters)
  const [status, setStatus] = useState('已平仓')
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [page, setPage] = useState(1), [selectedId, setSelectedId] = useState(''), [roundId, setRoundId] = useState(''), [groupId, setGroupId] = useState('')
  const entries = result?.entries ?? [], pages = result?.pages ?? 1, current = result?.page ?? 1
  const sources = new Map([...(result?.sources ?? []), ...liveState.connections.map(item => [item.id, item.name] as [string, string])])
  const selected = entries.flatMap(entry => entry.kind === 'transaction' ? [entry.row] : entry.kind === 'rewards' ? entry.rows : []).find(row => row.id === selectedId)
  const selectedGroup = entries.find(entry => entry.kind === 'rewards' && entry.id === groupId)
  const selectedRewardValue = selected ? rewardUsdtValue(selected) : null
  const selectedRound = entries.find(entry => entry.kind === 'contract' && entry.id === roundId)
  const visibleAmount = (quantity: string | null, asset = '') => hidden ? '••••••' : quantity === null ? <Unavailable reason={t('平台未提供此项资料，未将缺失金额当作零。')} /> : `${quantity}${asset ? ' ' + asset : ''}`
  const visiblePrice = (price: string | null, quote: string) => visibleAmount(price === null ? null : formatPriceNumber(price), quote)
  // 奖励金额按全站精度显示，悬停可看完整数值。
  const rewardAmount = (quantity: string, asset: string) => hidden ? '••••••' : <span title={`${quantity} ${asset}`}>{Number(quantity) > 0 ? '+' : ''}{formatPriceNumber(quantity)} {asset}</span>
  const rewardTone = (quantity: string) => hidden || Number(quantity) === 0 ? '' : quantity.startsWith('-') ? 'negative' : 'positive'
  const feeText = (row: Transaction) => hidden ? '••••••' : row.fees.length ? feesAsUsdt(row).map(fee => `${fee.quantity} ${fee.asset}`).join(' / ') : <Unavailable reason={t('这笔记录没有提供手续费明细。')} />
  const transactionLink = selected ? walletTransactionUrl(selected) : ''
  const relatedWallets = selected ? result?.walletPeers[selected.id] ?? [] : []
  function change(key: keyof TransactionFilters, value: string) { setFilters(current => ({ ...current, [key]: value })); setPage(1) }
  // 起止日期恰好等于某个“近N天”时按该预设显示，否则才是自定义。
  const defaults = initialFilters()
  const preset = (['1天', '7天', '30天', '1年'] as const).find(period => { const dates = returnRangeDates({ period }); return dates.start === filters.start && dates.end === filters.end })
  const dateRange: ReturnRange = preset ? { period: preset } : filters.start && filters.end ? { period: '自定义', start: filters.start, end: filters.end } : { period: '全部时间' }
  useEffect(() => {
    const update = () => setRefresh(value => value + 1)
    window.addEventListener('transaction-data-change', update)
    return () => window.removeEventListener('transaction-data-change', update)
  }, [])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    const query = new URLSearchParams({ ...filters, category, status, page: String(page) })
    const timer = window.setTimeout(() => {
      void fetch('/api/transactions/page?' + query, { headers: { 'X-Investment-App': '1' }, signal: controller.signal }).then(async response => {
        const value = await response.json()
        if (!response.ok) throw new Error(value.error || '交易记录暂时无法读取。')
        if (!Array.isArray(value.entries) || value.entries.length > 20 || !Array.isArray(value.sources) || !value.totals || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.pages)) throw new Error(t('交易记录查询结果无法识别。'))
        if (active) { setResult(value); setError('') }
      }).catch(problem => { if (active) { setError((problem as Error).message); setResult(null) } }).finally(() => { if (active) setLoading(false) })
    }, filters.query ? 200 : 0)
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [category, filters, status, page, refresh])
  return <div className="records-page">
    <Panel title={<>{category}{t('记录')}{error && <IssueHint important message={error} />}</>} action={<span className="returns-panel-count">{result?.total ?? 0} {t('项')}</span>}>
      <div className="records-panel-body">
        <FilterBar>
          <FilterField label={t('搜索')} wide><SearchField label={t('搜索交易记录')} placeholder={t('币种或订单号')} value={filters.query} onChange={value => change('query', value)} /></FilterField>
          <FilterField label={t('分类')}><Select label={t('交易记录分类')} value={category} onChange={value => { if (!transactionCategories.includes(value as TransactionCategory)) return; setCategory(value as TransactionCategory); setStatus('已平仓'); setPage(1) }} options={transactionCategories.map(value => ({ value, label: value, icon: categoryIcons[value] }))} /></FilterField>
          <FilterField label={t('来源账户')}><Select label={t('来源账户')} value={filters.source} onChange={value => change('source', value)} searchable options={[{ value: '', label: '全部账户', icon: <Layers3 size={18} /> }, ...[...sources].map(([id, name]) => { const connection = liveState.connections.find(item => item.id === id); return { value: id, label: name, icon: connection?.type === 'wallet' ? walletFamilies.find(item => item.id === (connection.walletFamily ?? 'evm'))?.icon : exchanges.find(item => item.id === connection?.type)?.icon } })]} /></FilterField>
          {category === '合约' && <FilterField label={t('状态')}><Select label={t('状态')} value={status} onChange={value => { setStatus(value); setPage(1) }} options={[{ value: '已平仓', label: '已平仓', icon: <CircleCheck size={18} /> }, { value: '持仓中', label: '持仓中', icon: <CircleDot size={18} /> }, { value: '资料不全', label: '资料不全', icon: <CircleHelp size={18} /> }, { value: '', label: '全部状态', icon: <Layers3 size={18} /> }]} /></FilterField>}
          <FilterField label={t('时间范围')}><ReturnRangeFilter title={t('交易记录日期范围')} value={dateRange} onChange={range => { setFilters(current => ({ ...current, ...returnRangeDates(range) })); setPage(1) }} /></FilterField>
          {((category === '合约' && status !== '已平仓') || category !== '全部' || filters.query || filters.source || filters.start !== defaults.start || filters.end !== defaults.end) && <ClearFilters onClick={() => { setCategory('全部'); setFilters(initialFilters()); setStatus('已平仓'); setPage(1) }} />}
        </FilterBar>
        {result && (category !== '全部' || filters.query) && <p className="transaction-summary-scope">{t('汇总按所选日期和账户统计全部类型，不受分类和搜索影响。')}</p>}
        {result && <TransactionSummary state={transactionState} rounds={[]} filters={filters} connections={liveState.connections} hidden={hidden} suppliedTotals={result.totals} />}
        {filters.start && filters.end && filters.start > filters.end && <p className="transactions-error" role="alert">{t('开始日期不能晚于结束日期。')}</p>}
        <div className={loading ? 'records-loading' : undefined}>{dayGroups(entries).map(group => <section className="transaction-day" key={group.day} aria-label={group.day}>
        <h3 className="transaction-day-title">{group.day}<span>{weekday(group.time)}</span></h3>
        <div className="contract-round-list">{group.entries.map(entry => {
          if (entry.kind === 'contract') return <ContractRoundCard key={entry.id} round={entry.round} hidden={hidden} onSelect={() => { setSelectedId(''); setRoundId(entry.id) }} />
          if (entry.kind === 'rewards') return <RecordCard key={entry.id} onSelect={() => { setSelectedId(''); setRoundId(''); setGroupId(entry.id) }} label={entry.asset + '奖励'} tag={<span className="contract-market">{t('奖励')}</span>} title={entry.asset} source={`${entry.rows[0].connectionName} · ${entry.rows[0].account}`}
            amount={rewardAmount(entry.quantity, entry.asset)} tone={rewardTone(entry.quantity)} meta={[entry.label, `${entry.rows.length} 笔`, `${clock(entry.rows.at(-1)!.time)}–${clock(entry.rows[0].time)}`]} />
          const row = entry.row, reward = entry.category === '奖励', open = () => { setRoundId(''); setSelectedId(row.id) }
          const status = ['已完成', '已记录'].includes(row.status) ? undefined : row.status
          const time = (row.scope === 'spot-rebate' ? '更新 ' : '') + clock(row.time), source = `${row.connectionName} · ${row.account}`
          if (reward) {
            const rewardValue = rewardUsdtValue(row), quantity = rewardValue ?? row.quantity, asset = rewardValue === null ? row.asset : 'USDT'
            return <RecordCard key={entry.id} onSelect={open} label={asset + '奖励'} tag={<span className="contract-market">{row.type}</span>} title={asset} source={source} status={status}
              amount={rewardAmount(quantity, asset)} tone={rewardTone(quantity)}
              meta={[rewardDescription(row), time]} />
          }
          const asset = row.movements?.length ? [...new Set(row.movements.map(move => move.asset))].join(' / ') : row.symbol || row.asset
          return <RecordCard key={entry.id} onSelect={open} label={asset + entry.category} tag={<span className="contract-market">{row.type}</span>} title={asset} source={source} status={status}
            amount={row.movements ? row.movements.length ? row.movements.map(move => <span className="transaction-movement-amount" key={move.token}>{hidden ? '••••••' : `${move.direction === 'in' ? '+' : '−'}${move.quantity} ${move.asset}`}</span>) : '—' : visibleAmount(row.quantity, row.asset)}
            meta={[...(row.price !== null ? [<>{t('成交价')} {visiblePrice(row.price, row.quoteAsset)}</>] : []), <>{t('手续费')} {feeText(row)}</>, time]} />
        })}</div>
        </section>)}</div>
        {!entries.length && <div className="records-empty"><ArrowDownUp size={28} aria-hidden /><h3>{loading ? '正在读取记录' : '暂无符合条件的记录'}</h3></div>}
        {entries.length > 0 && <div className="transactions-pagination"><span>{t('第')} {current} / {pages} {t('页 · 每页20条')}</span><Button disabled={current === 1} onClick={() => setPage(current - 1)}>{t('上一页')}</Button><Button disabled={current === pages} onClick={() => setPage(current + 1)}>{t('下一页')}</Button></div>}
      </div>
    </Panel>
    <Modal open={!!selectedGroup} onClose={() => setGroupId('')} title={selectedGroup?.kind === 'rewards' ? `${selectedGroup.label} · ${selectedGroup.rows.length} 笔` : '奖励明细'} className="transactions-modal">
      {selectedGroup?.kind === 'rewards' && <div className="reward-group-list">{selectedGroup.rows.map(row => {
        const value = rewardUsdtValue(row) ?? row.quantity, asset = rewardUsdtValue(row) === null ? row.asset : 'USDT'
        return <button type="button" key={row.id} onClick={() => { setGroupId(''); setSelectedId(row.id) }}><span>{clock(row.time)}</span><strong className={`numeric ${rewardTone(value)}`}>{rewardAmount(value, asset)}</strong></button>
      })}</div>}
    </Modal>
    <ContractRoundModal selected={selectedRound?.kind === 'contract' ? selectedRound.round : null} hidden={hidden} onClose={() => setRoundId('')} />
    <Modal open={!!selected} onClose={() => setSelectedId('')} title={t('交易记录详情')} className="transactions-modal">
      {selected && <dl className="transactions-details">{(isTransactionReward(selected) ? [
        [selected.scope === 'spot-rebate' ? '平台更新时间' : '时间', stamp(selected.time)], ['类型 / 状态', `奖励 · ${selected.status}`], ['所属账户', `${selected.connectionName} · ${selected.account}`], ['原始金额', visibleAmount(selected.quantity, selected.asset)], ['折合金额', visibleAmount(selectedRewardValue, 'USDT')], ['奖励类型', rewardDescription(selected)],
        ...(selected.rewardValuation ? [['折算价格', visiblePrice(selected.rewardValuation.price, 'USDT / ' + selected.asset)], ['行情时间', stamp(selected.rewardValuation.at)], ['折算依据', selected.rewardValuation.basis === 'parity' ? 'USDC与USDT按1:1' : `币安 ${selected.rewardValuation.pair} 每分钟开盘价`]] : selectedRewardValue !== null ? [['折算依据', 'USDC与USDT按1:1']] : []),
      ] : [
        ['时间', stamp(selected.time)], ['类型 / 状态', `${selected.type} · ${selected.status}`], ['所属账户', `${selected.connectionName} · ${selected.account}`], ['资产 / 交易对', selected.symbol || selected.asset],
        ['数量', visibleAmount(selected.quantity, selected.asset)], ['成交价', visiblePrice(selected.price, selected.quoteAsset)], [selected.scope === 'usdm' ? '名义成交金额' : '成交金额', visibleAmount(selected.quoteQuantity, selected.quoteAsset)], ['手续费（负数为返还）', feeText(selected)],
        ['平台报告的已实现盈亏', visibleAmount(selected.realizedPnl, selected.pnlAsset)], ['订单号', selected.orderId], ['链上交易编号', selected.txHash], ['网络', selected.network], ['地址', selected.address], ['说明', selected.note],
      ]).filter(([, value]) => value !== '').map(([label, value], index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}
      {selected.walletOwner && <div><dt>{t('本钱包地址')}</dt><dd>{selected.walletOwner}</dd></div>}
      {selected.movements?.map(move => <div key={move.token}><dt>{move.direction === 'in' ? '收到' : '转出'} {move.asset}</dt><dd>{visibleAmount(move.quantity, move.asset)}<small>{move.token === 'native' ? '主币' : `币种识别地址：${move.token}`}</small><small>{t('对方地址：')}{move.counterparty || '未提供'}</small></dd></div>)}
      {relatedWallets.length > 0 && <div><dt>{t('同笔其他钱包记录')}</dt><dd>{relatedWallets.join('、')}</dd></div>}
      {transactionLink && <div><dt>{t('原始记录')}</dt><dd><a href={transactionLink} target="_blank" rel="noopener noreferrer">{t('打开链上查询')}</a></dd></div>}
      </dl>}
    </Modal>
  </div>
}
