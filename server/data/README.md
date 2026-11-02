# 免费钱包代币目录

`wallet-tokens.json` 是从 rotki 公开资产数据库提取的只读快照，来源提交、原文件校验值直接保存在文件头。提取的是公开的代币名称、地址、精度与行情标识，不包含用户地址或余额。

- 上游：https://github.com/rotki/rotki/tree/ce4136b5ecd7197c35d4e3f278723a6c39bd856c/rotkehlchen/data
- 上游长期维护目录：https://github.com/rotki/assets
- 余额查询借鉴：rotki 的 EvmTokens 分批检测方式。使用 Multicall3 的只读 aggregate3 调用，不发送交易。
- Multicall3 部署地址来源：https://github.com/mds1/multicall3/blob/main/deployments.json
- 价格：DeFiLlama 免费 coins 接口，CoinGecko 公共接口备用，主流币 Kraken 免费备用。
- 代币图标：Trust Wallet 公开 assets 仓库；没有对应图片时沿用页面占位和人工图标功能。

## 更新目录

由维护者在 `scripts/update-wallet-catalog.py` 更新已检查的 rotki 提交编号，然后执行 `python3 scripts/update-wallet-catalog.py`。脚本仅下载公开资料，以只读方式提取，不执行上游SQL。当前版本不会在每次打开页面时更新目录，也不会扫描全链交易历史。

当前覆盖 Ethereum、BSC、Arbitrum、Base、Optimism、Polygon、Avalanche C-Chain、Gnosis、Scroll、zkSync Era。Solana 查询钱包代币账户，不依赖目录来发现代币，目录仅补充名称和行情标识。

公开目录可能不完整或含过时条目。持仓与价格按链和识别地址区分。NFT、DeFi、BTC铭文等不保证覆盖。BTC只读单地址，可添加多个地址，不支持xpub自动派生。

复用时保留上游来源。rotki 主项目的许可证见上游 LICENSE.md；本文不将公开仓库误称为没有任何使用条件。
