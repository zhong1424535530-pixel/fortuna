import type { Transaction } from './transactions.ts'

export const futuresRewardLabels = new Map([
  ['COMMISSION_REBATE', '邀请人返佣'],
  ['REFERRAL_KICKBACK', '受邀人返现'],
  ['API_REBATE', '合作返佣'],
  ['CONTEST_REWARD', '活动奖励'],
  ['BFUSD_REWARD', 'BFUSD奖励'],
  ['WELCOME_BONUS', '新人奖励（可能有使用限制）'],
])

export function isTransactionReward(row: Transaction): boolean {
  return row.type === '奖励' || row.scope === 'usdm' && row.type === '其他收支' && futuresRewardLabels.has(row.note)
}

export function canValueReward(row: Transaction): boolean {
  return row.id.startsWith('binance:') && ['usdm', 'spot-rebate'].includes(row.scope) && isTransactionReward(row) && ['已完成', '已记录'].includes(row.status) && row.note !== 'WELCOME_BONUS'
}

export function rewardUsdtValue(row: Transaction): string | null {
  if (!canValueReward(row)) return null
  return ['USDT', 'USDC'].includes(row.asset) ? row.quantity : row.rewardValuation?.usdtQuantity ?? null
}

export function rewardDescription(row: Transaction): string {
  if (row.note === 'SPOT_COMMISSION_REBATE') return '邀请人返佣'
  if (row.note === 'SPOT_REFERRAL_KICKBACK') return '受邀人返现'
  return futuresRewardLabels.get(row.note) ?? '平台奖励'
}
