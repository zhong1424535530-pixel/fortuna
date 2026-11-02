import { t } from '../i18n'
import Select, { currencyOptions } from './Select'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Car, CircleCheck, CreditCard, HandCoins, House, Pencil } from 'lucide-react'
import { formatMoney, liabilityValueCents, monthlyRepayment, personalBalance, savePortfolioWorkspace } from '../data/portfolio'
import { monthlyDue, repaymentMethods } from '../data/loan-repayment'
import type { Repayment } from '../data/loan-repayment'
import type { Currency } from '../data/portfolio'
import { liabilityKinds, portfolioChange, workspace, workspaceError } from '../data/workspace'
import type { Liability } from '../data/workspace'
import { Button, Modal, Panel } from './ui'
import '../personal-balance.css'

const debtIcons = { 房贷: <House size={18} />, 车贷: <Car size={18} />, 信用卡欠款: <CreditCard size={18} />, 其他借款: <HandCoins size={18} /> }
const emptyForm = { name: '', kind: '房贷' as Liability['kind'], amount: '', currency: 'CNY' as Currency, note: '', method: '等额本息' as Repayment['method'], rate: '', months: '', day: '' }
const money = (value: number, currency: Currency) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value)
function repaymentText(debt: Liability, hidden: boolean) {
  const plan = debt.repayment!, due = monthlyDue(debt.amount, plan)
  if (hidden) return `${plan.method} · 每月 ${plan.day} 日`
  return plan.method === '等额本息'
    ? `月供 ${money(due.first, debt.currency)} · 每月 ${plan.day} 日`
    : `本月 ${money(due.first, debt.currency)} · 每月递减约 ${money(due.step, debt.currency)} · 每月 ${plan.day} 日`
}
export default function LiabilityManager({ currency, hidden }: { currency: Currency; hidden: boolean }) {
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Liability | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => { if (hidden) setForm(value => ({ ...value, amount: '' })) }, [hidden])
  const repayment = monthlyRepayment()
  const debts = [...(workspace.liabilities ?? [])].sort((a, b) => Number(a.settled) - Number(b.settled) || (liabilityValueCents(b) ?? 0) - (liabilityValueCents(a) ?? 0))
  const persist = async (next: Liability[], action: string, name: string) => {
    await savePortfolioWorkspace({ ...workspace, liabilities: next, changes: [portfolioChange(action, name), ...workspace.changes].slice(0, 500) })
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); 
    try {
      if (!form.name.trim() || !form.amount.trim()) throw new Error(t('请填写负债名称和剩余欠款。'))
      const amount = Number(form.amount)
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new Error(t('剩余欠款请填写0到1万亿之间的金额，不用填负号。'))
      if (editing && !workspace.liabilities?.some(debt => debt.id === editing)) throw new Error(t('这条负债已发生变化，请刷新后核对。'))
      let repayment: Repayment | undefined
      if (form.kind !== '信用卡欠款' && (form.rate.trim() || form.months.trim() || form.day.trim())) {
        const annualRate = Number(form.rate), months = Number(form.months), day = Number(form.day)
        if (!form.rate.trim() || !Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) throw new Error(t('年利率请填写 0 到 100 之间的数字，例如 3.5。'))
        if (!Number.isInteger(months) || months < 1 || months > 600) throw new Error(t('剩余期数请填写 1 到 600 之间的整数（按月）。'))
        if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(t('每月还款日请填写 1 到 31 之间的整数。'))
        repayment = { method: form.method, annualRate, months, day }
      }
      const debt: Liability = { id: editing ?? `liability-${crypto.randomUUID()}`, name: form.name.trim(), kind: form.kind, amount, currency: form.currency, note: form.note.trim(), settled: false, updatedAt: new Date().toISOString(), ...(repayment ? { repayment } : {}) }
      await persist(editing ? workspace.liabilities!.map(item => item.id === editing ? debt : item) : [...(workspace.liabilities ?? []), debt], editing ? '修改负债' : '添加负债', debt.name)
      setForm(emptyForm); setEditing(null); 
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('保存失败，输入仍保留。')) }
    finally { setSaving(false) }
  }
  const settle = async () => {
    if (!confirm) return
    setSaving(true); setError(''); 
    try {
      await persist((workspace.liabilities ?? []).map(item => item.id === confirm.id ? { ...item, amount: 0, settled: true, updatedAt: new Date().toISOString() } : item), '结清负债', confirm.name)
      if (editing === confirm.id) { setEditing(null); setForm(emptyForm) }
      setConfirm(null); 
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('结清保存失败，原记录保留。')) }
    finally { setSaving(false) }
  }
  const edit = (debt: Liability) => {
    setEditing(debt.id); setForm({ name: debt.name, kind: debt.kind, amount: hidden ? '' : String(debt.amount), currency: debt.currency, note: debt.note, method: debt.repayment?.method ?? '等额本息', rate: debt.repayment ? String(debt.repayment.annualRate) : '', months: debt.repayment ? String(debt.repayment.months) : '', day: debt.repayment ? String(debt.repayment.day) : '' }); setError(''); 
    formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  return <div className="liability-manager">
    {error && !confirm && <p role="alert" className="asset-manager-error">{error}</p>}

    <Panel title={editing ? '修改负债' : '添加负债'}>
      <form ref={formRef} className="asset-manager-form" onSubmit={event => void save(event)}><fieldset className="saving-fields" disabled={saving || !!workspaceError}>
        <label>{t('负债名称')}<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder={t('例如：住房贷款')} /></label>
        <label>{t('负债类别')}<Select label={t('负债类别')} value={form.kind} onChange={value => setForm({ ...form, kind: value as Liability['kind'] })} options={liabilityKinds.map(kind => ({ value: kind, label: kind, icon: debtIcons[kind] }))} /></label>
        <label>{t('剩余欠款')}<input required type="number" min="0" max="1000000000000" step="0.01" inputMode="decimal" value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} placeholder={hidden ? '金额已隐藏，请填写当前欠款' : '填写正数，例如800000'} /></label>
        <label>{t('欠款币种')}<Select label={t('欠款币种')} value={form.currency} onChange={value => setForm({ ...form, currency: value as Currency })} options={currencyOptions} /></label>
        {form.kind !== '信用卡欠款' && <>
          <label>{t('还款方式')}<Select label={t('还款方式')} value={form.method} onChange={value => setForm({ ...form, method: value as Repayment['method'] })} options={repaymentMethods.map(method => ({ value: method, label: method }))} /></label>
          <label>{t('年利率（%，可选）')}<input type="number" min="0" max="100" step="0.01" inputMode="decimal" value={form.rate} onChange={event => setForm({ ...form, rate: event.target.value })} placeholder={t('例如 3.5')} /></label>
          <label>{t('剩余期数（月，可选）')}<input type="number" min="1" max="600" step="1" inputMode="numeric" value={form.months} onChange={event => setForm({ ...form, months: event.target.value })} placeholder={t('例如 240')} /></label>
          <label>{t('每月还款日（可选）')}<input type="number" min="1" max="31" step="1" inputMode="numeric" value={form.day} onChange={event => setForm({ ...form, day: event.target.value })} placeholder={t('1 到 31，例如 5')} /></label>
        </>}
        <label className="liability-note-field">{t('备注（可选）')}<textarea rows={2} maxLength={500} value={form.note} onChange={event => setForm({ ...form, note: event.target.value })} placeholder={t('例如：每月还款后更新剩余本金')} /></label>

        <div className="asset-manager-form-footer"><div className="liability-actions">{editing && <Button onClick={() => { setEditing(null); setForm(emptyForm); setError('') }}>{t('取消修改')}</Button>}<Button type="submit" variant="primary">{saving ? '正在保存' : editing ? '保存修改' : '保存负债'}</Button></div></div>
      </fieldset></form>
    </Panel>
    <Panel title={t('我的负债')} action={<span className="liability-total numeric">{t('总负债')} {formatMoney(personalBalance().liabilitiesCents, currency, hidden)}{repayment.count > 0 && <> {t('· 每月应还')} {formatMoney(repayment.cents, currency, hidden)}</>}</span>}>
      <div className="asset-manager-list">{debts.length === 0 ? <p className="asset-manager-empty">{t('还没有添加负债，可在上方填写房贷等剩余欠款。')}</p> : debts.map(debt => <div className="liability-row" key={debt.id}>
        <div className="asset-manager-name"><strong>{debt.name}<span className={debt.settled ? 'liability-settled' : 'liability-kind'}>{debt.settled ? '已结清' : debt.kind}</span></strong>{debt.note && <span>{hidden ? '备注已隐藏' : debt.note}</span>}{debt.repayment && !debt.settled && debt.amount > 0 && <span className="liability-plan">{repaymentText(debt, hidden)}</span>}<time dateTime={debt.updatedAt}>{t('更新于')} {new Date(debt.updatedAt).toLocaleString('zh-CN')}</time></div>
        <div className="asset-manager-value numeric"><strong>{formatMoney(liabilityValueCents(debt), currency, hidden)}</strong><span>{hidden ? '—' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: debt.currency }).format(debt.amount)}</span></div>
        <div className="liability-actions"><Button disabled={saving || !!workspaceError} onClick={() => edit(debt)} aria-label={`修改${debt.name}`}><Pencil size={13} />{t('修改')}</Button>{!debt.settled && <Button disabled={saving || !!workspaceError} onClick={() => { setConfirm(debt); setError('') }} aria-label={`结清${debt.name}`}><CircleCheck size={13} />{t('结清')}</Button>}</div>
      </div>)}</div>
    </Panel>
    <Modal open={confirm !== null} onClose={() => { if (!saving) { setConfirm(null); setError('') } }} title={t('确认这笔负债已结清')} description={t('剩余欠款归零，原记录保留。')}>
      <div className="liability-confirm"><p>{confirm?.name}</p>{error && <p className="asset-manager-error" role="alert">{error}</p>}<div className="liability-actions"><Button disabled={saving} onClick={() => setConfirm(null)}>{t('取消')}</Button><Button disabled={saving} variant="primary" onClick={() => void settle()}>{saving ? '正在保存' : '确认已结清'}</Button></div></div>
    </Modal>
  </div>
}
