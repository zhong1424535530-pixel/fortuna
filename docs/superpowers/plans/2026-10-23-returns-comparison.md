# 收益周期对比实施计划

> 按已确认方案逐项实施，遵守用户先改代码、后单独同意模拟的要求；当前非Git目录，不提交。

**Goal:** 顶部显示正确的前期对比，统一全部类别排行，移除重复现货列表。

**Architecture:** `returns-comparison.ts`整理北京时间范围及同口径两期金额，复用原收益计算；`ReturnsPage.tsx`负责排行和对比展示，沿用图表及金额隐藏。保守处理缺失记录与本金资料。

**Tech Stack:** 现有React、TypeScript、Decimal和图表，不加依赖。

- [x] 新增`src/data/returns-comparison.ts`：`comparisonPeriods`处理月/年同期及等日数前期，`periodOverview`统一两期净收益与可比性，`comparisonDifference`只对完整金额做减法。
- [x] 调整`src/data/returns-period.ts`：手动其他资产加入候选，缺增减记录明确返回空金额；导出原换算价格帮助方法供期初本金复用。
- [x] 调整`src/components/ReturnsPage.tsx`及`src/returns-page.css`：全部排行、类别标签、展开全部、独立详情定位、现货入口跳排行、紧凑两期横条、全部时间累计图，移除原现货面板及未使用样式。
- [x] 新建`scripts/check-returns-comparison.mjs`准备固定时钟与假资料断言：跨月年闰日、短月、滚动和自选截止、全部无上期、真实零与缺失、原币缺价、手动增减不算利润、对比差与百分点；不执行。
- [x] `npm run check`、`npm run build`、脚本语法检查，独立只读复核；README记录完成边界，最后再请求模拟许可。

## 交付记录

已完成代码、隔离断言准备及独立只读复核。复核修正了收益组成超过8项时被截断、手动资产挂交易所账户漏识别、手动现金改余额绕过保护，以及估值/流水未覆盖完整边界仍算可比的风险。期初/末估值按秒核对，流水必须完整覆盖所选毫秒终点。

`npm run check`、`npm run build`、`node --check scripts/check-returns-comparison.mjs`通过；保留原SQLite实验和打包大文件提示。没有执行新增模拟断言、浏览器验收、真实账户读取或资料迁移。手动期间投入取出记录不足时只列示，不计算猜测收益；有外部资金进出的加权收益率尚未实现。下一步按用户要求单独申请模拟许可。
