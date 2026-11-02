import { t } from '../i18n'
import Select, { currencyOptions } from './Select'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { accounts, formatMoney, formatNativePrice, formatPrice, formatQuantity, holdingCostSummary, positionCostBasis, savePortfolioWorkspace } from '../data/portfolio'
import type { Currency, Holding, Position } from '../data/portfolio'
import { portfolioChange, workspace, workspaceError } from '../data/workspace'
import type { CostBasis } from '../data/workspace'
import { Avatar, Button, SignedAmount, IssueHint, Unavailable } from './ui'
import '../asset-costs.css'

export default function AssetCosts({ asset, currency, hidden }: { asset: Holding; currency: Currency; hidden: boolean }) {
  const [accountId, setAccountId] = useState<string | null>(null)
  const [price, setPrice] = useState('')
  const [costCurrency, setCostCurrency] = useState<Currency>('USD')
  const [feeIncluded, setFeeIncluded] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => { if (accountId) formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }, [accountId])
  useEffect(() => { if (hidden) setPrice('') }, [hidden])
  const summary = holdingCostSummary(asset)
  const editingPosition = asset.positions.find(position => position.accountId === accountId)
  const editingAccount = accounts.find(account => account.id === accountId)
  const storedEntry = accountId ? workspace.costs?.[asset.id]?.[accountId] : undefined
  const money = (value: number | null) => hidden ? '••••••' : value === null ? <Unavailable reason={summary.pendingFx ? '缺少有效汇率，无法折算成本。' : '部分账户尚未填写或需重新确认成本。'} /> : formatMoney(value, currency)

  const edit = (position: Position) => {
    const entry = workspace.costs?.[asset.id]?.[position.accountId]
    setAccountId(position.accountId)
    setPrice(hidden || !entry ? '' : String(entry.averagePrice))
    setCostCurrency(entry?.currency ?? (asset.market === 'cn' ? 'CNY' : 'USD'))
    setFeeIncluded(entry?.feeIncluded ?? false)
    setError(''); 
  }

  const save = async (clear = false) => {
    if (!editingPosition) return
    setError(''); setSaving(true)
    try {
      const entries = { ...workspace.costs?.[asset.id] }
      if (clear) delete entries[editingPosition.accountId]
      else {
        if (!price.trim()) throw new Error(t('请填写每枚或每股的平均买入价；免费取得可填 0。'))
        const averagePrice = Number(price)
        if (!Number.isFinite(averagePrice) || averagePrice < 0 || averagePrice > 1e12) throw new Error(t('平均买入价需要是 0 到 1 万亿之间的数字。'))
        const entry: CostBasis = { averagePrice, currency: costCurrency, quantity: editingPosition.quantity, feeIncluded, updatedAt: new Date().toISOString() }
        entries[editingPosition.accountId] = entry
      }
      const costs = { ...workspace.costs }
      if (Object.keys(entries).length) costs[asset.id] = entries
      else delete costs[asset.id]
      await savePortfolioWorkspace({ ...workspace, costs, changes: [portfolioChange(clear ? '清除手动成本' : '填写手动成本', `${asset.symbol} · ${editingAccount?.name ?? accountId}`), ...workspace.changes].slice(0, 500) }, 'cost')
      setAccountId(null); setPrice('')

    } catch (reason) { setError(reason instanceof Error ? reason.message : t('成本保存失败，请保留当前输入。')) }
    finally { setSaving(false) }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); save() }

  return <section className="asset-costs" aria-label={`${asset.symbol}持仓成本`}>
    <div className="cost-section-heading"><h3>{t('持仓成本')}</h3><span>{asset.positions.length - summary.missingCount} / {asset.positions.length} {t('个账户已填写')}{summary.missingCount > 0 && <IssueHint message={`${summary.missingCount}个账户未填写或需重新确认成本，暂不计算整体成本与浮盈亏。`} />}</span></div>

    <div className="cost-summary">
      <div><span>{t('平均买入价')}</span><strong className="numeric">{hidden ? '••••••' : summary.averageUsdPrice === null ? <Unavailable reason={summary.pendingFx ? '缺少有效汇率。' : '部分账户尚未填写或需重新确认买入价。'} /> : formatPrice(summary.averageUsdPrice, currency)}</strong></div>
      <div><span>{t('持仓成本合计')}</span><strong className="numeric">{money(summary.costCents)}</strong></div>
      <div><span>{t('参考浮动盈亏')}</span><strong>{summary.pnlCents === null ? <Unavailable hidden={hidden} reason={summary.costCents === null ? '当前持仓成本尚未填齐，暂不计算浮动盈亏。' : '缺少现价，暂不计算浮动盈亏。'} /> : <SignedAmount value={summary.pnlCents} currency={currency} hidden={hidden} />}</strong></div>
    </div>

    <div className="cost-account-list">{asset.positions.map(position => {
      const account = accounts.find(item => item.id === position.accountId)!
      const entry = positionCostBasis(asset, position)
      const prior = workspace.costs?.[asset.id]?.[position.accountId]
      return <div className="cost-account-row" key={position.accountId}>
        <Avatar src={account.icon} name={account.name} size={27} />
        <div className="cost-account-name"><strong>{account.name}</strong><span>{formatQuantity(position.quantity, hidden)} {asset.symbol}</span></div>
        <div className="cost-account-price"><strong className="numeric">{entry ? formatNativePrice(entry.averagePrice, entry.currency, currency, hidden) : <Unavailable hidden={hidden} reason={prior ? '持仓数量已变化，请重新确认当前持仓的平均买入价。' : '此账户尚未填写当前持仓的平均买入价。'} />}</strong>{entry && <small>{entry.feeIncluded ? '含买入手续费' : '未含买入手续费'}</small>}{entry && <time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString('zh-CN')}</time>}</div>
        <Button disabled={saving || !!workspaceError} aria-label={`${prior ? '修改' : '填写'}${account.name}的${asset.symbol}成本`} onClick={() => edit(position)}>{prior ? '修改成本' : '填写成本'}</Button>
      </div>
    })}</div>
    {editingPosition && <form ref={formRef} className="cost-entry-form" onSubmit={submit}><fieldset className="saving-fields" disabled={saving || !!workspaceError}>
      <div className="cost-entry-heading"><h4>{editingAccount?.name} · {asset.symbol}</h4><span>{formatQuantity(editingPosition.quantity, hidden)} {asset.symbol}</span></div>
      <label>{t('平均买入价')}<input required type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} placeholder={hidden ? '成本已隐藏，请填写新的平均单价' : '每枚或每股的平均单价'} /></label>
      <label>{t('成本计价货币')}<Select label={t('成本计价货币')} value={costCurrency} onChange={value => setCostCurrency(value as Currency)} options={currencyOptions} /></label>
      <label className="cost-fee-option"><input type="checkbox" checked={feeIncluded} onChange={event => setFeeIncluded(event.target.checked)} />{t('填写的平均单价已包含买入手续费')}</label>
      <div className="cost-entry-actions"><Button onClick={() => { setAccountId(null); setError('') }}>{t('取消')}</Button>{storedEntry && <Button disabled={saving || !!workspaceError} onClick={() => save(true)}>{t('清除此账户成本')}</Button>}<Button type="submit" variant="primary" disabled={saving || !!workspaceError}>{saving ? '正在保存' : '保存成本'}</Button></div>
    </fieldset></form>}
    {(error || workspaceError) && <p className="cost-error" role="alert">{error || workspaceError}</p>}

    
  </section>
}
