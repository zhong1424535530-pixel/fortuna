import { ConnectionError, decimal, holding } from './connection-http.mjs'

export const walletScopes = [
  { suffix: 'funding', label: '资金账户 · 普通资产', group: '现货', names: ['funding', '资金账户'] },
  { suffix: 'funding-stocks', label: '资金账户 · 股票及美元', group: '股票', names: ['funding', '资金账户'] },
  { suffix: 'alpha', label: 'Alpha账户', group: '现货', names: ['alpha', 'alphaaccount', 'alpha账户'] },
  { suffix: 'stocks', label: '股票账户', group: '股票', names: ['stock', 'stocks', 'equity', '股票账户'] },
]
const walletKey = name => String(name).toLowerCase().replace(/[\s_-]/g, '')

// shortcut: 只接入可确认的独立钱包明细；理财、借贷等需专门读取本金和欠款后再纳入。
export function parseWalletScope(wallets, scope, accountId, usd, stockSymbols) {
  const matches = wallets.filter(wallet => scope.names.includes(walletKey(wallet.walletName)))
  if (!matches.length) return null
  if (matches.length !== 1 || !Array.isArray(matches[0].assetBalances)) throw new ConnectionError('未取得完整的逐项资产明细，暂不使用钱包总额代替。', 502)
  const wallet = matches[0], seen = new Set(), holdings = []
  for (const item of wallet.assetBalances) {
    if (typeof item.asset !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(item.asset) || seen.has(item.asset)) throw new ConnectionError('钱包资产代码重复或无法识别。', 502)
    seen.add(item.asset)
    const qty = ['free', 'locked', 'freeze', 'withdrawing'].reduce((sum, field) => sum.plus(decimal(item[field], '钱包数量')), decimal(0))
    if (qty.isZero()) continue
    const symbol = item.asset.replace(/^EQ_/, '')
    const cash = ['USD', 'USDT', 'USDC', 'FDUSD'].includes(symbol)
    const explicitStock = item.asset.startsWith('EQ_') || scope.suffix === 'stocks' && !cash
    if (scope.suffix.startsWith('funding') && !explicitStock && !cash && !stockSymbols && !usd.has(symbol)) throw new ConnectionError('股票目录暂不可用，无法确认资金账户中部分资产的类别。', 502)
    if (scope.suffix.startsWith('funding') && !explicitStock && !cash && stockSymbols?.has(symbol) && usd.has(symbol)) throw new ConnectionError('发现同名股票和代币，暂不猜测资产类别。', 502)
    const stock = explicitStock || scope.suffix.startsWith('funding') && stockSymbols?.has(symbol) && !usd.has(symbol)
    const stockSide = stock || symbol === 'USD'
    if (scope.suffix === 'funding' && stockSide || scope.suffix === 'funding-stocks' && !stockSide) continue
    holdings.push(holding(stock ? 'binance:equity:' + item.asset : 'binance:' + item.asset, accountId, stock ? symbol : item.asset, item.assetName || symbol, qty.toFixed(), stock ? null : usd.get(item.asset) ?? null, '币安钱包明细 · ' + wallet.walletName, stock ? { category: '股票', market: 'us' } : symbol === 'USD' ? { category: '现金与稳定币' } : {}))
  }
  return { holdings, originName: String(wallet.walletName).slice(0, 80) }
}

export function stockBidPrice(quote, symbol) {
  if (quote?.symbol !== symbol) throw new ConnectionError('股票报价与资产不匹配。', 502)
  const bid = decimal(quote.bidPrice, '股票买价')
  if (!bid.gt(0)) throw new ConnectionError('暂时没有有效的股票买价。', 502)
  return bid.toFixed()
}
