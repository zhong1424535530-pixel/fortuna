# 合约入场价与止盈止损显示

已获用户同意，当前对话实施；沿用 Ponytail 最小改动方式。只检查代码，模拟和真实账户验收另行同意。

目标：合约列表、手机列表与详情显示入场价、止盈止损触发价；保留多档委托。

- [x] `src/data/contract-protection.ts` 定义可选exitOrders与保存校验；live-types、portfolio引用同一类型，connection-service兼容旧记录。
- [x] `server/binance-protection.mjs` 核对币种、持仓方向、平仓方向与只减仓/全部平仓；不明或错误资料返回未知，移动止损不使用激活价冒充止损价。同币双向只查询一次，最多四个币种并行，每种独立失败。
- [x] binance-reader增加只读GET白名单与读取；无持仓不查。不改变余额、估值、刷新频率，不增加依赖，不修改委托。
- [x] Contracts增加入场价及止盈/止损两行，详情保留全部档位、触发依据与数量。styles紧凑排列，手机、金额隐藏及币种切换一致。
- [x] 独立scripts/check-contract-protection.mjs准备假响应断言：多空、双向/单向、入场单排除、部分/全部平仓、多档、移动止损、失败、坏格式、换算、保存与只读白名单；当前不执行。
- [x] 仅类型检查、语法检查、打包和人工审阅。README记录代码完成、模拟与真实读取待验收。

先支持币安普通U本位；其他平台及旧记录显示未读取。成功无单为空数组，失败为null；失败不影响余额与持仓。查询的是未触发委托，显示触发价而非保证成交价。

官方依据：https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#current-all-algo-open-orders

检查记录：`npm run build`及新增/修改服务端脚本的`node --check`通过。仅代码检查；模拟检查、浏览器布局和真实账户核对未执行。
