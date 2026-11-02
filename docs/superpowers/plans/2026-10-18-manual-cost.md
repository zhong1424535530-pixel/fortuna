# 手动成本实施计划

目标：实现已同意的两处入口，复用现有保存和弹窗，无新依赖。继续在当前目录完成，不创建分支或账户连接。

- [x] 先在 scripts/check-demo.ts 写入金额、缺成本、缺现价、零成本、汇率、旧资料兼容与非法输入断言。本轮不执行模拟脚本。
- [x] src/data/workspace.ts 增加可选 CostBasis 类型及数量/价格/币种/时间校验；commitWorkspace 保留所有错误保护并区分成本更新通知。
- [x] src/data/portfolio.ts 增加 positionCostBasis、holdingCostSummary 与保存前金额/账户归属检查；不改估值公式和示例资料。
- [x] src/components/AssetCosts.tsx 与 src/asset-costs.css：共用的汇总、账户行和平均单价表单；清除仅移除成本记录，不删持仓。明确含费状态及缺成本说明。
- [x] src/App.tsx 详情加入 AssetCosts，成本通知保留详情；账户页不因成本保存重置。AssetManagerPage 成本管理复用该组件，不嵌套弹窗。
- [x] 更新 README、实现说明、设计文档；运行 npm run build，只能据此声称编译通过。报告入口与边界，再询问模拟测试。

自检关键值：0.42 BTC×60000美元=25200美元；仅填币安时BTC整体仍缺两账户成本。填齐60000/50000/70000，BTC总成本41200美元、数量0.7，平均价按数量加权。人民币成本按7.12转换。成本始终不进入总估值。

执行边界：已按当前会话授权直接实施；只运行 npm run build（退出0），不运行模拟脚本或浏览器。新增断言待用户同意后执行。未创建Git仓库、未提交或接入外部账户。
