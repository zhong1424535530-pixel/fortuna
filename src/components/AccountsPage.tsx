import { t } from '../i18n'
import { isReal, connectionStatus, connectionTime, liveState, removeConnection, syncConnection } from '../data/live'
import { ClearFilters, FilterBar, FilterField, SearchField, Segmented } from './FilterBar'
import { binanceAccountGroup, visibleBinanceGroups } from '../data/account-groups'
import { mergeHoldingRows } from '../data/overview'
import { exchanges, walletFamilies } from '../data/live-types'
import type { BinanceGroup, Connection } from '../data/live-types'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Copy, Info, Pencil, RefreshCw, Trash2, Wallet } from 'lucide-react'
import { Avatar, Button, Modal, Panel, SignedAmount, Trend, IssueHint, Unavailable } from './ui'
import { ContractsList, EquityBreakdown } from './Contracts'
import { HistoryChart } from './Charts'
import ReturnRangeFilter from './ReturnRangeFilter'
import { PeriodChange } from './PeriodChange'
import {
  accounts, accountBalances, assetSources, countOriginalAccounts, filterContracts, filterHoldings,
  formatMoney, formatHoldingPrice, formatQuantity, holdingQuantity, holdingValueCents,
  summarizeContracts,
} from '../data/portfolio'
import type { AssetSource, ContractPosition, Currency, Holding } from '../data/portfolio'
import type { ReturnRange } from '../data/return-range'
import { calendarToday } from '../data/return-range'
import { heldTodayPnl, todayPriceChange } from '../data/daily-pnl'
import { equityPoints } from '../data/equity-history'
import { workspace } from '../data/workspace'
import type { ManualAccount } from '../data/workspace'
import { savePortfolioWorkspace } from '../data/portfolio'
import '../accounts-page.css'

type Props = {
  initialSourceId?: string | null
  /** 手机上与搜索框同一行显示的金额显示控件 */
  toolbarStart?: ReactNode
  currency: Currency
  hidden: boolean
  onSelectAsset: (asset: Holding) => void
  onSelectContract: (position: ContractPosition) => void
  onEdit: (connection: Connection | ManualAccount) => void
}

const walletChains: Record<string, string> = { ethereum: 'Ethereum', solana: 'Solana', tron: 'TRON' }

function CopyButton({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState('')
  async function copy() {
    setMessage('')
    try { await navigator.clipboard.writeText(value); setMessage('已复制') }
    catch { setMessage('复制失败，请手动复制') }
  }
  return <button type="button" className="account-page-copy" title={message || `复制${label}`} aria-label={`复制${label}`} onClick={() => { void copy() }}>{message === '已复制' ? <Check size={13} /> : <Copy size={13} />}<span role="status">{message}</span></button>
}

export default function AccountsPage({ currency, hidden, onSelectAsset, onSelectContract, onEdit, initialSourceId = null, toolbarStart }: Props) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string>('全部')
  const [sourceId, setSourceId] = useState<string | null>(initialSourceId)
  const [accountId, setAccountId] = useState('全部')
  const [accountGroup, setAccountGroup] = useState<BinanceGroup | '全部'>('全部')
  const [range, setRange] = useState<ReturnRange>({ period: '30天' })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Connection | ManualAccount | null>(null)
  const sources: AssetSource[] = [...assetSources, ...liveState.connections.filter(connection => !assetSources.some(item => item.id === 'live-' + connection.id)).map(connection => ({ id: 'live-' + connection.id, name: connection.name, group: connection.type === 'wallet' ? '链上钱包' as const : '交易所' as const, icon: connection.type === 'wallet' ? walletFamilies.find(item => item.id === (connection.walletFamily ?? 'evm'))!.icon : exchanges.find(item => item.id === connection.type)?.icon ?? '', accountIds: [], valueCents: 0, incomplete: true, updatedAt: null }))]
  const source = sources.find(item => item.id === sourceId)
  const money = (value: number) => formatMoney(value, currency, hidden)
  async function act(id: string, remove = false) {
    setBusy(id); setError('')
    try { if (remove) { await removeConnection(id); setDeleting(null) } else await syncConnection(id) }
    catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }

  async function removeManual(account: ManualAccount) {
    setError(''); setBusy(account.id)
    try {
      if (workspace.manualAssets.some(asset => asset.accountId === account.id) || Object.values(workspace.costs ?? {}).some(entries => Object.hasOwn(entries, account.id))) throw new Error(t('这个账户还有资产或成本资料，请先处理关联资料，不能直接移除。'))
      await savePortfolioWorkspace({ ...workspace, manualAccounts: workspace.manualAccounts?.filter(item => item.id !== account.id) })
      setDeleting(null)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }

  if (!source) {
    const term = query.trim().toLocaleLowerCase()
    const groupSources = sources.filter(item => group === '全部' || item.group === group)
    const visibleSources = groupSources.filter(item => (
      !term || `${item.name} ${item.group} ${liveState.connections.find(connection => item.id === 'live-' + connection.id)?.address ?? ''} ${accounts.filter(account => item.accountIds.includes(account.id)).map(account => `${account.name} ${account.id} ${account.uid ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(term)
    ))
    return <div className="account-page">
      <FilterBar className="account-page-toolbar">
        {toolbarStart && <div className="account-toolbar-display">{toolbarStart}</div>}
        <FilterField label={t('搜索')} wide><SearchField label={t('搜索平台、钱包或账户')} value={query} onChange={setQuery} placeholder={t('搜索平台、钱包或账户')} /></FilterField>
        <FilterField label={t('来源类型')} fit><Segmented label={t('账户来源类型')} value={group} onChange={setGroup} options={['全部', '交易所', '链上钱包', '手动账户']} /></FilterField>
        <ClearFilters active={Boolean(query) || group !== '全部'} onClick={() => { setQuery(''); setGroup('全部') }} />
      </FilterBar>
      {error && <p className="connection-warning" role="alert">{error}</p>}
      <div className="account-page-source-grid">{visibleSources.map(item => {
        const connection = liveState.connections.find(entry => item.id === 'live-' + entry.id)
        const manual = workspace.manualAccounts?.find(account => account.id === item.id)
        const itemAccounts = accounts.filter(account => item.accountIds.includes(account.id))
        const uid = itemAccounts.find(account => account.uid)?.uid
        const identity = !connection ? '手动记录资产与估值' : connection.type === 'wallet' ? connection.address ?? '地址未读取' : uid ? `UID ${uid}` : 'UID 未读取'
        const copyValue = connection?.type === 'wallet' ? connection.address : uid
        const scopedAssets = mergeHoldingRows(filterHoldings('', '全部', item.accountIds))
        const missingPrices = scopedAssets.filter(asset => asset.usdPrice === null).length
        const openSource = () => { setSourceId(item.id); setAccountId('全部'); setAccountGroup('全部'); window.scrollTo({ top: 0, behavior: 'instant' }) }
        return <article className="account-page-source-card" key={item.id} aria-label={`${item.name}账户卡片`}>
          <div className="account-page-card-heading"><div className={`account-page-source-heading${item.group === '链上钱包' ? ' account-page-wallet-heading' : ''}`}><button type="button" className="account-page-source-icon" onClick={openSource} aria-label={`查看${item.name}账户详情`}><Avatar src={item.icon} name={item.name} size={34} /></button><span><button type="button" className="account-page-source-name" onClick={openSource} aria-label={`查看${item.name}账户详情`}><strong title={item.name}>{item.name}</strong><ArrowUpRight size={15} /></button><span className="account-page-identity-line"><small>{!copyValue && connection ? <Unavailable reason={identity + '，平台尚未返回这一项资料。'} /> : identity}</small>{copyValue && <CopyButton key={copyValue} value={copyValue} label={connection?.type === 'wallet' ? '钱包地址' : 'UID'} />}</span></span></div>{connection && (connection.status === 'error' || connection.status === 'partial' ? <IssueHint important={connection.status === 'error'} message={connection.warning || connectionStatus(connection)} /> : <span className={`connection-status ${connection.status}`}>{connectionStatus(connection)}</span>)}</div>
          <button type="button" className="account-page-source-value" onClick={openSource} aria-label={`查看${item.name}资产明细`}>
            <span><small>{t('账户资产净值')}{(missingPrices > 0 || item.incomplete) && <IssueHint message={`${missingPrices ? missingPrices + '项资产缺少价格；' : ''}${item.incomplete ? connection?.warning || '部分账户尚未完整读取；' : ''}金额仅包含已知部分。`} />}</small><strong className="numeric">{isReal() && !item.updatedAt && item.group !== '手动账户' ? <Unavailable hidden={hidden} reason={connection?.warning || '尚未成功读取此账户余额，不能显示为零。'} /> : money(item.valueCents)}</strong></span>
            <span className="account-page-asset-preview"><small>{scopedAssets.length} {t('项资产')}</small><span className="account-page-asset-icons">{scopedAssets.slice(0, 5).map(asset => <span key={asset.id} title={asset.symbol}><Avatar src={asset.icon} name={asset.symbol} size={26} company={asset.category === '股票'} /></span>)}{scopedAssets.length > 5 && <span className="account-page-asset-more" title={`还有 ${scopedAssets.length - 5} 项资产`} aria-label={`还有 ${scopedAssets.length - 5} 项资产`}>…</span>}</span></span>
          </button>
          {connection && <>
            <p className="account-page-card-updated">{t('上次成功：')}{connectionTime(connection.updatedAt)}</p>
            <div className="account-page-card-actions"><Button disabled={!!busy} onClick={() => act(connection.id)} aria-label={`刷新${connection.name}`}><RefreshCw size={13} className={busy === connection.id ? 'connection-spinning' : ''} />{busy === connection.id ? '处理中' : '刷新'}</Button><Button disabled={!!busy} onClick={() => onEdit(connection)} aria-label={`修改${connection.name}`}><Pencil size={13} />{t('修改')}</Button><Button disabled={!!busy} variant="ghost" className="icon-button" onClick={() => { setError(''); setDeleting(connection) }} aria-label={`移除${connection.name}`}><Trash2 size={14} /></Button></div>
          </>}
          {manual && <><p className="account-page-card-updated">{t('更新于：')}{connectionTime(manual.updatedAt)}</p><div className="account-page-card-actions"><Button onClick={() => { window.location.hash = 'manage' }}>{t('添加资产')}</Button><Button onClick={() => onEdit(manual)}><Pencil size={13} />{t('改名')}</Button><Button variant="ghost" className="icon-button" aria-label={`移除${manual.name}`} onClick={() => { setError(''); setDeleting(manual) }}><Trash2 size={14} /></Button></div></>}
        </article>
      })}</div>
      {!visibleSources.length && <Panel><div className="account-page-empty"><Wallet size={24} /><h3>{groupSources.length ? '没有找到匹配的账户' : group === '链上钱包' ? '还没有添加钱包' : '还没有添加账户'}</h3>{groupSources.length ? <Button onClick={() => setQuery('')}>{t('清除筛选')}</Button> : null}</div></Panel>}
      {deleting && <Modal open onClose={() => { if (!busy) setDeleting(null) }} title={`移除${deleting.name}？`} description={'type' in deleting ? "仅移除本机接入与密钥。" : "仅可移除没有关联资产或成本的空账户。"}>{error && <p className="connection-warning" role="alert">{error}</p>}<div className="connection-form-actions"><Button disabled={!!busy} onClick={() => { setDeleting(null); setError('') }}>{t('取消')}</Button><Button disabled={!!busy} onClick={() => { if ('type' in deleting) void act(deleting.id, true); else void removeManual(deleting) }}>{busy ? '正在移除' : '确认移除'}</Button></div></Modal>}
    </div>
  }

  const sourceAccounts = accounts.filter(account => source.accountIds.includes(account.id))
  const isWallet = source.group === '链上钱包'
  const walletAddress = liveState.connections.find(connection => 'live-' + connection.id === source.id)?.address ?? sourceAccounts.find(account => account.address)?.address
  const isBinance = liveState.connections.some(connection => 'live-' + connection.id === source.id && connection.type === 'binance')
  const allAssets = filterHoldings('', '全部'), allContracts = filterContracts('')
  const fundedIds = new Set(allAssets.flatMap(asset => asset.positions.filter(position => position.quantity > 0).map(position => position.accountId)))
  const groups = visibleBinanceGroups(sourceAccounts, fundedIds, new Set(allContracts.map(position => position.accountId)))
  const selectedGroup = isBinance && accountGroup !== '全部' && groups.includes(accountGroup) ? accountGroup : '全部'
  const groupAccounts = sourceAccounts.filter(account => selectedGroup === '全部' || binanceAccountGroup(account) === selectedGroup)
  const selectedId = groupAccounts.some(account => account.id === accountId) ? accountId : '全部'
  const selectedIds = groupAccounts.filter(account => selectedId === '全部' || account.id === selectedId).map(account => account.id)
  const selectedName = selectedId !== '全部' ? sourceAccounts.find(account => account.id === selectedId)!.name : selectedGroup === '全部' ? source.name : `${source.name} · ${selectedGroup}`
  const coverage = sourceAccounts.find(account => account.walletCoverage)?.walletCoverage ?? []
  const unreadScopes = coverage.filter(scope => scope.status !== 'ok')
  const balances = accountBalances.filter(account => selectedIds.includes(account.id))
  const assetsCents = balances.reduce((sum, account) => sum + account.assetsCents, 0)
  const pnlCents = balances.reduce((sum, account) => sum + account.pnlCents, 0)
  const matchedAssets = allAssets.map(asset => ({ ...asset, positions: asset.positions.filter(position => selectedIds.includes(position.accountId)) })).filter(asset => asset.positions.length)
  const assets = mergeHoldingRows(matchedAssets)
  const positions = allContracts.filter(position => selectedIds.includes(position.accountId))
  const contractTotals = summarizeContracts(positions)
  const missingPrices = assets.filter(asset => asset.usdPrice === null).length
  const historyPoints = equityPoints({ mode: 'accounts', accountIds: selectedIds, period: range })
  const accountIssue = sourceAccounts.filter(account => selectedIds.includes(account.id) && account.warning).map(account => `${account.name}：${account.warning}`).join('；')
  const scopeIssue = isBinance ? `暂未接入：理财、杠杆、币本位、期权、组合保证金。${unreadScopes.map(scope => scope.label + '：' + (scope.warning || '尚未完整读取')).join('；')}${!coverage.length ? '资金、Alpha与股票钱包尚未扫描。' : ''}这些范围未按零余额处理。` : accountIssue
  const today = calendarToday()
  const assetRows = assets.map(asset => ({ asset, changeToday: todayPriceChange(asset, accounts, today), pnlToday: heldTodayPnl([asset], accounts, today).pnlCents }))

  return <div className="account-page account-page-detail">
    <div className="account-detail-toolbar"><Button variant="ghost" onClick={() => { setSourceId(null); window.scrollTo({ top: 0, behavior: 'instant' }) }}><ArrowLeft size={15} />{t('返回账户列表')}</Button></div>
    {error && <p className="connection-warning" role="alert">{error}</p>}
    <Panel>
      <div className="account-page-detail-heading"><Avatar key={source.id} src={source.icon} name={source.name} size={42} /><div><h2>{source.name}</h2><p>{source.group} · {countOriginalAccounts(sourceAccounts)} {t('个账户')}</p></div>{(!isReal() || source.incomplete) && <span className="account-page-demo-badge">{isReal() ? <IssueHint message={accountIssue || scopeIssue || '此账户读取范围尚不完整，仅显示已保存部分。'} /> : '示例账户'}</span>}</div>
      {source.group === '链上钱包' && <dl className="account-page-wallet-info"><div><dt>{t('所属链')}</dt><dd>{isReal() ? sourceAccounts.map(account => account.network).filter(Boolean).join(' / ') : walletChains[source.id] ?? '待填写'}</dd></div><div><dt>{t('钱包地址')}</dt><dd className="account-page-identity-line"><span>{walletAddress ?? <Unavailable reason={t('尚未读取钱包地址。')} />}</span>{walletAddress && <CopyButton key={walletAddress} value={walletAddress} label={t('钱包地址')} />}</dd></div></dl>}
      <p className="account-page-detail-note"><Info size={14} />{source.group === '手动账户' ? '手动账户' : isReal() ? `最近成功：${connectionTime(source.updatedAt)}` : '示例账户'}</p>
      {isBinance && <>
        <div className="account-page-account-switch account-page-binance-groups" role="group" aria-label={t('币安资产分类')}>{(['全部', ...groups] as const).map(item => {
          const ids = sourceAccounts.filter(account => item === '全部' || binanceAccountGroup(account) === item).map(account => account.id)
          const values = accountBalances.filter(account => ids.includes(account.id))
          const unread = !values.some(account => account.updatedAt)
          const incomplete = values.some(account => account.status !== 'ok') || item === '全部' && source.incomplete || unreadScopes.some(scope => item === '全部' || scope.group === item)
          return <button type="button" key={item} aria-pressed={selectedGroup === item} className={selectedGroup === item ? 'active' : ''} onClick={() => { setAccountGroup(item); setAccountId('全部') }}><strong>{item === '全部' ? '全部资产' : item}</strong><span className="numeric">{unread ? <Unavailable hidden={hidden} reason={t('此分类尚未成功读取余额。')} /> : money(values.reduce((sum, value) => sum + value.valueCents, 0))}</span>{!unread && incomplete && <IssueHint message={scopeIssue || '部分账户的余额或持仓尚未完整读取，金额只包含已知部分。'} />}</button>
        })}</div>

      </>}
      <details className="account-page-original-accounts" open={isBinance ? undefined : true}>
        <summary>{isBinance ? '查看原始账户与存放位置' : isWallet ? '选择网络' : '选择账户'}{!isWallet && selectedId !== '全部' && <span>{selectedName}</span>}</summary>
        <div className={`account-page-account-switch${isWallet ? ' account-page-network-switch' : ''}`} role="group" aria-label={`${source.name}${isWallet ? '网络' : '旗下账户'}选择`}>
          <button type="button" aria-pressed={selectedId === '全部'} className={selectedId === '全部' ? 'active' : ''} onClick={() => setAccountId('全部')}><strong>{isWallet ? '全部' : selectedGroup === '全部' ? '全部账户' : `全部${selectedGroup}账户`}</strong></button>
          {groupAccounts.map(account => <button type="button" key={account.id} aria-pressed={selectedId === account.id} className={selectedId === account.id ? 'active' : ''} onClick={() => setAccountId(account.id)}><strong>{isWallet ? account.network ?? '未标注网络' : account.name}</strong>{!isWallet && <small>{account.originName ?? account.kind} · {account.updatedAt ? connectionTime(account.updatedAt) : '—'}{(account.status === 'error' || account.status === 'partial' || !account.updatedAt) && <IssueHint message={account.warning || '此账户尚未完整读取。'} />}</small>}</button>)}
        </div>
      </details>
    </Panel>
    {isReal() && source.group !== '手动账户' && !balances.some(account => account.updatedAt) ? <Panel><div className="account-page-empty"><h3>{t('账户余额')} <IssueHint message={accountIssue || '尚未读到此账户余额，不显示为零；可返回账户列表刷新。'} /></h3><span>—</span></div></Panel> : <EquityBreakdown pnlIncomplete={balances.some(account => account.pnlIncomplete)} issue={[accountIssue, scopeIssue, missingPrices ? `${missingPrices}项资产缺少价格，未计入估值。` : ''].filter(Boolean).join('；')} assetsCents={assetsCents} pnlCents={pnlCents} currency={currency} hidden={hidden} />}
    <Panel title={t('来源资产变化')} subtitle={selectedName} action={<ReturnRangeFilter value={range} onChange={setRange} title={t('账户来源走势时间')} />} className="account-page-history">
      <PeriodChange range={range} points={historyPoints} currency={currency} hidden={hidden} />
      <HistoryChart period={range.period} currency={currency} hidden={hidden} historyPoints={historyPoints} />
    </Panel>
    <Panel title={t('资产明细')} subtitle={selectedName} className="account-page-assets">
      {assets.length ? <div className="account-page-asset-list"><div className="account-page-asset-labels" aria-hidden><span>{t('资产')}</span><span>{t('持有数量')}</span><span>{t('参考单价')}</span><span>{t('估值')}</span><span>{t('今日涨跌')}</span><span>{t('今日盈亏')}</span><span /></div>{assetRows.map(({ asset, changeToday, pnlToday }) => <button type="button" className="account-page-asset-row" key={asset.id} onClick={() => onSelectAsset(asset)} aria-label={`查看${asset.symbol}在当前账户中的详情`}>
        <span className="account-page-asset-name"><Avatar src={asset.icon} name={asset.symbol} size={30} company={asset.category === '股票'} /><span><strong title={asset.symbol}>{asset.symbol}</strong>{isBinance && <small className="account-page-provenance">{[...new Set(asset.positions.map(position => sourceAccounts.find(account => account.id === position.accountId)?.name).filter(Boolean))].join(' / ')}</small>}</span></span>
        <span className="account-page-asset-quantity numeric"><small>{t('数量')}</small>{formatQuantity(holdingQuantity(asset), hidden)}</span>
        <span className="account-page-asset-price numeric"><small>{t('单价')}</small>{asset.usdPrice === null ? <Unavailable hidden={hidden} reason={t('尚未取得此资产的有效价格。')} /> : formatHoldingPrice(asset, currency, hidden)}</span>
        <span className="account-page-asset-value numeric"><small>{t('估值')}</small>{asset.usdPrice === null ? <Unavailable hidden={hidden} reason={asset.fxPending ? '缺少有效汇率，暂时无法折算估值。' : '缺少有效价格，数量保留，暂未计入估值。'} /> : money(holdingValueCents(asset))}</span>
        <span className="account-page-asset-change"><small>{t('今日涨跌')}</small>{changeToday === null ? <Unavailable hidden={hidden} reason={t('缺少今日参考价或有效报价，暂时无法计算涨跌幅。')} /> : <Trend value={changeToday} hidden={hidden} />}</span>
        <span className="account-page-asset-today-pnl"><small>{t('今日盈亏')}</small><SignedAmount value={pnlToday} currency={currency} hidden={hidden} /></span><ChevronRight size={15} />
      </button>)}</div> : <div className="account-page-empty"><Wallet size={23} /><h3>{t('此范围暂无可展示的资产明细')}</h3></div>}
    </Panel>
    {(!isBinance || positions.length > 0 || selectedGroup === '合约') && <Panel title={t('合约持仓')} className="account-page-contracts" action={<span className="account-page-caption">{positions.length} {t('笔')}</span>}>
      {positions.length ? <><div className="account-page-contract-summary"><span>{t('仓位金额')} <strong className="numeric">{money(contractTotals.notionalCents)}</strong></span><span>{t('已知占用保证金')} <strong className="numeric">{money(contractTotals.knownMarginCents)}</strong></span>{contractTotals.marginMissingCount > 0 && <IssueHint message={`${contractTotals.marginMissingCount}笔持仓的保证金暂不可单独拆分，仅显示已知部分。`} />}</div><ContractsList items={positions} currency={currency} hidden={hidden} onSelect={onSelectContract} /></> : <div className="account-page-empty account-page-empty-short"><h3>{balances.some(account => account.kind === '合约账户' && account.status !== 'ok') ? '尚未取得完整合约持仓' : '已读范围内没有合约持仓'}</h3></div>}
    </Panel>}
  </div>
}
