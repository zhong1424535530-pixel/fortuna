import { t } from '../i18n'
import { toUsd } from '../data/forex'
import Select, { currencyOptions } from './Select'
import { isReal } from '../data/live'
import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import { Banknote, Bitcoin, Building2, ChartNoAxesCombined, ImagePlus, Landmark, Pencil, RefreshCw, Search } from 'lucide-react'
import { accounts, assetSources, assetValueCents, formatMoney, formatHoldingPrice, formatPrice, formatQuantity, holdingCostSummary, holdingQuantity, holdingValueCents, holdings, savePortfolioWorkspace, sortedHoldings, supportsAutoPrice } from '../data/portfolio'
import type { Currency, Holding } from '../data/portfolio'
import { portfolioChange, readIcon, workspace, workspaceError } from '../data/workspace'
import { readCnQuotes } from '../data/cn-quotes'
import type { CnQuote } from '../data/cn-quotes'
import type { AssetCustomization, AssetMarket } from '../data/workspace'
import { Avatar, Button, Modal, Panel, IssueHint, Unavailable } from './ui'
import AssetCosts from './AssetCosts'
import LiabilityManager from './LiabilityManager'
import '../asset-manager.css'

const markets: Record<AssetMarket, string> = { crypto: '加密资产', cn: 'A股', us: '美股', cash: '现金余额', other: '其他资产（房产等）' }
const marketIcons = { crypto: <Bitcoin size={18} />, cn: <ChartNoAxesCombined size={18} />, us: <ChartNoAxesCombined size={18} />, cash: <Banknote size={18} />, other: <Building2 size={18} /> }
const tabs = ['手动资产', '负债管理', '价格管理', '成本管理', '图标管理'] as const
const initialForm = { name: '', symbol: '', market: 'crypto' as AssetMarket, accountId: 'manual', quantity: '', price: '', cost: '', currency: 'USD' as Currency, icon: '' }

function numberInput(value: string, optional = false) {
  if (!value.trim()) {
    if (optional) return null
    throw new Error(t('请填写持有数量。'))
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1e12) throw new Error(t('数量和价格需要是 0 到 1 万亿之间的数字。'))
  return number
}

function checkValue(quantity: number, price: number | null, currency: Currency, previousCents = 0) {
  if (price === null) return
  const usd = toUsd(quantity * price, currency)
  const cents = usd === null ? null : Math.round(usd * 100)
  if (!Number.isSafeInteger(Math.round(quantity * price * 100)) || cents !== null && (!Number.isSafeInteger(cents) || !Number.isSafeInteger(assetValueCents - previousCents + cents))) throw new Error(t('这组数量和价格过大，请核对后再保存。'))
}

// 所属账户按来源分组并带上来源图标，手动账户排最前，方便在众多链和子账户里找到。
const accountGroupOrder = ['手动账户', '交易所', '链上钱包', '券商'] as const
function accountOptions() {
  const rest = accountGroupOrder.flatMap(group => assetSources.filter(source => source.group === group).flatMap(source => accounts
    .filter(account => source.accountIds.includes(account.id) && account.id !== 'manual' && !(account.kind === '手动账户' && account.name === '手动账户'))
    .map(account => ({ value: account.id, label: account.name, icon: source.icon, group }))))
  return [{ value: 'manual', label: '手动账户', icon: <Landmark size={18} />, group: '手动账户' }, ...rest.filter(option => option.group === '手动账户'), ...rest.filter(option => option.group !== '手动账户')]
}
const timeText = (iso: string, short = false) => new Date(iso).toLocaleString('zh-CN', short ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : undefined)
// 同代码资产（如不同链的 USDC）靠名称区分，弹窗标题也要带上。
const assetLabel = (asset: Holding) => asset.name && asset.name !== asset.symbol ? `${asset.symbol}（${asset.name}）` : asset.symbol

function priceNote(asset: Holding) {
  const custom = workspace.customizations[asset.id]
  if (asset.market === 'cash') return '现金余额'
  if (asset.manualPrice) return custom ? `手动价 · ${timeText(custom.priceUpdatedAt ?? custom.updatedAt)}` : '手动价'
  if (!isReal() && !asset.manual) return '示例价'
  const at = asset.priceUpdatedAt ? ` · ${timeText(asset.priceUpdatedAt, true)}` : ''
  if (asset.source === '跟随已接入行情') return `自动行情${at} · 跟随已接入账户`
  if (!supportsAutoPrice(asset.market)) return '手动价'
  if (asset.manual && !asset.priceUpdatedAt) return asset.market === 'cn' ? '自动行情读取中' : asset.usdPrice === null ? '暂无价格' : '手动价'
  return `自动行情${at}`
}

export default function AssetManagerPage({ currency, hidden, initialLiabilities = false, displayControls }: { currency: Currency; hidden: boolean; initialLiabilities?: boolean; displayControls: ReactNode }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>(initialLiabilities ? '负债管理' : '手动资产')
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(initialForm)
  // A股：填好6位代码后自动取行情和名称；null 表示正在读取或未取到
  const [cnQuote, setCnQuote] = useState<{ code: string; quote: CnQuote | null } | null>(null)
  useEffect(() => {
    const code = form.symbol.trim()
    if (form.market !== 'cn' || !/^\d{6}$/.test(code)) { setCnQuote(null); return }
    let active = true
    setCnQuote({ code, quote: null })
    void readCnQuotes([code]).then(quotes => {
      if (!active) return
      const quote = quotes[code] ?? null
      setCnQuote({ code, quote })
      if (quote) setForm(current => current.symbol.trim() === code && !current.name.trim() ? { ...current, name: quote.name } : current)
    }).catch(() => { if (active) setCnQuote({ code, quote: null }) })
    return () => { active = false }
  }, [form.market, form.symbol])
  // 错误提示各自贴着出错的位置：添加表单、图标所在行、各个弹窗。
  const [formError, setFormError] = useState('')
  const [iconError, setIconError] = useState<{ assetId: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [quantityAsset, setQuantityAsset] = useState<Holding | null>(null)
  const [quantityAmount, setQuantityAmount] = useState('')
  const [quantityError, setQuantityError] = useState('')
  useEffect(() => { if (hidden) setQuantityAmount('') }, [hidden])
  const [deleteAsset, setDeleteAsset] = useState<Holding | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [priceAsset, setPriceAsset] = useState<Holding | null>(null)
  const [costAsset, setCostAsset] = useState<Holding | null>(null)
  const [priceMode, setPriceMode] = useState<'auto' | 'manual'>('manual')
  const [price, setPrice] = useState('')
  const [priceCurrency, setPriceCurrency] = useState<Currency>('USD')
  const [priceError, setPriceError] = useState('')
  const [pendingIcons, setPendingIcons] = useState<Record<string, string>>({})
  const term = query.trim().toLocaleLowerCase()
  // 价格管理里缺价资产排最前，其余按估值从大到小。
  const ordered = tab === '价格管理' ? [...sortedHoldings].sort((a, b) => Number(b.usdPrice === null) - Number(a.usdPrice === null)) : sortedHoldings
  const visibleAssets = ordered.filter(asset => (tab !== '成本管理' || asset.market !== 'cash') && (!term || `${asset.name} ${asset.symbol}`.toLocaleLowerCase().includes(term)) && (tab !== '手动资产' || asset.manual))
  const fxMissingCount = holdings.filter(asset => asset.fxPending).length
  const missingCount = holdings.filter(asset => asset.usdPrice === null && !asset.fxPending).length
  const priceIssue = [missingCount > 0 && `${missingCount}项资产缺少有效报价，未计入估值。`, fxMissingCount > 0 && `${fxMissingCount}项资产缺少汇率，暂时无法折算估值。`].filter(Boolean).join('')

  const save = async (action: string, assetName: string, changes: Partial<typeof workspace>) => {
    setSaving(true)
    try { await savePortfolioWorkspace({ ...workspace, ...changes, changes: [portfolioChange(action, assetName), ...workspace.changes].slice(0, 500) }) }
    finally { setSaving(false) }
  }

  const addAsset = async (event: FormEvent) => {
    event.preventDefault()
    setFormError('')
    try {
      const name = form.name.trim(), symbol = form.market === 'cash' ? form.currency : form.symbol.trim() || (form.market === 'other' ? name.slice(0, 24) : '')
      if (!name || name.length > 80 || !symbol || symbol.length > 24) throw new Error(t('请填写名称和代码，名称最多 80 字、代码最多 24 字。'))
      if (!Object.hasOwn(markets, form.market) || (form.accountId !== 'manual' && !accounts.some(account => account.id === form.accountId))) throw new Error(t('请选择有效的资产类别和所属账户。'))
      if (holdings.some(asset => asset.symbol.toLocaleLowerCase() === symbol.toLocaleLowerCase() && asset.market === form.market && asset.positions.some(position => position.accountId === form.accountId))) throw new Error(form.market === 'cash' ? '这个账户已有此币种的现金，请在下方修改余额，避免重复计入。' : '这个账户已有同代码、同类别的资产，请在价格管理中补价，避免重复计入。不同链或不同产品请用名称和代码明确区分。')
      if (form.market === 'cn' && !/^\d{6}$/.test(symbol)) throw new Error(t('A股请填写6位股票代码，例如 001309。'))
      const cnPrice = form.market === 'cn' ? cnQuote?.code === symbol ? cnQuote.quote?.price ?? null : null : undefined
      if (form.market === 'other' && !form.price.trim()) throw new Error(t('请填写当前估值，房产、车辆等没有自动价格。'))
      const quantity = numberInput(form.quantity)!, assetPrice = form.market === 'cash' ? 1 : cnPrice !== undefined ? cnPrice : numberInput(form.price, true)
      const assetCurrency = form.market === 'cn' ? 'CNY' : form.currency
      checkValue(quantity, assetPrice, assetCurrency)
      const costPrice = form.market === 'cash' ? null : numberInput(form.cost, true)
      if (costPrice !== null && (costPrice < 0 || costPrice > 1e12 || !Number.isSafeInteger(Math.round(costPrice * quantity * 100)))) throw new Error(t('买入成本价请填写 0 到 1 万亿之间的数字，且总成本不能过大。'))
      const { cost: _cost, ...fields } = form
      const asset = { ...fields, currency: assetCurrency, name, symbol, quantity, price: assetPrice, id: `manual-${crypto.randomUUID()}`, updatedAt: new Date().toISOString() }
      await save('手动添加资产', name, { manualAssets: [...workspace.manualAssets, asset], ...(costPrice === null ? {} : { costs: { ...workspace.costs, [asset.id]: { [form.accountId]: { averagePrice: costPrice, currency: assetCurrency, quantity, feeIncluded: false, updatedAt: asset.updatedAt } } } }) })
      setForm(initialForm); setCnQuote(null)
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : t('保存失败，请保留输入后重试。')) }
  }

  const uploadNewIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true); setFormError('')
    try { const icon = await readIcon(file); setForm(current => ({ ...current, icon })) }
    catch (reason) { setFormError(reason instanceof Error ? reason.message : t('图片读取失败。')) }
    finally { setBusy(false); event.target.value = '' }
  }

  const uploadAssetIcon = async (asset: Holding, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true); setIconError(null)
    try {
      const icon = await readIcon(file)
      setPendingIcons(current => ({ ...current, [asset.id]: icon }))
    } catch (reason) { setIconError({ assetId: asset.id, message: reason instanceof Error ? reason.message : t('图标读取失败，请重新选择图片。') }) }
    finally { setBusy(false); event.target.value = '' }
  }

  const saveIcon = async (asset: Holding) => {
    const icon = pendingIcons[asset.id]
    if (!icon) return
    setIconError(null)
    try {
      const prior = workspace.customizations[asset.id] ?? { mode: 'auto' as const, price: null, currency: 'USD' as const }
      await save('修改资产图标', asset.name, { customizations: { ...workspace.customizations, [asset.id]: { ...prior, icon, updatedAt: new Date().toISOString() } } })
      setPendingIcons(({ [asset.id]: _saved, ...rest }) => rest)
    } catch (reason) { setIconError({ assetId: asset.id, message: reason instanceof Error ? reason.message : t('图标保存失败，所选图片仍保留，可再次保存。') }) }
  }

  const openQuantity = (asset: Holding) => { setQuantityAsset(asset); setQuantityAmount(hidden ? '' : String(holdingQuantity(asset))); setQuantityError('') }

  const openPrice = (asset: Holding) => {
    if (asset.market === 'cash') { openQuantity(asset); return }
    const customization = workspace.customizations[asset.id]
    const original = workspace.manualAssets.find(item => item.id === asset.id)
    const initial = original && original.price !== null ? original : null
    const currentPrice = customization?.mode === 'manual' ? customization.price : initial ? initial.price : asset.usdPrice
    setPriceAsset(asset); setPriceMode(!supportsAutoPrice(asset.market) ? 'manual' : customization?.mode ?? (asset.usdPrice === null ? 'manual' : 'auto')); setPriceCurrency(customization?.mode === 'manual' ? customization.currency : initial?.currency ?? 'USD')
    setPrice(hidden || currentPrice === null ? '' : String(currentPrice)); setPriceError('')
  }

  const saveQuantity = async (event: FormEvent) => {
    event.preventDefault(); setQuantityError('')
    if (!quantityAsset) return
    try {
      const quantity = numberInput(quantityAmount)!
      const entry = workspace.manualAssets.find(asset => asset.id === quantityAsset.id)
      if (!entry) throw new Error(t('这条资产记录已变动，请刷新后核对。'))
      checkValue(quantity, entry.market === 'cash' ? 1 : entry.price, entry.currency, holdingValueCents(quantityAsset))
      await save(entry.market === 'cash' ? '修改现金余额' : '修改资产数量', entry.name, { manualAssets: workspace.manualAssets.map(asset => asset.id === entry.id ? { ...asset, quantity, updatedAt: new Date().toISOString() } : asset) })
      setQuantityAsset(null)
    } catch (reason) { setQuantityError(reason instanceof Error ? reason.message : t('保存失败，输入仍保留。')) }
  }

  const removeAsset = async () => {
    if (!deleteAsset) return
    setDeleteError('')
    try {
      // 价格设置和成本只属于这条资产，一并清掉，否则校验会报“成本对应的资产不存在”。
      const costs = { ...workspace.costs }, customizations = { ...workspace.customizations }
      delete costs[deleteAsset.id]; delete customizations[deleteAsset.id]
      await save('删除手动资产', deleteAsset.name, { manualAssets: workspace.manualAssets.filter(asset => asset.id !== deleteAsset.id), customizations, costs })
      setDeleteAsset(null)
    } catch (reason) { setDeleteError(reason instanceof Error ? reason.message : t('删除失败，原记录保留。')) }
  }

  const savePrice = async (event: FormEvent) => {
    event.preventDefault()
    if (!priceAsset) return
    setPriceError('')
    try {
      // 留空会让资产变成“无价格”而退出估值，所以手动价必须填；要取消手动价请选自动方式。
      if (priceMode === 'manual' && !price.trim()) throw new Error(t('请填写每单位价格；要取消手动价，请把价格方式改成自动。'))
      const newPrice = priceMode === 'manual' ? numberInput(price, true) : null
      const currentAsset = holdings.find(asset => asset.id === priceAsset.id) ?? priceAsset
      checkValue(holdingQuantity(currentAsset), newPrice, priceCurrency, holdingValueCents(currentAsset))
      const customization: AssetCustomization = { ...workspace.customizations[priceAsset.id], mode: priceMode, price: newPrice, currency: priceCurrency, updatedAt: new Date().toISOString(), priceUpdatedAt: new Date().toISOString() }
      await save(priceMode === 'manual' ? '手动修改价格' : '恢复初始价格', priceAsset.name, { customizations: { ...workspace.customizations, [priceAsset.id]: customization } })
      setPriceAsset(null); 
    } catch (reason) { setPriceError(reason instanceof Error ? reason.message : t('保存失败，请保留输入后重试。')) }
  }

  return <div className="asset-manager-page">

    {workspaceError && <p className="asset-manager-error" role="alert">{workspaceError}</p>}
    <div className="asset-manager-toolbar"><nav className="asset-manager-tabs" aria-label={t('资产资料选项')}>{tabs.map(item => <button type="button" key={item} aria-pressed={tab === item} className={tab === item ? 'active' : ''} onClick={() => { setTab(item); setFormError(''); setIconError(null); setQuery('') }}>{item}{item === '价格管理' && priceIssue && <IssueHint message={priceIssue} />}</button>)}</nav>{tab !== '图标管理' && displayControls}</div>

    {tab === '负债管理' ? <LiabilityManager currency={currency} hidden={hidden} /> : <>
    {tab === '手动资产' && <Panel title={t('添加手动资产')}>
      <form className="asset-manager-form" onSubmit={addAsset}><fieldset className="saving-fields" disabled={saving || !!workspaceError}>
        <label>{t('资产名称')}<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder={form.market === 'cash' ? '例如：人民币存款' : form.market === 'other' ? '例如：我的房子' : form.market === 'cn' ? '填写代码后自动带出' : '例如：某条链上的项目代币'} /></label>
        {form.market !== 'cash' && <label>{t('资产代码')}{form.market === 'other' ? '（可选）' : ''}<input required={form.market !== 'other'} maxLength={24} value={form.symbol} onChange={event => setForm({ ...form, symbol: event.target.value })} placeholder={form.market === 'other' ? '留空使用资产名称' : form.market === 'cn' ? '6位股票代码，例如 001309' : '例如 BTC、600519、AAPL'} /></label>}
        <label>{t('资产类别')}<Select label={t('资产类别')} value={form.market} onChange={value => setForm(current => ({ ...current, market: value as AssetMarket, ...(value === 'cash' ? { currency: 'CNY', price: '1' } : value === 'other' ? { currency: 'CNY', quantity: '1', price: '' } : value === 'cn' ? { currency: 'CNY', price: '' } : { currency: 'USD', price: '' }), ...(value !== 'other' && current.market === 'other' ? { quantity: '' } : {}) }))} options={Object.entries(markets).map(([value, name]) => ({ value, label: name, icon: marketIcons[value as AssetMarket] }))} /></label>
        <label>{t('所属账户')}<Select label={t('所属账户')} value={form.accountId} onChange={value => setForm({ ...form, accountId: value })} searchable options={accountOptions()} /></label>
        <label>{form.market === 'cash' ? '余额金额' : '持有数量'}<input required type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={form.quantity} onChange={event => setForm({ ...form, quantity: event.target.value })} placeholder={t('填写数量')} /></label>
        {form.market !== 'cn' && <label>{form.market === 'cash' ? '余额币种' : '价格货币'}<Select label={form.market === 'cash' ? '余额币种' : '价格货币'} value={form.currency} onChange={value => setForm({ ...form, currency: value as Currency })} options={currencyOptions} /></label>}
        {form.market === 'cn' && <p className="asset-manager-quote">{!cnQuote ? '填写6位代码后自动获取价格，之后约每分钟更新。' : !cnQuote.quote ? '正在获取行情…（取不到时保存后会继续自动获取）' : <>{t('现价')} <strong className="numeric">¥{cnQuote.quote.price.toFixed(2)}</strong> {t('· 自动行情')}</>}</p>}
        {form.market !== 'cash' && form.market !== 'cn' && <label>{form.market === 'other' ? '当前估值（每单位）' : '每单位价格'}<input required={form.market === 'other'} type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={form.price} onChange={event => setForm({ ...form, price: event.target.value })} placeholder={form.market === 'us' ? '留空则自动获取行情；取不到时用这里的价格' : form.market === 'crypto' ? '留空则自动获取（跟随已接入账户的同代码币种）' : '房产、车辆等需自己估值，请填写'} /></label>}
        {form.market !== 'cash' && <label>{t('买入成本价（可选，每单位）')}<input type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={form.cost} onChange={event => setForm({ ...form, cost: event.target.value })} placeholder={t('你买入时的单价，用来算盈亏')} /></label>}
        <div className="asset-manager-icon-upload"><Avatar key={form.icon} src={form.icon} name={form.name || '资产'} size={36} /><label className="asset-manager-file"><ImagePlus size={15} aria-hidden />{busy ? '正在读取图片' : '选择资产图标'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('选择新增资产的图标，最大 1 MB')} disabled={busy || saving || !!workspaceError} onChange={uploadNewIcon} /></label><small>{t('PNG / JPEG / WEBP · 最大 1 MB')}</small></div>
        {formError && <p className="asset-manager-error asset-manager-form-error" role="alert">{formError}</p>}
        <div className="asset-manager-form-footer"><Button type="submit" variant="primary" disabled={busy || saving || !!workspaceError}>{saving ? '正在保存' : '保存资产'}</Button></div>
      </fieldset></form>
    </Panel>}
    <Panel title={tab === '手动资产' ? '已添加的手动资产' : tab === '价格管理' ? '资产价格' : tab === '成本管理' ? '持仓成本' : '资产图标'} action={<label className="asset-manager-search"><Search size={14} aria-hidden /><span className="sr-only">{t('搜索资产名称或代码')}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索名称或代码')} /></label>}>
      <div className="asset-manager-list">{visibleAssets.length === 0 ? <div className="asset-manager-empty">{query ? '没有找到匹配的资产。' : '暂无手动资产'}</div> : visibleAssets.map(asset => {
        const cost = holdingCostSummary(asset)
        const priceCell = hidden ? '••••••' : asset.fxPending ? <Unavailable reason={t('缺少有效汇率，暂时无法折算估值。')} /> : asset.usdPrice === null ? <Unavailable reason={asset.market === 'cn' ? '行情读取中，稍后自动更新；也可点击补充价格手动填写。' : supportsAutoPrice(asset.market) ? '暂未取到行情，可点击补充价格手动填写。' : '尚未填写价格，可点击补充价格。'} /> : asset.market === 'cash' ? formatMoney(holdingValueCents(asset), currency) : formatHoldingPrice(asset, currency)
        const pendingIcon = pendingIcons[asset.id]
        const custom = workspace.customizations[asset.id]
        const locked = saving || !!workspaceError
        return <div className="asset-manager-row" key={asset.id}>
        <Avatar key={pendingIcon ?? asset.icon} src={pendingIcon ?? asset.icon} name={asset.symbol} size={34} /><div className="asset-manager-name"><strong>{asset.symbol}</strong><span>{asset.name} · {markets[asset.market]}</span>{(tab === '价格管理' || tab === '手动资产') && <span>{priceNote(asset)}</span>}</div>
        <div className="asset-manager-value numeric">{tab === '图标管理' ? <><strong data-label={t('图标')}>{asset.icon.startsWith('/api/asset-icon?') || asset.icon.startsWith('/icons/') ? '自动匹配' : asset.icon ? '已有图标' : <Unavailable reason={t('未匹配到图标，可点击更换上传。')} />}</strong>{(custom?.icon || asset.icon.startsWith('data:image/')) && <span data-label={t('来源')}>{t('手动上传')}</span>}</> : tab === '手动资产' && asset.market !== 'cash' ? <><strong data-label={t('成本价')}>{hidden ? '••••••' : cost.averageUsdPrice === null ? <Unavailable reason={cost.pendingFx ? '缺少有效汇率。' : '尚未填写成本，可在「成本管理」里填写。'} /> : formatPrice(cost.averageUsdPrice, currency, hidden)}</strong><strong data-label={t('现价')}>{priceCell}</strong><span data-label={t('持仓数量')}>{formatQuantity(holdingQuantity(asset), hidden)}</span></> : tab === '成本管理' ? <><strong data-label={t('平均买入价')}>{hidden ? '••••••' : cost.averageUsdPrice === null ? <Unavailable reason={cost.pendingFx ? '缺少有效汇率。' : '尚未填写或确认完整的持仓成本。'} /> : formatPrice(cost.averageUsdPrice, currency, hidden)}</strong><span data-label={t('已填账户')}>{asset.positions.length - cost.missingCount}/{asset.positions.length} {t('个账户')}</span></> : <><strong data-label={asset.market === 'cash' ? '折合' : '现价'}>{priceCell}</strong><span data-label={asset.market === 'cash' ? '余额' : '持仓数量'}>{formatQuantity(holdingQuantity(asset), hidden)}{asset.market === 'cash' && ` ${asset.symbol}`}</span></>}</div>
        <div className="asset-manager-actions">{tab === '成本管理' ? <Button onClick={() => setCostAsset(asset)}>{t('管理成本')}</Button> : tab === '图标管理' ? pendingIcon ? <Button variant="primary" disabled={busy || locked} onClick={() => saveIcon(asset)}>{t('保存图标')}</Button> : <label className={`asset-manager-file small ${busy || workspaceError ? 'disabled' : ''}`}><ImagePlus size={14} aria-hidden />{t('更换')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || locked} aria-label={`更换${asset.name}图标，最大 1 MB`} onChange={event => void uploadAssetIcon(asset, event)} /></label> : tab === '手动资产' ? <>
          <Button disabled={locked} onClick={() => openQuantity(asset)}>{asset.market === 'cash' ? '修改余额' : '修改数量'}</Button>
          {asset.market !== 'cash' && <Button disabled={locked} onClick={() => openPrice(asset)}>{asset.usdPrice === null ? '补充价格' : '修改价格'}</Button>}
          <Button disabled={locked} onClick={() => { setDeleteAsset(asset); setDeleteError('') }}>{t('删除')}</Button>
        </> : <Button disabled={locked} onClick={() => openPrice(asset)}>{asset.market === 'cash' ? '修改余额' : asset.usdPrice === null ? '补充价格' : '修改价格'}</Button>}</div>
        {iconError?.assetId === asset.id && <p className="asset-manager-error asset-manager-row-error" role="alert">{iconError.message}</p>}
      </div>})}</div>
    </Panel>
    <Modal open={quantityAsset !== null} onClose={() => { if (!saving) setQuantityAsset(null) }} title={`${quantityAsset ? assetLabel(quantityAsset) : ''} · ${quantityAsset?.market === 'cash' ? '修改余额' : '修改数量'}`}>
      <form className="asset-manager-price-form" onSubmit={event => void saveQuantity(event)}><fieldset className="saving-fields" disabled={saving || !!workspaceError}><label>{quantityAsset?.market === 'cash' ? '当前余额' : '持有数量'}<input required type="number" min="0" max="1000000000000" step={quantityAsset?.market === 'cash' ? '0.01' : 'any'} inputMode="decimal" value={quantityAmount} onChange={event => setQuantityAmount(event.target.value)} placeholder={hidden ? '数量已隐藏，请填写新数量' : '填写当前数量'} /></label>{quantityAsset && quantityAsset.market !== 'cash' && workspace.costs?.[quantityAsset.id] && <p className="asset-manager-price-hint">{t('修改数量后，这项资产的持仓成本需要重新确认。')}</p>}{quantityError && <p className="asset-manager-error" role="alert">{quantityError}</p>}<Button type="submit" variant="primary">{saving ? '正在保存' : '保存'}</Button></fieldset></form>
    </Modal>
    <Modal open={deleteAsset !== null} onClose={() => { if (!saving) setDeleteAsset(null) }} title={`删除${deleteAsset ? assetLabel(deleteAsset) : ''}？`} description={t('这项资产及其价格设置、成本记录会一并删除，无法恢复。')}>
      <div className="asset-manager-price-form">{deleteError && <p className="asset-manager-error" role="alert">{deleteError}</p>}<div className="asset-manager-dialog-actions"><Button disabled={saving} onClick={() => setDeleteAsset(null)}>{t('取消')}</Button><Button variant="primary" disabled={saving || !!workspaceError} onClick={() => void removeAsset()}>{saving ? '正在删除' : '确认删除'}</Button></div></div>
    </Modal>
    <Modal open={priceAsset !== null} onClose={() => setPriceAsset(null)} title={`${priceAsset ? assetLabel(priceAsset) : ''} 价格设置`}>
      <form className="asset-manager-price-form" onSubmit={savePrice}><fieldset className="saving-fields" disabled={saving || !!workspaceError}>
        {priceAsset && supportsAutoPrice(priceAsset.market) && <label>{t('价格方式')}<Select label={t('价格方式')} value={priceMode} onChange={value => setPriceMode(value as 'auto' | 'manual')} options={[{ value: 'auto', label: '使用自动行情', icon: <RefreshCw size={18} /> }, { value: 'manual', label: '手动填写价格', icon: <Pencil size={18} /> }]} /></label>}
        {priceMode === 'manual' ? <><label>{t('每单位价格')}<input required type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} placeholder={hidden ? '价格已隐藏，请填写新价格' : '填写每单位价格'} /></label><label>{t('价格货币')}<Select label={t('价格货币')} value={priceCurrency} onChange={value => setPriceCurrency(value as Currency)} options={currencyOptions} /></label></> : null}
        {priceError && <p className="asset-manager-error" role="alert">{priceError}</p>}
        <Button type="submit" variant="primary" disabled={saving || !!workspaceError}>{saving ? '正在保存' : '保存价格设置'}</Button>
      </fieldset></form>
    </Modal>
    <Modal open={costAsset !== null} onClose={() => setCostAsset(null)} title={`${costAsset ? assetLabel(costAsset) : ''} · 成本管理`}>
      {costAsset && <div className="cost-dialog-content"><AssetCosts key={costAsset.id} asset={holdings.find(asset => asset.id === costAsset.id) ?? costAsset} currency={currency} hidden={hidden} /></div>}
    </Modal>
    </>}
  </div>
}
