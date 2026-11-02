# 样稿图标来源

## 2026-10-20 自动补图

- 方法参考 [rotki 图标管理](https://github.com/rotki/rotki/blob/develop/rotkehlchen/icons.py)：先确认币种，再获取图片，保存在本机。
- 交易所币种、网络合约和 CoinGecko 编号复用 `server/data/wallet-tokens.json` 的 rotki 公开资料。固定版本、下载地址与校验值保存在该文件；更新脚本为 `scripts/update-wallet-catalog.py`。仅提取资料，没有执行上游数据库中的脚本。
- 加密货币：通过 CoinGecko 免费公开接口读取 `image.small`，不上传账户名称、余额、钱包地址或密钥。发送的仅为币种编号或代币合约地址。
- 链上代币：先按网络和合约／Solana mint 匹配 [Trust Wallet Assets](https://github.com/trustwallet/assets)，缺图时再查 CoinGecko；不拿同名币猜测。
- 美股：使用 [nvstly 股票 PNG 图库](https://github.com/nvstly/icons/tree/main/ticker_icons)。DRAM 使用 [Roundhill 官方网站](https://www.roundhillinvestments.com/etf/dram/)的发行方图标，并非基金专属图标。股票不会去加密货币图库匹配。
- 自动下载的图片与人工资料分开，保存在本机资料目录的 `asset-icons/`。手动上传优先；未找到或无法确认时显示字母。免费公开服务可能限流，不保证全部资产都有图。
- 图标读取仅允许固定来源、限制文件大小、拒绝网页／SVG内容及跳转；不会改变价格、余额或账户资料。
- 不增加付费服务或订阅。上游图库和品牌标志仍遵循各自许可。

## 2026-10-20 多网络钱包集合图标

`wallet-networks.png` 使用内置 imagegen 生成，透明背景，包含 Ethereum、BNB/BSC、Arbitrum、Base、Optimism 和 Polygon 标志的组合示意。账户卡片按34×34像素显示，代表多网络钱包，不表示每条网络都有余额。生成图作为本机页面素材，不作为品牌官方原图。

最终提示词：

```text
Use case: logo-brand. Generate ONE production UI icon image for a personal asset dashboard. A compact multi-network wallet emblem, containing six recognizable blockchain network marks clustered tightly as ONE cohesive square icon: Ethereum diamond, BNB/BSC yellow geometric mark, Arbitrum blue hexagon/diagonal stripes mark, Base blue circle with white horizontal cut, Optimism red circle with simple white OP mark, Polygon purple interlocking hexagons. Flat clean vector-like raster artwork, exact simple geometric shapes, no 3D, no gradients, no glow, no shadows. Arrange as a compact balanced 2 by 3 cluster of six distinct badges with small gaps, centered, taking up 90% of image width and height, so they remain legible when the entire image is displayed at ONLY 34 by 34 CSS pixels. Use each network's recognizable color, high contrast appropriate on a very dark green-black background. Transparent background around and between the marks. No title, no caption, no watermark, no outside frame, no mockup or UI screenshot. Square aspect ratio. Produce the finished icon only.
```

---

下载日期：2026-10-17。所有图片均为本地文件，未接入账户、行情或交易服务。

## 文件与来源

| 本地文件 | 内容 | 原始文件 | 图库许可 |
| --- | --- | --- | --- |
| `btc.png` | BTC | [来源](https://raw.githubusercontent.com/spothq/cryptocurrency-icons/1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/btc.png) | CC0 1.0 |
| `eth.png` | ETH | [来源](https://raw.githubusercontent.com/spothq/cryptocurrency-icons/1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/eth.png) | CC0 1.0 |
| `sol.png` | SOL | [来源](https://raw.githubusercontent.com/spothq/cryptocurrency-icons/1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/sol.png) | CC0 1.0 |
| `usdt.png` | USDT | [来源](https://raw.githubusercontent.com/spothq/cryptocurrency-icons/1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/usdt.png) | CC0 1.0 |
| `usdc.png` | USDC | [来源](https://raw.githubusercontent.com/spothq/cryptocurrency-icons/1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/usdc.png) | CC0 1.0 |
| `bnb.png` | BNB | [来源](https://raw.githubusercontent.com/spothq/cryptocurrency-icons/1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/bnb.png) | CC0 1.0 |
| `binance.svg` | BINANCE | [来源](https://raw.githubusercontent.com/0xa3k5/web3icons/3cce0f390cf902f204a1b3d52f485bcc95d2fe9e/packages/core/src/svgs/exchanges/branded/binance.svg) | MIT（Web3 Icons） |
| `okx.svg` | OKX | [来源](https://raw.githubusercontent.com/0xa3k5/web3icons/3cce0f390cf902f204a1b3d52f485bcc95d2fe9e/packages/core/src/svgs/exchanges/branded/okx.svg) | MIT（Web3 Icons） |
| `gate.svg` | Gate.io 图库标识（旧版） | [来源](https://raw.githubusercontent.com/0xa3k5/web3icons/3cce0f390cf902f204a1b3d52f485bcc95d2fe9e/packages/core/src/svgs/exchanges/branded/gate-io.svg) | MIT（Web3 Icons） |
| `bitget.svg` | BITGET | [来源](https://raw.githubusercontent.com/0xa3k5/web3icons/3cce0f390cf902f204a1b3d52f485bcc95d2fe9e/packages/core/src/svgs/exchanges/branded/bitget.svg) | MIT（Web3 Icons） |
| `bybit.svg` | BYBIT | [来源](https://raw.githubusercontent.com/0xa3k5/web3icons/3cce0f390cf902f204a1b3d52f485bcc95d2fe9e/packages/core/src/svgs/exchanges/branded/bybit.svg) | MIT（Web3 Icons） |
| `apple.svg` | Apple 公司图标，仅用于 rAAPL 关联公司示意 | [来源](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/icons/apple.svg) | CC0 1.0 |

## 使用说明

- 币种 PNG 为 128 × 128。交易所图标保留原文件配色；Bybit 与 OKX 含白色部分，建议放在深色底上。
- `apple.svg` 是 Apple 公司标识，**不是 rAAPL 的发行方标识，也不是 rAAPL 官方代币图标**。页面应写明“公司示意”。
- `gate.svg` 来自图标库的 Gate.io 条目，属于旧版标识；没有自行拼画或假造新标识。
- 图库的开源许可不等于获得品牌方的商标授权。本次只用于个人仪表盘样稿，未核实各品牌对公开商业展示的额外要求。

## 许可来源

- Cryptocurrency Icons：[CC0 1.0](https://github.com/spothq/cryptocurrency-icons/blob/1a63530be6e374711a8554f31b17e4cb92c25fa5/LICENSE.md)。
- Simple Icons：[CC0 1.0](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/LICENSE.md)。
- Web3 Icons：[MIT](https://github.com/0xa3k5/web3icons/blob/3cce0f390cf902f204a1b3d52f485bcc95d2fe9e/LICENCE)。保留原许可全文如下。

```text
MIT License

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
