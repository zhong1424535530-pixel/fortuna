# 小额持仓隐藏实施计划

> For agentic workers: use superpowers:executing-plans in this session. User has approved implementation; simulated checks require separate consent.

**Goal:** 交易所和钱包持仓总值不足1美元时隐藏明细，不补查历史行情；余额及总资产保留。

**Architecture:** 用共享的金额判断函数处理同一资产的各账户持仓，复用decimal.js；页面在筛选账户后隐藏，合计继续基于全部匹配资料。读取数量和现价后才判断，小额明细不进入额外行情查询。

**Tech Stack:** 现有TypeScript、React、Node及decimal.js，不新增依赖。

- [x] 在现有`check-portfolio.ts`准备边界断言：0.99隐藏、1保留、0.9999不因显示舍入变1、低单价但总额大保留、多账户相加、缺价和异常不误隐藏、原资料及总额不变。暂不运行。
- [x] 新增`src/data/holding-visibility.ts`共享函数：按资产ID合计未舍入美元价值，用`quantityText`保留精度；任何同ID部分缺可靠价或数量则保留。
- [x] `App.tsx`保留原匹配持仓用于金额及今日盈亏，另用共享函数生成可见列表，应用电脑、手机及总览计数。
- [x] `AccountsPage.tsx`在来源及账户范围内合计后隐藏小额；原账户净值不变。
- [x] `portfolio.ts`图表小额并入“其他”；`Charts.tsx`明细与点击范围使用可见持仓，分母继续用总余额。
- [x] `daily-prices.mjs`仅为当前读取中合计不小于1美元的资产补查涨跌与日初价；保留原余额，无价资产保留。为跳过小额、跨账户合计及无副作用准备假资料断言，暂不运行。
- [x] 更新README，运行`npm run build`及脚本`--check`，停止并询问模拟测试，不联网刷新真实账户。

资产与价格管理保留原资料，仍可补价、编辑成本；合约仓位不按保证金或浮盈亏套用本次小额规则。共用全量行情请求及最初余额/现价查询无法预先排除未知金额资产。

代码核对：`npm run check`、`npm run build`通过；共享函数、服务及两个断言脚本的`node --check`通过。保留已有大文件打包提示，未运行模拟断言、浏览器检查或真实账户刷新。
