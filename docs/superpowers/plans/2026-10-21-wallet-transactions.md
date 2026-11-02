# 免费钱包最近7天交易记录

**授权范围：** 用户确认开发钱包记录，只用免费来源，不新增密钥或费用；只显示收到、转出、确认的兑换，授权与其他操作不展示；代码修改后停下，另等用户同意模拟测试。

**数据与兼容：** 复用transactions.json和原有同步入口，Transaction增加可选movements（每种资产的实际进出）及walletOwner字段，旧币安资料无需迁移。按链、钱包地址、交易编号稳定去重。一条操作内部保存多个币种，原币精度保留，费用只附一次，不改资产、人工成本或收益。

**免费来源：** BTC沿用Blockstream/mempool.space公开接口；Solana沿用公共节点；EVM使用各链公开Blockscout实例，Ethereum可用Routescan免密钥接口备用，Avalanche用Routescan。BSC没有本轮已核实的免密钥来源，明确提示尚未接入，不添加收费服务。公开接口停止开放或限流时保留旧资料并报告，不引导自动升级付费。

- [x] 1. 先准备scripts/check-wallet-transactions.mjs隔离断言：BTC找零/确认更新、EVM同名代币按地址分开/根调用去重/授权隐藏/兑换确认、Solana租金不当收支/失败仅费用/NFT拒绝、同交易多资产/钱包不读钥匙串与余额不变；不执行。
- [x] 2. src/data/transactions.ts兼容新类型及可选资产变动，校验并搜索；生成仅允许固定浏览器域名的交易链接。server/wallet-transaction-common.mjs保留原币精度并净额整理，一次操作归为收到/转出/已确认兑换；无法确认的混合操作不伪造兑换。
- [x] 3. server/wallet-transactions.mjs控制请求预算、每条链覆盖状态与失败保留。server/wallet-evm-transactions.mjs按主币、代币、内部转账三路分页后归组，补全交易详情再输出；任何一路未读全，不以不完整的新操作替换旧完整操作。NFT、授权与未知混合操作隐藏；仅已知官方兑换合约/方法确认兑换。
- [x] 4. server/wallet-other-transactions.mjs读取BTC与Solana。BTC按该地址输入减输出求净变动，排除返回同址的找零，无法分摊多输入费用不编造；只处理添加地址，不承诺整个钱包。Solana解析明确转账指令，不用SOL余额变化冒充收款（租金、关闭账户返还不算转账）；从钱包及当前普通代币账户收集交易，已关闭账户/Token-2022复杂动作无法完整覆盖，明确标注。
- [x] 5. connection-service.mjs在现有互斥保护下区分钱包与币安，钱包不读取钥匙串；TransactionsPage.tsx允许选择钱包，同一列表/详情展示各资产进出、实际费用、状态和链上查询链接。其他交易所仍暂不支持。
- [x] 6. npm run check与build、文件语法检查及独立只读审查；不运行模拟脚本、浏览器或本人地址查询；更新README与本计划的实际边界。

**完成边界：** 仅代码与静态检查阶段完成。独立只读审查修正了兑换单边误分类、Solana未知零小数币种混入NFT两处问题。兑换确认目前仅限Ethereum已核对Uniswap V2/V3路由及Solana已支持Jupiter程序。模拟样例、真实免费来源可用性、浏览器效果和本人钱包记录均未验证。

**同步边界：** 每次最多查询最近7天；已确认旧操作可复用本机明细，不变动持仓。BTC重查最近7天以更新待确认操作；其他链用已确认/最终确认资料。每次每链有限分页，整体最多160次请求、约190秒，达到上限明确部分资料，单链失败不清空旧记录。完整性按具体来源/当前可发现账户描述，不写整个钱包已同步完整。

**来源文档：** https://github.com/Blockstream/esplora/blob/master/API.md ; https://solana.com/docs/rpc/http/getsignaturesforaddress ; https://solana.com/docs/rpc/http/gettransaction ; https://docs.blockscout.com/devs/apis/rest ; https://docs.blockscout.com/blockscout-v12-0-0-api-updates-and-breaking-changes ; https://routescan.io/docs/api/etherscan/accounts ; https://routescan.io/docs/api/conventions ; https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
