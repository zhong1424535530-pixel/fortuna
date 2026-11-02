# 收益分析改版实施计划

**目标：** 落实已批准的两页设计，复用现有记录和合约详情，避免错误的收益计算。
**结构：** 独立 returns-analysis.ts 做原币种收支整理；ReturnsPage.tsx 管理筛选和展示；Charts.tsx 增加原币种收益图；RecordsPages.tsx 保留现有导出。
**约束：** 不改后端、不查真实账户、不运行模拟测试。本轮不做提交或新建工作区。

- [x] 先写 scripts/check-returns.mjs，覆盖重复费用、转账排除、跨币种、跨期、未知净收益、无样本等；本轮不运行。
- [x] 新增 src/data/returns-analysis.ts：精确收支分类、范围筛选、日聚合、排行和完整平仓样本统计。
- [x] 新增 src/components/ReturnsPage.tsx；复用 Select、ReturnRangeFilter、Panel、ContractRoundModal 及成本资料。
- [x] Charts.tsx 增加原币种累计/每日收支图；不改已有资产曲线行为。
- [x] RecordsPages.tsx 转发新页面；新增 src/returns-page.css，仅影响收益页。
- [x] README.md 更新页面用途、统计范围、缺口和自检命令。
- [x] npm run build 只做编译与打包检查；检查本轮文件及计算边界。模拟自检和页面交互均留待用户明确同意。

补充完成：合约详情展示整轮净收益和待核对原因；资金费按可核对明细拆分收入/支出；本金对账单独折叠展示，币种选择包含只有本金记录的币种。

只读审查发现的“其他币种零手续费影响合计”和本金币种选项遗漏已修正。`npm run build` 通过，`node --check scripts/check-returns.mjs` 仅语法检查通过。构建提示包体较大，本轮未扩大改动范围。模拟自检、桌面/手机页面交互未运行，等待用户明确同意。
