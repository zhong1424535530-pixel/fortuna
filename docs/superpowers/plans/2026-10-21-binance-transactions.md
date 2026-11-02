# 币安最近7天交易记录

**授权：** 用户已同意第一批币安交易记录，将首次范围由30天改为7天；钱包本轮仅说明设计。代码修改后停止，模拟测试须另获用户同意。

**范围：** 现货成交、普通U本位合约成交、资金费及平台收支、充值、提现、现货/合约/资金账户间划转。未成交订单、理财、闪兑、杠杆成交、币本位及其他平台和钱包本轮不接入。不用余额变化推断流水。

**做法：** `transactions.json`独立保存明细和每个来源的读取范围，原币种金额全部用十进制字符串；不改connections.json格式、资产余额、人工成本和收益计算。沿用系统钥匙串和币安只读权限检查，只在点击同步后访问本人账户。先确认UID与已有账户相符，串行读取、限制请求数和总时间，失败保留旧资料。

- [x] 1. 在`scripts/check-transactions.mjs`先准备隔离断言（金额精度、同毫秒分页、去重、费用关联、失败保留、更新处理中状态、重启读取、损坏文件保护、只读请求、账户身份），暂不执行。
- [x] 2. `src/data/transactions.ts`定义记录、覆盖状态、校验与筛选；`server/transaction-store.mjs`原子保存、按稳定身份去重、保留历史，不自动清理。
- [x] 3. `server/binance-reader.mjs`复用只读签名读取入口；`server/binance-transactions.mjs`读取最近7天，各范围单独报告成功/部分/失败。成交满页按时间拆分继续，达到毫秒极限保留部分并提示；不把截断当完整。
- [x] 4. 在`server/connection-service.mjs`加受账户互斥锁保护的流水同步；`server/workspace-api.mjs`提供GET列表和POST单币安来源同步。与行情/余额写入分离；移除账户保留交易历史。
- [x] 5. `src/data/transaction-client.ts`读取本机资料；独立`TransactionsPage.tsx`替换旧空壳，提供来源、账户、类型、日期、搜索、分页、详情、同步状态及补查交易对。保留RecordsPages的收益分析并转出新页面。
- [x] 6. 更新README并逐处核对调用和改动；只运行代码格式/语法与打包检查，不运行任何模拟断言、浏览器或本人账户同步。

**本轮检查：** `npm run check`、`npm run build`、相关服务文件和隔离断言文件的`node --check`均通过；打包保留原有大文件提示。已做独立只读代码审查。未运行`check:transactions`及其他模拟检查、浏览器或本人账户请求；这些验证另等用户同意。

**同步规则：** 首次7×24小时；成功范围以后从上次成功时间前10分钟补读。失败/截断范围下次重新读7天；另行补查交易对也读7天；处理中充值提现始终重查最近7天，超过范围仍未完成须显示提醒。每次记录实际起止时间和查询交易对，只有明确覆盖的范围才报告成功。当前持仓只能发现部分交易对，保留已查询与手动补充的品种，现货始终提示非全市场历史；合约结合收支中的品种与已有仓位发现已平仓记录，品种发现失败时提示不全。

**限制：** 首版单次最多80个交易对/220次请求/190秒；达到上限明确提示部分资料，已有记录不清空。成交价与成交金额显示原报价币；合约成交金额标注名义金额，不冒充实际资金流。平台明确提供的多空方向显示，单双向模式不能据买卖猜开平。费用与已实现盈亏流水只有与成交中的同币种同金额可核对时才合并，避免重复。普通划转目前覆盖现货、U本位、资金、全仓杠杆、币本位之间已列出的常见方向，逐仓、子账户及其他方向明确不支持。

**资料来源：** https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account ; https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade ; https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account ; https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital ; https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/asset

**钱包下一批设计：** 按链+交易编号归为一笔，内部保留每种资产进出；按用户最新要求，仅显示收到、转出、已确认兑换，不展示授权和其他操作，手续费附在对应记录里；展示范围内失败的操作仅记实际费用，待确认不当完成。自己地址互转关联但保留两端原记录，费用只记一次；BTC避免把找零算成收入，EVM读取主币/代币及内部转账，Solana按实际余额变化和动作确认，资料不足不猜兑换。7天范围、手续费原币种、查询链接及各链覆盖提示与交易所保持一致，服务成本和完整性另行确认。
