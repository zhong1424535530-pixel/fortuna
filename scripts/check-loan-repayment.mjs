import assert from 'node:assert/strict'
import { monthlyDue, nextDueDate } from '../src/data/loan-repayment.ts'
import { validateWorkspace } from '../src/data/workspace-schema.ts'

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.02, `${actual} ≠ ${expected}`)
// 等额本息：100 万、4.2%、240 期，月供固定；下面再用逐期还款到余额归零交叉验证
const equalPayment = monthlyDue(1_000_000, { method: '等额本息', annualRate: 4.2, months: 240, day: 5 })
near(equalPayment.first, 6165.71); assert.equal(equalPayment.first, equalPayment.last); assert.equal(equalPayment.step, 0)
let balance = 1_000_000
for (let month = 0; month < 240; month++) balance = balance * (1 + 0.042 / 12) - equalPayment.first
assert.ok(Math.abs(balance) < 5, `逐期还款后余额应约为 0，实际 ${balance}`)
// 等额本金：100 万、4.2%、240 期，首月 4166.67 + 3500 = 7666.67，每月递减 4166.67×0.0035
const equalPrincipal = monthlyDue(1_000_000, { method: '等额本金', annualRate: 4.2, months: 240, day: 5 })
near(equalPrincipal.first, 7666.67); near(equalPrincipal.step, 14.58); near(equalPrincipal.last, 4166.67 + 14.58)
// 零利率按本金平均
near(monthlyDue(1200, { method: '等额本息', annualRate: 0, months: 12, day: 1 }).first, 100)
// 还款日：今天算下次；已过则下月；31 日遇 2 月取月末
assert.equal(nextDueDate(29, new Date(2026, 9, 29)).getDate(), 29)
assert.equal(nextDueDate(5, new Date(2026, 9, 29)).getMonth(), 10)
assert.equal(nextDueDate(31, new Date(2027, 1, 10)).getDate(), 28)
assert.equal(nextDueDate(5, new Date(2026, 11, 20)).getFullYear(), 2027)

const base = { manualAssets: [], customizations: {}, snapshots: [], changes: [] }
const debt = extra => ({ ...base, liabilities: [{ id: 'liability-a', name: '房贷', kind: '房贷', amount: 1, currency: 'CNY', note: '', settled: false, updatedAt: '2026-10-29T00:00:00.000Z', ...extra }] })
const plan = { method: '等额本息', annualRate: 4.2, months: 240, day: 5 }
assert.equal(validateWorkspace(debt({ repayment: plan })), true)
assert.equal(validateWorkspace(debt({})), true)
assert.equal(validateWorkspace(debt({ repayment: { ...plan, method: '随便' } })), false)
assert.equal(validateWorkspace(debt({ repayment: { ...plan, day: 32 } })), false)
assert.equal(validateWorkspace(debt({ repayment: { ...plan, months: 0 } })), false)
assert.equal(validateWorkspace(debt({ repayment: { ...plan, annualRate: -1 } })), false)
assert.equal(validateWorkspace(debt({ kind: '信用卡欠款', repayment: plan })), false)
console.log('房贷月供、还款日与负债校验断言通过。')
