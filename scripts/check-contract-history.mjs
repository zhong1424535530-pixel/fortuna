// 仅在用户另行同意模拟测试后运行；纯假资料，不读取账户、文件或密钥。
import assert from 'node:assert/strict'
import { isTransactionReward } from '../src/data/transaction-rewards.ts'
import { buildContractHistory } from '../src/data/contract-history.ts'
import { validTransactionState } from '../src/data/transactions.ts'
import { buildTransactionFeed, filterTransactionFeed, transactionCategory } from '../src/data/transaction-feed.ts'
import { valueTransactionFees } from '../server/fee-valuation.mjs'
import { feeInUnit } from '../src/data/fee-valuation.ts'
import { mergeTransactions, createTransactionStore } from '../server/transaction-store.mjs'
import { createConnectionService } from '../server/connection-service.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReturnEntries, closedReturnStats } from '../src/data/returns-analysis.ts'
import { valueRecordedEntries } from '../src/data/returns-period.ts'
import { summarizeTransactions, feesInUsdt, summaryAmount, summarizeCashflow } from '../src/data/transaction-summary.ts'

const start = Date.parse('2026-10-20T00:00:00+08:00'), end = start + 100000
const base = { connectionId: '12345678-1234-1234-1234-123456789abc', connectionName: '模拟账户', identity: 'test', account: 'U本位合约', scope: 'usdm', asset: 'BTC', symbol: 'BTCUSDT', quoteAsset: 'USDT', pnlAsset: 'USDT', status: '已完成', orderId: '1', txHash: '', network: '', address: '', note: '', relatedTradeId: '' }
const fill = (id, type, quantity, price, pnl = '0', side = 'LONG', at = id * 1000) => ({ ...base, id: `binance:test:usdm:BTCUSDT:${id}`, time: start + at, type, quantity, price, quoteQuantity: String(Number(quantity) * Number(price)), realizedPnl: pnl, fees: [{ asset: 'USDT', quantity: '0.1' }], positionSide: side })
const funding = (id, at, quantity) => ({ ...base, id: `binance:test:usdm:income:${id}`, type: '资金费', asset: 'USDT', time: start + at, quantity, price: null, quoteQuantity: null, realizedPnl: null, fees: [] })
function state(records, positions = { LONG: '0', SHORT: '0', BOTH: '0' }) {
  const sync = { connectionId: base.connectionId, connectionName: base.connectionName, identity: base.identity, label: '模拟', status: 'ok', from: start, to: end, at: end, lastSuccess: end, warning: '' }
  return { records, syncs: [
    { ...sync, key: 'usdm:BTCUSDT', coverage: { from: start, to: end, count: records.filter(r => ['买入', '卖出'].includes(r.type)).length }, positionCheck: { at: end, positions: Object.entries(positions).map(([side, quantity]) => ({ side, quantity })) } },
    { ...sync, key: 'income', coverage: { from: start, to: end, count: records.filter(r => r.type === '资金费').length } },
  ] }
}
const rounds = data => buildContractHistory(data).rounds
const complete = state([fill(1, '买入', '1', '100'), fill(2, '卖出', '0.4', '110', '4'), funding(1, 2500, '-1'), fill(3, '卖出', '0.6', '110', '6')])
assert(validTransactionState(complete))
assert.equal(rounds(complete).length, 1)
assert.equal(rounds(complete)[0].netPnl, '8.7')
assert.equal(rounds(complete)[0].roi, null)
assert.equal(rounds(complete)[0].closedQuantity, '1')
assert.equal(rounds(complete)[0].openPrice, '100')
assert.equal(rounds(complete)[0].closePrice, '110')
const unreadFunding = { ...complete, syncs: complete.syncs.map(item => item.key === 'income' ? { ...item, coverage: { from: item.coverage.to, to: item.coverage.to, count: 0 } } : item) }
assert.equal(rounds(unreadFunding)[0].netPnl, null, '资金费没读全时不给最终净盈亏')
const fixed = buildContractHistory(unreadFunding, { [rounds(unreadFunding)[0].id]: '-1' }).rounds[0]
assert.equal(fixed.netPnl, '8.7', '手动补录的资金费让净盈亏可核对')
assert(fixed.fundingManual)
const netFixed = buildContractHistory(unreadFunding, {}, { [rounds(unreadFunding)[0].id]: '7' }).rounds[0]
assert.equal(netFixed.netPnl, '7', '手动补录的整轮净盈亏直接作为净盈亏')
assert(netFixed.netManual && netFixed.status === '已平仓' && !netFixed.warnings.length)
const reward = { ...funding(30, 2400, '0.26456995'), id: 'binance:test:spot-rebate:1', type: '奖励', scope: 'spot-rebate', account: '现货', asset: 'USDC', note: 'SPOT_COMMISSION_REBATE', status: '已记录' }
const futuresReward = { ...funding(31, 2400, '1.5'), type: '奖励', note: 'COMMISSION_REBATE' }
const legacyReward = { ...funding(32, 2400, '3'), type: '其他收支', note: 'WELCOME_BONUS' }
const notReward = { ...funding(33, 2400, '10'), type: '其他收支', note: 'UNKNOWN_INCOME' }
assert(validTransactionState({ records: [reward], syncs: [] }))
assert(isTransactionReward(legacyReward), '旧合约奖励兼容显示')
assert(!isTransactionReward(notReward), '未知正收入不能猜成奖励')
assert(isTransactionReward({ ...legacyReward, note: 'API_REBATE' }))
assert(isTransactionReward({ ...legacyReward, note: 'CONTEST_REWARD' }))
assert(isTransactionReward({ ...legacyReward, note: 'BFUSD_REWARD' }))
const rewarded = { ...complete, records: [...complete.records, reward, futuresReward, legacyReward] }
assert.equal(rounds(rewarded)[0].netPnl, '8.7', '独立奖励不混入合约盈亏和手续费')
const rewardFeed = buildTransactionFeed(rewarded)
assert.equal(rewardFeed.entries.length, 4)
const rewardFilters = { query: '', source: '', type: '', account: '', start: '', end: '' }
assert.equal(filterTransactionFeed(rewardFeed.entries, '奖励', rewardFilters).length, 3, '奖励包含现货、合约及旧合约奖励')
assert.equal(filterTransactionFeed(rewardFeed.entries, '全部', { ...rewardFilters, query: '返佣' }).length, 2)
assert.equal(transactionCategory({ ...funding(34, 2400, '10'), type: '已实现盈亏' }), null, '交易盈利不算奖励')

const others = [
  { ...fill(21, '买入', '1', '100'), scope: 'spot', positionSide: undefined },
  { ...fill(22, '买入', '1', '100'), scope: 'transfer', type: '账户间转账', positionSide: undefined },
  { ...fill(23, '买入', '1', '100'), scope: 'capital', type: '充值', positionSide: undefined },
  { ...fill(24, '买入', '1', '100'), scope: 'capital', type: '提现', positionSide: undefined },
  { ...fill(25, '买入', '1', '100'), scope: 'wallet:solana', type: '收到', positionSide: undefined },
  { ...fill(26, '买入', '1', '100'), scope: 'wallet:solana', type: '转出', positionSide: undefined },
  { ...fill(27, '买入', '1', '100'), scope: 'wallet:solana', type: '兑换', positionSide: undefined },
]
assert.deepEqual(others.map(transactionCategory), ['现货', null, '充值', '提现', '转账', '转账', '兑换'])
const feed = buildTransactionFeed({ ...complete, records: [...complete.records, ...others] })
assert.equal(feed.entries.length, 7, '全部保留合并合约和其他记录，不混入合约逐笔或重复资金费')
assert.equal(feed.entries.filter(entry => entry.kind === 'contract').length, 1)
assert(!feed.entries.some(entry => entry.kind === 'transaction' && entry.row.type === '账户间转账'), '内部划转在全部和转账中均不显示')
assert.equal(feed.entries[0].id, others.at(-1).id, '全部分类按发生或平仓时间统一倒序')
const noFilters = { query: '', source: '', type: '', account: '', start: '', end: '' }
assert.equal(filterTransactionFeed(feed.entries, '转账', noFilters).length, 2)
assert.equal(filterTransactionFeed(feed.entries, '合约', noFilters).length, 1)
assert.equal(filterTransactionFeed(feed.entries, '全部', { ...noFilters, source: 'other' }).length, 0)
assert.equal(filterTransactionFeed(feed.entries, '全部', { ...noFilters, start: '2026-10-21' }).length, 0)
assert.equal(rounds(state([fill(1, '卖出', '1', '100', '0', 'SHORT'), fill(2, '买入', '1', '90', '10', 'SHORT')]))[0].direction, '做空')
const flip = rounds(state([fill(1, '买入', '1', '100', '0', 'BOTH'), fill(2, '卖出', '2', '110', '10', 'BOTH'), fill(3, '买入', '1', '100', '10', 'BOTH')]))
assert.equal(flip.length, 2)
assert.deepEqual(flip.map(r => r.fees[0].quantity), ['0.15', '0.15'], '反手手续费只能扣一次')
assert.equal(rounds(state([fill(1, '卖出', '1', '110', '10')]))[0].status, '资料不全', '不能把窗口外开仓当成完整一轮')
const noAnchor = { ...complete, syncs: [] }
assert.equal(rounds(noAnchor).length, 0)
assert(buildContractHistory(noAnchor).warnings.length)
const foreign = state([fill(1, '买入', '1', '100'), { ...fill(2, '卖出', '1', '110', '10'), fees: [{ asset: 'BNB', quantity: '0.01' }] }])
assert.equal(rounds(foreign)[0].netPnl, null)
const overlap = state([fill(1, '买入', '1', '100'), fill(2, '卖出', '1', '100', '0', 'SHORT'), funding(1, 2500, '-1'), fill(3, '卖出', '1', '110', '10'), fill(4, '买入', '1', '90', '10', 'SHORT')])
assert(rounds(overlap).every(r => r.netPnl === null), '双向同持不能随意拆资金费')
const sameTime = state([fill(10, '卖出', '1', '110', '10', 'LONG', 1000), fill(9, '买入', '1', '100', '0', 'LONG', 1000)])
assert.equal(rounds(sameTime)[0].status, '已平仓', '同毫秒成交按数字编号排')
const broken = structuredClone(complete)
broken.syncs[0].coverage.count++
assert.equal(rounds(broken).length, 0, '覆盖数量不一致不能当已读全')
const gap = 10 * 86400000
const beforeGap = complete.records.map(row => ({ ...row, id: row.id + '1', time: row.time - gap }))
const archived = state([...complete.records, ...beforeGap])
archived.syncs = complete.syncs.map(sync => ({ ...sync,
  checkpoints: [{ coverage: { ...sync.coverage, from: start - gap, to: end - gap }, ...(sync.positionCheck ? { positionCheck: { ...sync.positionCheck, at: end - gap } } : {}) }],
}))
assert(validTransactionState(archived))
assert.equal(rounds(archived).length, 2, '两次同步有缺口，旧的已确认结果仍需保留')
assert(rounds(archived).every(round => round.netPnl === '8.7'), '历史资金费覆盖随核对资料保留')
const missingIncome = { ...complete, syncs: complete.syncs.slice(0, 1) }
assert.equal(rounds(missingIncome)[0].netPnl, null)
const open = rounds(state([fill(1, '买入', '2', '100'), fill(2, '卖出', '1', '110', '10')], { LONG: '1', SHORT: '0', BOTH: '0' }))[0]
assert.equal(open.status, '持仓中')
assert.equal(open.netPnl, null)
assert(!validTransactionState({ ...complete, records: [{ ...complete.records[0], positionSide: 'bad' }] }))

const total = (amounts, asset) => amounts.find(item => item.asset === asset)?.quantity
const feeNow = Date.now()
const feeAmounts = [{ key: 'coin:tether', asset: 'USDT', quantity: '0.02', detail: '' }, { key: 'coin:binancecoin', asset: 'BNB', quantity: '0.00899827', detail: '' }]
const currentFeePrices = [{ key: 'coin:binancecoin', price: '600', at: feeNow }]
assert.equal(feesInUsdt(feeAmounts, currentFeePrices, feeNow).amounts[0].quantity, '5.418962', '原币手续费按当前价折合USDT后精确相加')
assert.equal(feesInUsdt(feeAmounts, [{ ...currentFeePrices[0], price: '700' }], feeNow).amounts[0].quantity, '6.318789', '当前行情变化时重算，不使用历史价格')
assert.equal(feesInUsdt(feeAmounts, [], feeNow).amounts.length, 0, '缺价时不能把部分金额冒充总额')
assert.equal(feesInUsdt(feeAmounts, [{ ...currentFeePrices[0], at: feeNow - 300001 }], feeNow).missing, 1, '过期报价不能当实时价格')
assert.equal(feesInUsdt(feeAmounts, [{ ...currentFeePrices[0], price: '-1' }], feeNow).missing, 1)
assert.equal(feesInUsdt([{ key: 'crypto:gate:USDC', asset: 'USDC', quantity: '1.2', detail: '' }], [], feeNow).amounts[0].quantity, '1.2', '交易所USDC按指定1:1折合')
assert.equal(feesInUsdt([{ key: 'crypto:evm:1:0xunknown', asset: 'USDT', quantity: '1.2', detail: '未知代币' }], [], feeNow).missing, 1, '不能把钱包同名代币当成USDT')
assert.equal(summaryAmount('113.63869998', true), '+113.64')
assert.equal(summaryAmount('0.001'), '0.00', '汇总小额也固定两位小数')
assert.equal(summaryAmount('-0.001', true), '0.00', '舍入后不显示负零')
assert.equal(summaryAmount('582.1993679'), '582.20')
assert.equal(summaryAmount('1.005'), '1.01', '先精确相加再四舍五入')
const summaryFilters = { ...noFilters, start: '2026-10-20', end: '2026-10-20' }
const summary = summarizeTransactions(rewarded, rounds(rewarded), summaryFilters)
assert.deepEqual(summary.funding, { income: '0', expense: '1', net: '-1', missing: 0 }, '资金费只统计原始收支，不重复加合约整轮费用')
const fundingRows = [funding(101, 1000, '2.8'), funding(102, 2000, '-6'), { ...funding(103, 3000, '0.2'), asset: 'USDC', symbol: '' }, { ...funding(104, 4000, '999'), status: '处理中' }, { ...funding(105, 5000, '-999'), status: '失败' }, futuresReward]
const fundingSummary = summarizeTransactions({ records: fundingRows, syncs: [] }, [], summaryFilters)
assert.deepEqual(fundingSummary.funding, { income: '3', expense: '6', net: '-3', missing: 0 }, 'USDC按1:1合并；未知仓位归属仍计账户资金费，未完成与奖励不混入')
assert.equal(fundingSummary.fees.length, 0, '资金费不混入手续费')
assert.equal(summarizeTransactions({ records: fundingRows, syncs: [] }, [], { ...summaryFilters, source: '别的账户' }).funding.net, null)
assert.equal(summarizeTransactions({ records: fundingRows, syncs: [] }, [], { ...summaryFilters, start: '2026-10-21', end: '2026-10-21' }).funding.net, null)
assert.deepEqual(summarizeTransactions({ records: fundingRows, syncs: [] }, [], { ...summaryFilters, query: '不存在', type: '提现', account: '不存在' }).funding, fundingSummary.funding, '搜索及列表分类不改变资金费汇总')
assert.deepEqual(summarizeTransactions({ records: [funding(106, 1000, '0.1'), funding(107, 2000, '0.2'), funding(108, 3000, '-0.3')], syncs: [] }, [], summaryFilters).funding, { income: '0.3', expense: '0.3', net: '0', missing: 0 }, '先精确加总，不产生负零或浮点误差')
assert.deepEqual(summarizeTransactions({ records: [...fundingRows, { ...funding(109, 6000, '1'), asset: 'BTC' }], syncs: [] }, [], summaryFilters).funding, { income: '3', expense: '6', net: '-3', missing: 1 }, '未知结算币不冒充USDT，只合计已知部分并计数提示')
assert.deepEqual(summarizeTransactions({ records: [], syncs: [] }, [], summaryFilters).funding, { income: null, expense: null, net: null, missing: 0 }, '没有资金费记录时不伪造零金额')
assert.equal(total(summary.pnl, 'USDT'), '10', '汇总平台平仓盈亏，不重复减手续费或资金费')
assert.equal(total(summary.fees, 'USDT'), '0.3', '逐笔费用仅统计一次')
assert.equal(total(summary.rewards, 'USDT'), '1.76456995', 'USDC按用户指定1:1与USDT合并，现货返佣也计入')
assert.equal(summarizeTransactions({ records: [legacyReward], syncs: [] }, [], summaryFilters).rewards.length, 0, '受限新人奖励继续排除')
assert(!Object.hasOwn(summary, 'rewardDetails'), '不再单独累计未确认奖励明细')
const valuedArb = { ...reward, id: reward.id + ':arb', asset: 'ARB', quantity: '10', rewardValuation: { price: '0.3', at: Math.floor(reward.time / 60000) * 60000, pair: 'ARBUSDT', basis: 'minute-open', usdtQuantity: '3' } }
assert.equal(total(summarizeTransactions({ records: [reward, futuresReward, valuedArb], syncs: [] }, [], summaryFilters).rewards, 'USDT'), '4.76456995', '历史市价折合值加入一次，不再加入10个ARB原数量')
assert.equal(summarizeTransactions({ records: [{ ...valuedArb, rewardValuation: undefined }], syncs: [] }, [], summaryFilters).rewards.length, 0, '非稳定币缺价继续跳过')
assert.deepEqual(summarizeTransactions(rewarded, rounds(rewarded), { ...summaryFilters, query: '不存在', type: '提现', account: '不存在' }), summary, '搜索和列表分类不改变五项总览')
assert.equal(summarizeTransactions(rewarded, rounds(rewarded), { ...summaryFilters, source: '别的账户' }).fees.length, 0)
assert.equal(summarizeTransactions(rewarded, rounds(rewarded), { ...summaryFilters, start: '2026-10-21', end: '2026-10-21' }).pnl.length, 0)
const unclosed = state([fill(1, '买入', '2', '100')], { LONG: '2', SHORT: '0', BOTH: '0' })
assert.equal(total(summarizeTransactions(unclosed, rounds(unclosed), summaryFilters).fees, 'USDT'), '0.1', '未平仓的成交费用也要计入')
assert.equal(summarizeTransactions(unclosed, rounds(unclosed), summaryFilters).pnl.length, 0)
const feeIncome = { ...funding(80, 1000, '-0.1'), type: '手续费', relatedTradeId: complete.records[0].id }
assert.equal(total(summarizeTransactions({ ...complete, records: [...complete.records, feeIncome] }, rounds(complete), summaryFilters).fees, 'USDT'), '0.3', '独立手续费和成交手续费不重复算')
const refund = { ...feeIncome, id: 'binance:test:usdm:income:refund', quantity: '0.02', relatedTradeId: '' }
assert.equal(total(summarizeTransactions({ ...complete, records: [...complete.records, refund] }, rounds(complete), summaryFilters).feeRefunds, 'USDT'), '0.02', '返还单列，不抵消支出')
const relatedRefund = { ...refund, relatedTradeId: complete.records[0].id }
assert.equal(total(summarizeTransactions({ ...complete, records: [...complete.records, relatedRefund] }, rounds(complete), summaryFilters).fees, 'USDT'), '0.3', '同成交额外返还不能吞掉原手续费支出')
const bnbFill = { ...fill(9, '买入', '1', '100'), fees: [{ asset: 'BNB', quantity: '0.01' }] }
bnbFill.feeValuations = [{ asset: 'BNB', price: '600', at: Math.floor(bnbFill.time / 60000) * 60000, pair: 'BNBUSDT' }]
assert.equal(total(summarizeTransactions({ records: [bnbFill], syncs: [] }, [], summaryFilters).fees, 'USDT'), '6', '汇总手续费与单笔一致，按成交当分钟价折算')
assert.equal(total(summarizeTransactions({ records: [{ ...bnbFill, feeValuations: undefined }], syncs: [] }, [], summaryFilters).fees, 'BNB'), '0.01', '缺历史价时保留原币')
const wallet = (id, owner, type, party, qty = '1', time = start + 2000, txHash = '0x' + 'a'.repeat(64)) => ({
  ...funding(id, 2000, qty), id: 'wallet:' + id, connectionId: owner, scope: 'wallet:eth', account: 'Ethereum', network: 'Ethereum', type, asset: 'ETH',
  walletOwner: owner, address: party, txHash, time, fees: type === '转出' ? [{ asset: 'ETH', quantity: '0.001' }] : [],
  movements: [{ token: 'native', asset: 'ETH', direction: type === '收到' ? 'in' : 'out', quantity: qty, counterparty: party }],
})
const ownA = '0x' + '1'.repeat(40), ownB = '0x' + 'ab'.repeat(20), outside = '0x' + '3'.repeat(40)
const ownOut = wallet(100, ownA, '转出', ownB.toUpperCase().replace('0X', '0x'))
const ownIn = wallet(101, ownB, '收到', ownA, '1', start - 1000)
const externalIn = wallet(102, ownA, '收到', outside, '0.1', start + 3000, '0x' + 'b'.repeat(64))
const internalState = { records: [ownOut, ownIn, externalIn], syncs: [] }
const ownSummary = summarizeTransactions(internalState, [], { ...summaryFilters, source: ownA })
assert.equal(ownSummary.sent.length, 0, '即使另一侧在日期/账户范围外也排除自己钱包转账')
assert.equal(total(ownSummary.received, 'ETH'), '0.1')
assert.equal(total(ownSummary.fees, 'ETH'), '0.001', '内部转移真实链上费仍计入')
const knownOnly = summarizeTransactions({ records: [ownOut], syncs: [] }, [], summaryFilters, [{ id: ownB, type: 'wallet', address: ownB, chains: ['eth'] }])
assert.equal(knownOnly.sent.length, 0, '已添加但尚无流水的自己钱包也能识别')
const exchangeDeposit = { ...funding(103, 3000, '1'), type: '充值', scope: 'capital', asset: 'ETH', network: 'ETH', address: outside, txHash: ownOut.txHash }
const toExchange = { ...ownOut, address: outside, movements: ownOut.movements.map(item => ({ ...item, counterparty: outside })) }
const depositPair = summarizeTransactions({ records: [exchangeDeposit, toExchange], syncs: [] }, [], summaryFilters)
assert.equal(depositPair.deposits.length, 0)
assert.equal(depositPair.sent.length, 0, '自己钱包到已接入交易所不算外部收付')
const withdrawal = { ...exchangeDeposit, id: 'binance:test:capital:withdrawal', type: '提现', address: ownA, fees: [{ asset: 'ETH', quantity: '0.002' }] }
const withdrawPair = summarizeTransactions({ records: [withdrawal, { ...externalIn, quantity: '1', time: start - 1000, txHash: withdrawal.txHash, movements: externalIn.movements.map(item => ({ ...item, quantity: '1' })) }], syncs: [] }, [], summaryFilters)
assert.equal(withdrawPair.withdrawals.length, 0)
assert.equal(total(withdrawPair.fees, 'ETH'), '0.002')
const batchWithdrawals = [{ ...withdrawal, id: withdrawal.id + ':1', quantity: '0.5' }, { ...withdrawal, id: withdrawal.id + ':2', quantity: '0.5' }]
const batchReceipt = { ...externalIn, txHash: withdrawal.txHash, quantity: '1', movements: externalIn.movements.map(item => ({ ...item, quantity: '1' })) }
const batchSummary = summarizeTransactions({ records: [...batchWithdrawals, batchReceipt], syncs: [] }, [], summaryFilters)
assert.equal(batchSummary.received.length, 0, '同hash同地址的多笔自己提现合起来匹配钱包收款')
assert.equal(batchSummary.withdrawals.length, 0)
const failed = { ...toExchange, id: 'failed-wallet', status: '失败', movements: [] }
const failedSummary = summarizeTransactions({ records: [failed, { ...exchangeDeposit, status: '处理中' }], syncs: [] }, [], summaryFilters)
assert.equal(failedSummary.deposits.length, 0)
assert.equal(failedSummary.sent.length, 0)
assert.equal(total(failedSummary.fees, 'ETH'), '0.001', '失败交易实际扣除的链上费不能丢失')
const duplicateFee = { ...toExchange, id: 'same-fee-other-id' }
assert.equal(total(summarizeTransactions({ records: [toExchange, duplicateFee], syncs: [] }, [], summaryFilters).fees, 'ETH'), '0.001', '同钱包同链同笔费用仅一次')
const tiny = [externalIn, { ...externalIn, id: 'tiny-in', txHash: '0x' + 'c'.repeat(64), quantity: '0.2', movements: externalIn.movements.map(item => ({ ...item, quantity: '0.2' })) }]
assert.equal(total(summarizeTransactions({ records: tiny, syncs: [] }, [], summaryFilters).received, 'ETH'), '0.3', '小数精确相加')
const tokens = ['0x' + '4'.repeat(40), '0x' + '5'.repeat(40)].map((token, index) => ({ ...externalIn, id: 'token:' + index, movements: [{ token, asset: 'USDC', direction: 'in', quantity: '1', counterparty: outside }] }))
assert.equal(summarizeTransactions({ records: tokens, syncs: [] }, [], summaryFilters).received.length, 2, '未知同名币不能混在一起')
const boundary = { ...externalIn, time: Date.parse('2026-10-20T23:59:59.999+08:00') }
assert.equal(summarizeTransactions({ records: [boundary, { ...boundary, id: 'next-day', time: boundary.time + 1 }], syncs: [] }, [], summaryFilters).received[0].quantity, '0.1', '北京时间区间包含最后一毫秒，不包含次日')
const cashTotals = {
  deposits: [{ key: 'coin:tether', asset: 'USDT', quantity: '100', detail: '' }],
  received: [{ key: 'coin:ethereum', asset: 'ETH', quantity: '0.1', detail: '' }],
  withdrawals: [{ key: 'coin:usd-coin', asset: 'USDC', quantity: '10', detail: '' }],
  sent: [{ key: 'coin:ethereum', asset: 'ETH', quantity: '0.02', detail: '' }],
}
const cashPrices = [{ key: 'coin:ethereum', price: '2000', at: feeNow }]
assert.deepEqual(summarizeCashflow(cashTotals, cashPrices, feeNow), { income: '300', expense: '50', net: '250', missing: 0 }, '充值和收到合并收入，提现和转出合并支出；按价格换成同一单位再相减')
assert.equal(summarizeCashflow(cashTotals, [{ ...cashPrices[0], price: '1000' }], feeNow).net, '170', '收付折合值随当前价格更新')
assert.deepEqual(summarizeCashflow({ deposits: [], received: [], withdrawals: cashTotals.withdrawals, sent: [] }, [], feeNow), { income: '0', expense: '10', net: '-10', missing: 0 }, '只有支出时收入显示零，净收支保留负号')
assert.deepEqual(summarizeCashflow({ deposits: [], received: [], withdrawals: [], sent: [] }, [], feeNow), { income: null, expense: null, net: null, missing: 0 }, '无收付记录时显示横线')
assert.deepEqual(summarizeCashflow(cashTotals, [], feeNow), { income: null, expense: null, net: null, missing: 2 }, '缺价不能拿部分金额相减当成总收支')
assert.equal(summarizeCashflow(ownSummary, cashPrices, feeNow).net, '200', '沿用内部搬钱排除结果，且不再把手续费扣入资金收付')
assert.equal(summarizeCashflow({ ...cashTotals, received: summarizeTransactions({ records: tokens, syncs: [] }, [], summaryFilters).received }, cashPrices, feeNow).net, null, '未知同名稳定币不能按1:1凑入净收支')
assert.equal(cashTotals.received[0].quantity, '0.1', '不改变原币数量')
// 历史手续费只用假分钟K线；获用户同意后与本脚本一起运行。
const feeMinute = Math.floor(foreign.records[1].time / 60000) * 60000
const feeCandle = (at, price = '500') => [at, price, price, price, price, '1', at + 59999, '500', 1, '1', '500', '0']
let feeQuoteRequests = 0
const quotedFees = await valueTransactionFees(foreign.records, [], async url => {
  feeQuoteRequests++
  const params = new URL(url).searchParams
  assert.equal(params.get('symbol'), 'BNBUSDT')
  assert.equal(params.get('interval'), '1m')
  assert.equal(Number(params.get('startTime')), feeMinute)
  return [feeCandle(feeMinute)]
})
assert.equal(feeQuoteRequests, 1)
assert.equal(quotedFees.missing, 0)
const quotedState = { ...foreign, records: quotedFees.records }
assert(validTransactionState(quotedState), '历史费用报价通过原资料校验')
const quotedRound = rounds(quotedState)[0]
assert.equal(quotedRound.feePnl, '-5.1')
assert.equal(quotedRound.netPnl, '4.9', '平仓盈亏10减USDT手续费0.1及BNB历史手续费5')
assert.equal(quotedRound.fees.find(fee => fee.asset === 'BNB').quantity, '0.01', '原币手续费不可被折算金额覆盖')
assert.equal(closedReturnStats([quotedRound]).fees, '-5.1')
assert.equal(valueRecordedEntries(buildReturnEntries(quotedFees.records).filter(entry => entry.category === '交易手续费'), 'USDT').entries.reduce((sum, entry) => sum + Number(entry.amount), 0), -5.1)
const reusedFees = await valueTransactionFees(foreign.records, quotedFees.records, async () => { throw new Error('已有同一分钟报价，不应再次查询') })
assert.equal(reusedFees.missing, 0)
assert.deepEqual(reusedFees.records, quotedFees.records)
const savedQuote = quotedFees.records.find(row => row.feeValuations)
assert.deepEqual(mergeTransactions(quotedFees.records, foreign.records).find(row => row.id === savedQuote.id).feeValuations, savedQuote.feeValuations, '正常增量同步不能丢掉已有历史报价')
assert.equal(mergeTransactions(quotedFees.records, [{ ...foreign.records[1], time: foreign.records[1].time + 1 }]).find(row => row.id === savedQuote.id).feeValuations, undefined, '交易发生时间变化后不能继承旧依据')
assert(!validTransactionState({ records: [{ ...savedQuote, feeValuations: [{ ...savedQuote.feeValuations[0], pair: 'BNBUSDC' }] }], syncs: [] }))
assert(!validTransactionState({ records: [{ ...savedQuote, feeValuations: [{ ...savedQuote.feeValuations[0], at: feeMinute - 60000 }] }], syncs: [] }))
assert(!validTransactionState({ records: [{ ...savedQuote, feeValuations: [{ ...savedQuote.feeValuations[0], price: '0' }] }], syncs: [] }))
const failedFees = await valueTransactionFees(foreign.records, [], async () => [feeCandle(feeMinute + 60000)])
assert.equal(failedFees.missing, 1, '不能用其他分钟的价格补缺')
assert.equal(feeInUnit(failedFees.records[1], failedFees.records[1].fees[0], 'USDT'), null)
const unpricedStats = closedReturnStats(rounds(foreign))
assert.equal(unpricedStats.gross, '10', '手续费未换算不应挡住已知的平仓盈亏')
assert.equal(unpricedStats.longCount, 1, '方向统计与净收益是否可核对无关')
assert.equal(unpricedStats.fees, null)
assert.equal(unpricedStats.nativeFees.find(fee => fee.asset === 'BNB').amount, '-0.01')
assert.equal(unpricedStats.net, null, '缺费用价格仍不能冒充完整净收益')
const missingFunding = { ...quotedState, syncs: quotedState.syncs.filter(sync => sync.key !== 'income') }
const partialStats = closedReturnStats(rounds(missingFunding))
assert.equal(partialStats.gross, '10')
assert.equal(partialStats.fees, '-5.1')
assert.equal(partialStats.funding, null)
assert.equal(partialStats.net, null, '资金费范围不全时不能补零')
const bnbFlip = state([fill(1, '买入', '1', '100', '0', 'BOTH'), fill(2, '卖出', '2', '110', '10', 'BOTH'), fill(3, '买入', '1', '100', '10', 'BOTH')].map(row => ({ ...row, fees: [{ asset: 'BNB', quantity: '0.01' }] })))
const valuedFlip = await valueTransactionFees(bnbFlip.records, [], async () => [feeCandle(feeMinute)])
assert.deepEqual(rounds({ ...bnbFlip, records: valuedFlip.records }).map(round => round.feePnl), ['-7.5', '-7.5'], '反手成交的BNB费用只换算并分摊一次')
assert.equal(closedReturnStats(rounds({ ...bnbFlip, records: valuedFlip.records })).net, '5')
const feeFolder = mkdtempSync(join(tmpdir(), 'fake-fee-history-'))
try {
  const feeStore = createTransactionStore(feeFolder)
  feeStore.save(foreign.records, foreign.syncs)
  let releaseFees
  const blockedFees = new Promise(resolve => { releaseFees = resolve })
  const feeService = createConnectionService(feeFolder, {
    vault: { get: async () => { throw new Error('历史价格补查不得读取密钥') } },
    feeValuer: async () => { await blockedFees; return quotedFees },
  })
  const feeWork = feeService.valueSavedTransactionFees()
  const changedFee = { ...foreign.records[1], fees: [{ asset: 'BNB', quantity: '0.02' }] }
  const laterTrade = { ...foreign.records[0], id: foreign.records[0].id + '8' }
  feeStore.save([changedFee, laterTrade], [])
  releaseFees()
  await feeWork
  const feeState = feeStore.list()
  assert.equal(feeState.records.find(row => row.id === changedFee.id).fees[0].quantity, '0.02')
  assert.equal(feeState.records.find(row => row.id === changedFee.id).feeValuations, undefined, '补价期间费用变化后不能套旧依据')
  assert(feeState.records.some(row => row.id === laterTrade.id), '异步补价不能覆盖新交易')
} finally { rmSync(feeFolder, { recursive: true, force: true }) }
console.log('合约完整轮次及历史费用隔离检查通过（未连接真实账户）')
