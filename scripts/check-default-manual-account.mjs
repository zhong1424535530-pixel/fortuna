// 只用内存里的假资料，不读写本机资料文件。
import assert from 'node:assert/strict'
import { adoptDefaultManualAccount, emptyWorkspace, validateWorkspace } from '../src/data/workspace.ts'

const at = '2026-10-26T00:00:00.000Z'
const asset = (id, accountId) => ({ id, symbol: 'CAR', name: '车辆', market: 'other', accountId, quantity: 1, price: 42000, currency: 'CNY', icon: '', updatedAt: at })
const cost = averagePrice => ({ averagePrice, currency: 'CNY', quantity: 1, feeIncluded: false, updatedAt: at })
const base = { ...emptyWorkspace(), manualAssets: [asset('manual-a', 'manual')], costs: { 'manual-a': { manual: cost(40000) } }, snapshots: [], changes: [] }

// 没用到默认分组时原样返回
const untouched = { ...emptyWorkspace(), manualAssets: [] }
assert.equal(adoptDefaultManualAccount(untouched), untouched)

// 新建"手动账户"，资产和成本一起搬过去，资料仍能通过保存校验
const adopted = adoptDefaultManualAccount(base)
assert.equal(adopted.manualAccounts.length, 1)
const [account] = adopted.manualAccounts
assert.equal(account.name, '手动账户')
assert.match(account.id, /^manual-account-[0-9a-f-]{36}$/)
assert.equal(adopted.manualAssets[0].accountId, account.id)
assert.deepEqual(adopted.costs['manual-a'], { [account.id]: cost(40000) })
assert.equal(adopted.manualAssets[0].quantity, 1)
assert.equal(adopted.manualAssets[0].price, 42000)
assert.ok(validateWorkspace(adopted))
assert.equal(adoptDefaultManualAccount(adopted), adopted, '转换只做一次')

// 已有同名手动账户时并入它，不重复创建；目标账户已有成本时不覆盖
const existing = { id: 'manual-account-00000000-0000-4000-8000-000000000000', name: '手动账户', updatedAt: at }
const merged = adoptDefaultManualAccount({ ...base, manualAccounts: [existing], costs: { 'manual-a': { manual: cost(40000), [existing.id]: cost(41000) } } })
assert.deepEqual(merged.manualAccounts, [existing])
assert.equal(merged.manualAssets[0].accountId, existing.id)
assert.deepEqual(merged.costs['manual-a'], { [existing.id]: cost(41000) })

// 手动账户可带自定义图标，非图片数据会被拒绝
const icon = 'data:image/png;base64,iVBORw0KGgo='
assert.ok(validateWorkspace({ ...emptyWorkspace(), manualAccounts: [{ ...existing, icon }] }))
assert.ok(!validateWorkspace({ ...emptyWorkspace(), manualAccounts: [{ ...existing, icon: 'javascript:alert(1)' }] }))

console.log('默认手动分组转换检查通过。')
