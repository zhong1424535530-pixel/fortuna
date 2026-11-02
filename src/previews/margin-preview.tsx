import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MarginRatios from '../components/MarginRatios'
import type { LiveAccount, LiveContract } from '../data/live-types'
import '../styles.css'

// 独立展示入口：不加载App或启动账户读取/保存。
function Preview() {
  const [hidden, setHidden] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(() => new Date().toISOString())
  useEffect(() => {
    const timer = window.setInterval(() => setUpdatedAt(new Date().toISOString()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const examples = [
    { name: '模拟账户 A', label: 'USDT 全仓', maintenance: '51.30', balance: '1900', isolated: false },
    { name: '模拟账户 B', label: 'USDT 全仓', maintenance: '274', balance: '500', isolated: false },
    { name: '模拟账户 C', label: 'BTCUSDT 做多 · 逐仓', maintenance: '184.80', balance: '200', isolated: true },
    { name: '模拟账户 D', label: 'USDT 全仓', maintenance: null, balance: null, isolated: false },
  ]
  const accounts: LiveAccount[] = examples.map((item, index) => ({ id: `preview-${index}`, sourceId: `preview-source-${index}`, name: item.name, kind: '合约账户', icon: '', color: '#91ad9c', status: 'ok', updatedAt, warning: '', pnlCents: 0, marginPools: [{ id: 'preview-pool', label: item.label, asset: 'USDT', maintenance: item.maintenance, balance: item.balance }] }))
  const contracts: LiveContract[] = examples.map((item, index) => ({ id: `preview-position-${index}`, accountId: accounts[index].id, symbol: 'BTCUSDT', name: '模拟合约', icon: '', direction: '做多', quantity: 1, baseAsset: 'BTC', entryPriceUsd: null, markPriceUsd: null, leverage: null, marginMode: item.isolated ? '逐仓' : '全仓', marginCents: null, liquidationPriceUsd: null, unrealizedPnlCents: null }))
  return <main className="main-content assets-page contracts-page" style={{ maxWidth: 1080, margin: '32px auto', padding: '24px' }}>
    <div className="page-heading"><div><p className="eyebrow">仅展示排版 · 全部金额均为模拟</p><h1>多账户保证金预览</h1></div><a className="button button-secondary" href="/#assets/contracts">返回真实页面</a></div>
    <section className="panel holdings-overview contract-pnl-overview">
      <div className="holdings-balance"><div className="holdings-balance-caption"><span>浮动盈亏 · 模拟</span><button type="button" className="text-action" onClick={() => setHidden(value => !value)}>{hidden ? '显示金额' : '隐藏金额'}</button></div><strong className="numeric positive">{hidden ? '••••••' : '+$128.56'}</strong></div>
      <MarginRatios accounts={accounts} contracts={contracts} hidden={hidden} />
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<Preview />)
