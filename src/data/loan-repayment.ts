export const repaymentMethods = ['等额本息', '等额本金'] as const
export type Repayment = { method: (typeof repaymentMethods)[number]; annualRate: number; months: number; day: number }

const cents = (value: number) => Math.round(value * 100) / 100

// amount/months 是「剩余本金」和「剩余期数」，所以贷款还到一半也能算。
// shortcut: 按月利率整月计息，银行按日计息、利率浮动会差几块钱，需要精确时再接入还款计划表。
export function monthlyDue(amount: number, plan: Repayment) {
  const n = plan.months, r = plan.annualRate / 1200
  if (plan.method === '等额本金') {
    const principal = amount / n
    return { first: cents(principal + amount * r), last: cents(principal + principal * r), step: cents(principal * r) }
  }
  const payment = r === 0 ? amount / n : amount * r * (1 + r) ** n / ((1 + r) ** n - 1)
  return { first: cents(payment), last: cents(payment), step: 0 }
}

// 还款日大于当月天数时按当月最后一天（如 31 日在 2 月）；今天就是还款日算「下次」。
export function nextDueDate(day: number, today = new Date()) {
  const at = (year: number, month: number) => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate()))
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const thisMonth = at(start.getFullYear(), start.getMonth())
  return thisMonth >= start ? thisMonth : at(start.getFullYear(), start.getMonth() + 1)
}
