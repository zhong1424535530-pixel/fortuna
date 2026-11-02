# 合约按完整一轮展示 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session. 用户已同意方案；模拟测试必须等代码完成后另行同意。此目录没有 Git，不创建分支或提交。

**Goal:** 默认只看已经完全平仓的一轮，展示最终净盈亏、手续费和回报率资料是否齐全。

**Architecture:** 保存原始成交，不删除流水。用完整成交范围和同一时间的仓位数量反推每轮起点；按账户身份、合约、持仓方向分别合并。只在用户点击同步时读取仓位，读取期间仍有成交则暂不确认这一品种的新结果。

**Tech Stack:** TypeScript、React、现有 decimal.js、币安已有只读接口。

### 范围与边界

- 修改 `src/data/transactions.ts`：兼容旧记录，增加持仓方向、已读全区间及数量核对资料，严格校验新字段。
- 修改 `server/binance-transactions.mjs`：每次补读7天合约成交；读当前仓位，再检查截止时间之后是否还有成交，避免把较晚仓位与较早流水混算。连续区间允许延长；记录数量不一致则放弃延长。
- 新建 `src/data/contract-history.ts`：金额用十进制计算；开仓到归零一轮，加仓与部分平仓合并；反手拆为平旧仓和开新仓，按数量分手续费。同毫秒按成交编号排序。
- 新建 `src/components/ContractHistory.tsx`，接入 `TransactionsPage.tsx` 和现有样式：默认已平仓，全部流水保留，详情展示原始成交；隐藏金额开关覆盖所有金额。
- 资金费仅在该时刻唯一归属一轮且收支区间完整时纳入净值；双向同时持仓、外币手续费或未匹配收支不能硬算最终净值。
- 历史保证金未由现有成交接口提供，回报率显示待补齐，不用当前杠杆或成交金额冒充。缺窗口外开仓资料的轮次不进入默认完整结果。
- 不读密钥文件、不主动同步真实账户、不改变余额和原始历史。不增加付费服务或依赖。

### 执行顺序

- [x] 准备 `scripts/check-contract-history.mjs` 断言：完整多空轮次、部分平仓、反手、同毫秒顺序、缺开仓、缺覆盖、资金费和外币费用；先保存，不运行。
- [x] 完成数据校验、同步核对资料、纯计算和页面；更新已有假请求以认识新增只读查询。
- [x] 只做 `npm run check`、`npm run build`、`node --check` 静态核对，安排只读代码审查。
- [ ] 告知代码完成，询问是否做模拟测试；获批后再运行 `npm run check:contract-history`、既有交易及钱包隔离检查，并用隔离页面核对布局。真实账户同步由用户单独点击。

### 核对重点

```js
assert.equal(rounds[0].netPnl, '8.7') // 10 平仓盈亏 - 0.3 手续费 - 1 资金费
assert.equal(rounds.length, 1) // 分批开平仍是一轮
assert.equal(rounds[0].roi, null) // 缺历史保证金不猜回报率
```

模拟测试、真实读取、界面运行检查均未执行，完成时必须如实说明。

静态完成记录：`npm run check`、`npm run build`、三个修改/新增 mjs 文件的 `node --check` 均通过；构建仍有体积提示。只读审查指出的平台/本机截止时间混用、断档后丢失旧合并凭证已修正并再次审查。补充 `checkpoints` 保存独立历史范围，资金费对应保存覆盖证明。所有隔离断言和浏览器效果仍未运行。
