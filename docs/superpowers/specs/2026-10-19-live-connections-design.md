# 币安与六链钱包读取

用户已明确同意开发币安接入并增加链上钱包；明确选择Ethereum、BSC、Arbitrum、Base、Optimism、Polygon。沿用既有方案，不重复申请开发许可。按用户规则只编译，不运行模拟测试或代替用户填真实凭据。

- 入口统一为账户与钱包 → 添加账户，选择币安或多链钱包；全站增加真实/示例切换。示例账户不计入真实净值，旧示例成本不绑定真实账户；人工资产/负债保留，旧挂在示例账户下的人工资产只在示例视图显示。
- 币安填写名称、HMAC API Key/Secret，存macOS钥匙串，普通文件、日志和备份不含密钥。连接后只调用GET白名单。先核实权限，拒绝包含交易/提现/转账的密钥；核实失败不跳过。读取现货、普通U本位合约余额与仓位，其他产品明确未覆盖，不冒充币安全账户总额。
- 钱包只需公开0x地址，无助记词/私钥/连接钱包或签名。选链并逐链读取。没有查询服务密钥时只读各链原生资产；可选Moralis密钥自动发现代币、价格及图标，过滤其标记的垃圾币。不含NFT和DeFi头寸，页面持续注明范围。
- 每链独立资产身份，不靠简称合并不同代币。数量保留原始字符串；金额在服务端用decimal.js算分币。报价失败保留数量并标待估值。原生币价格来自CoinGecko，币安币价由现货交易对折成美元；稳定币不静默当1美元。
- 按账户保存成功快照；失败保留上次成功记录并显示旧时间/错误。未成功读取的账户显示未读取，汇总提示不完整，不用失败结果覆盖为零。普通合约保证金本金只统计一次，账户浮盈亏单独加一次，仓位名义金额不加进资产。
- 服务固定访问官方域名；私有查询不自动重定向，超时/限流给中文错误，不透传原始响应。所有本机接口沿用Host/Origin/自定义头限制。图标经限制域名/类型/大小的本机代理读取。
- 连接资料独立私有文件，快照缓存不含凭据。新增/修改/移除/刷新入口；连接后可改只读密钥、补Moralis密钥。人工资料备份不含钥匙串或连接缓存，设置说明边界。
- 首版手动刷新，不冒充实时推送；真实历史未积累时图表为空，不生成真实账户的示例曲线。人民币仍采用现有示例汇率，明显提示。

官方资料：
- https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account
- https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account
- https://docs.moralis.com/data-api/evm/wallet/token-balances
- https://ethereum.org/developers/docs/apis/json-rpc/
- https://github.com/Brooooooklyn/keyring-node
