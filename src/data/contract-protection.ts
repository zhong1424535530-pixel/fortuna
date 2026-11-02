export type ContractExitOrder = {
  id: string
  kind: '止盈' | '止损' | '移动止损'
  triggerPriceUsd: number | null
  quantity: number | null // null 表示全部平仓。
  triggerBasis: '标记价' | '最新价' | '未知'
}

export function exitOrdersReadState(orders: ContractExitOrder[] | null | undefined, accountStatus?: string) {
  if (orders == null) return 'missing'
  return accountStatus === 'error' || accountStatus === 'pending' ? 'cached' : 'ready'
}

export function validExitOrders(value: unknown): value is ContractExitOrder[] | null | undefined {
  if (value === undefined || value === null) return true
  if (!Array.isArray(value) || value.length > 1000) return false
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1e30
  return value.every(order => order && typeof order.id === 'string' && /^[0-9]{1,30}$/.test(order.id)
    && ['止盈', '止损', '移动止损'].includes(order.kind)
    && (order.triggerPriceUsd === null || positive(order.triggerPriceUsd))
    && (order.kind !== '移动止损' || order.triggerPriceUsd === null)
    && (order.quantity === null || positive(order.quantity))
    && ['标记价', '最新价', '未知'].includes(order.triggerBasis))
    && new Set(value.map(order => order.id)).size === value.length
}
