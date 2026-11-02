# 全站下拉菜单统一

已获用户同意，在当前目录直接实施；本目录没有 Git 仓库。不创建独立副本，不改余额、密钥和读取网络。

- 共用 `src/components/Select.tsx` 和 `src/select.css`，复用现有 Dialog 的弹出、关闭和焦点管理。选项支持图标、说明、分组和搜索，保留键盘操作和禁用状态。
- 替换 Connections、AssetManagerPage、AssetCosts、LiabilityManager、TransactionsPage 和 App 中全部默认下拉框；回调继续使用原保存和筛选逻辑。
- AssetAccountFilter 和 SourceHistory 使用同一菜单，保留账户选择、搜索、分类和金额。
- 交易所、钱包和网络使用现有 Logo；类别、状态、货币使用含义明确的小图标。
- 修改后只核对源文件。遵照用户要求，得到单独同意后才执行程序检查及模拟测试；检查键盘、禁用、弹窗内选择、窄屏和原筛选行为。
