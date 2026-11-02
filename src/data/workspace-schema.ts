import { repaymentMethods } from './loan-repayment.ts'
import type { Repayment } from './loan-repayment.ts'
export type AssetMarket = 'crypto' | 'cn' | 'us' | 'cash' | 'other'
export type ManualAccount = { id: string; name: string; icon?: string; updatedAt: string }
export const liabilityKinds = ['房贷', '车贷', '信用卡欠款', '其他借款'] as const
export type Liability = { id: string; name: string; kind: (typeof liabilityKinds)[number]; amount: number; currency: 'USD' | 'CNY'; note: string; settled: boolean; updatedAt: string; repayment?: Repayment }
export type ManualAsset = { id: string; symbol: string; name: string; market: AssetMarket; accountId: string; quantity: number; price: number | null; currency: 'USD' | 'CNY'; icon: string; updatedAt: string }
export type AssetCustomization = { mode: 'auto' | 'manual'; price: number | null; currency: 'USD' | 'CNY'; icon?: string; updatedAt: string; priceUpdatedAt?: string }
export type CostBasis = { averagePrice: number; currency: 'USD' | 'CNY'; quantity: number; feeIncluded: boolean; updatedAt: string }
// 兼容旧版已保存的资产照片，移除页面后仍保留原资料，不再新增。
export type PortfolioSnapshot = { id: string; at: string; totalValueCents: number; unpricedCount: number; assets: { id: string; symbol: string; name: string; market: AssetMarket; quantity: number; usdPrice: number | null; valueCents: number | null; positions?: { accountId: string; quantity: number }[] }[]; accounts: { id: string; name: string; valueCents: number }[] }
export type PortfolioChange = { id: string; at: string; action: string; assetName: string }
export type WorkspaceData = { avatar?: string; username?: string; manualAccounts?: ManualAccount[]; manualAssets: ManualAsset[]; customizations: Record<string, AssetCustomization>; costs?: Record<string, Record<string, CostBasis>>; liabilities?: Liability[]; contractFunding?: Record<string, string>; contractNet?: Record<string, string>; snapshots: PortfolioSnapshot[]; changes: PortfolioChange[] }
export const WORKSPACE_KEY = 'personal-investment-dashboard.workspace.v1'
export const emptyWorkspace = (): WorkspaceData => ({ manualAssets: [], customizations: {}, snapshots: [], changes: [] })
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 100): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12
const market = (value: unknown): value is AssetMarket => value === 'crypto' || value === 'cn' || value === 'us' || value === 'cash' || value === 'other'
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const cents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

function validRepayment(debt: Record<string, unknown>) {
  const plan = debt.repayment
  if (plan === undefined) return true
  return debt.kind !== '信用卡欠款' && object(plan) && repaymentMethods.includes(plan.method as Repayment['method']) && typeof plan.annualRate === 'number' && plan.annualRate >= 0 && plan.annualRate <= 100 && Number.isInteger(plan.months) && (plan.months as number) >= 1 && (plan.months as number) <= 600 && Number.isInteger(plan.day) && (plan.day as number) >= 1 && (plan.day as number) <= 31
}

// 登录名和头像下方的显示名共用：2–32 位文字（含中文）、数字、下划线、点或短横线。
export const validUsername = (value: unknown): value is string => typeof value === 'string' && /^[\p{L}\p{N}_.-]{2,32}$/u.test(value.trim())

export function validIcon(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^\/icons\/[a-zA-Z0-9_.-]+$/.test(value) || (value.length <= 1_400_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)))
}

export function validateWorkspace(value: unknown): value is WorkspaceData {
  if (!object(value) || !Array.isArray(value.manualAssets) || value.manualAssets.length > 200 || !object(value.customizations) || Object.keys(value.customizations).length > 500 || !Array.isArray(value.snapshots) || value.snapshots.length > 100 || !Array.isArray(value.changes) || value.changes.length > 500) return false
  if (value.avatar !== undefined && !validIcon(value.avatar)) return false
  if (value.username !== undefined && !validUsername(value.username)) return false
  const ids = new Set<string>()
  if (value.manualAccounts !== undefined) {
    if (!Array.isArray(value.manualAccounts) || value.manualAccounts.length > 100) return false
    const names = new Set<string>()
    for (const account of value.manualAccounts) {
      if (!object(account) || typeof account.id !== 'string' || !/^manual-account-[0-9a-f-]{36}$/.test(account.id) || ids.has(account.id) || !text(account.name, 80) || account.name !== account.name.trim() || names.has(account.name) || !date(account.updatedAt) || (account.icon !== undefined && !validIcon(account.icon))) return false
      ids.add(account.id); names.add(account.name)
    }
  }
  if (value.liabilities !== undefined) {
    if (!Array.isArray(value.liabilities) || value.liabilities.length > 200) return false
    let total = 0
    for (const debt of value.liabilities) {
      if (!object(debt) || !text(debt.id) || !debt.id.startsWith('liability-') || ids.has(debt.id) || !text(debt.name, 80) || !liabilityKinds.includes(debt.kind as Liability['kind']) || !number(debt.amount) || (debt.currency !== 'USD' && debt.currency !== 'CNY') || typeof debt.note !== 'string' || debt.note.length > 500 || !validRepayment(debt) || typeof debt.settled !== 'boolean' || (debt.settled && debt.amount !== 0) || !date(debt.updatedAt)) return false
      total += Math.round(debt.amount * 100)
      if (!Number.isSafeInteger(total)) return false
      ids.add(debt.id)
    }
  }
  for (const asset of value.manualAssets) {
    if (!object(asset) || !text(asset.id) || !asset.id.startsWith('manual-') || ids.has(asset.id) || !text(asset.symbol, 24) || !text(asset.name, 80) || !market(asset.market) || !text(asset.accountId) || !number(asset.quantity) || !(asset.price === null || number(asset.price)) || (asset.currency !== 'USD' && asset.currency !== 'CNY') || !validIcon(asset.icon) || !date(asset.updatedAt)) return false
    if (asset.price !== null && !Number.isSafeInteger(Math.round(asset.quantity * asset.price * 100))) return false
    if (asset.market === 'cash' && (asset.price !== 1 || asset.symbol !== asset.currency)) return false
    ids.add(asset.id)
  }
  for (const [id, entry] of Object.entries(value.customizations)) {
    if (!text(id) || !object(entry) || (entry.mode !== 'auto' && entry.mode !== 'manual') || !(entry.price === null || number(entry.price)) || (entry.currency !== 'USD' && entry.currency !== 'CNY') || (entry.icon !== undefined && !validIcon(entry.icon)) || !date(entry.updatedAt) || (entry.priceUpdatedAt !== undefined && !date(entry.priceUpdatedAt))) return false
  }
  if (value.costs !== undefined) {
    if (!object(value.costs) || Object.keys(value.costs).length > 500) return false
    let count = 0, total = 0
    for (const [assetId, entries] of Object.entries(value.costs)) {
      if (!text(assetId) || !object(entries)) return false
      for (const [accountId, entry] of Object.entries(entries)) {
        if (++count > 1000 || !text(accountId) || !object(entry) || !number(entry.averagePrice) || !number(entry.quantity) || (entry.currency !== 'USD' && entry.currency !== 'CNY') || typeof entry.feeIncluded !== 'boolean' || !date(entry.updatedAt)) return false
        const amount = Math.round(entry.averagePrice * entry.quantity * 100)
        total += amount
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) return false
      }
    }
  }
  if (value.contractFunding !== undefined) {
    if (!object(value.contractFunding) || Object.keys(value.contractFunding).length > 200) return false
    for (const [roundId, amount] of Object.entries(value.contractFunding)) if (!text(roundId, 200) || typeof amount !== 'string' || !/^-?\d{1,12}(\.\d{1,8})?$/.test(amount)) return false
  }
  if (value.contractNet !== undefined) {
    if (!object(value.contractNet) || Object.keys(value.contractNet).length > 200) return false
    for (const [roundId, amount] of Object.entries(value.contractNet)) if (!text(roundId, 200) || typeof amount !== 'string' || !/^-?\d{1,12}(\.\d{1,8})?$/.test(amount)) return false
  }
  for (const snapshot of value.snapshots) {
    if (!object(snapshot) || !text(snapshot.id) || !date(snapshot.at) || !cents(snapshot.totalValueCents) || !number(snapshot.unpricedCount) || !Array.isArray(snapshot.assets) || snapshot.assets.length > 1000 || !Array.isArray(snapshot.accounts) || snapshot.accounts.length > 1000) return false
    for (const asset of snapshot.assets) {
      if (!object(asset) || !text(asset.id) || !text(asset.symbol, 24) || !text(asset.name, 80) || !market(asset.market) || !number(asset.quantity) || !(asset.usdPrice === null || number(asset.usdPrice)) || !(asset.valueCents === null || cents(asset.valueCents))) return false
      if (asset.positions !== undefined && (!Array.isArray(asset.positions) || !asset.positions.every(position => object(position) && text(position.accountId) && number(position.quantity)))) return false
    }
    for (const account of snapshot.accounts) if (!object(account) || !text(account.id) || !text(account.name) || !cents(account.valueCents)) return false
  }
  return value.changes.every(change => object(change) && text(change.id) && date(change.at) && text(change.action, 80) && text(change.assetName, 100))
}


// 旧版这些身份只用于固定示例；真实资产使用binance:/evm:或manual-身份。
const retiredDemoAssetIds = new Set(['bitcoin', 'ethereum', 'solana', 'tether', 'rappl', 'moutai', 'binancecoin', 'usdcoin', 'nvidia'])
const retiredDemoChangeIds = new Set(['90cdc43a-88b6-4e90-b52f-0f61994b44e7', 'feef9029-579f-4dbb-bccf-82d136b0eac9', 'dec908aa-0d4d-4709-8d42-aa14d1665c08', '35ec172f-28c9-4e8e-a107-13763195d511', '5988dea0-287a-4635-b330-5117d320ebaf', '44f97aba-8ded-49ad-b867-af8f1c298ed8', '5fea80b9-6604-4822-8346-3b129e59e560', '76d6a6ac-83ff-4d17-b696-9f6d72ac2e68'])
export function removeRetiredDemoData(data: WorkspaceData): WorkspaceData {
  return { ...data,
    ...(data.costs ? { costs: Object.fromEntries(Object.entries(data.costs).filter(([id]) => !retiredDemoAssetIds.has(id))) } : {}),
    customizations: Object.fromEntries(Object.entries(data.customizations).filter(([id]) => !retiredDemoAssetIds.has(id))),
    snapshots: data.snapshots.filter(snapshot => !snapshot.assets.some(asset => retiredDemoAssetIds.has(asset.id))),
    changes: data.changes.filter(change => !retiredDemoChangeIds.has(change.id)),
  }
}
