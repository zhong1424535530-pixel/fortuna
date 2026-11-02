import type { ContractExitOrder } from './contract-protection.ts'

export const networks = [
  { id: 'eth', name: 'Ethereum', chainId: 1, symbol: 'ETH', coinId: 'ethereum', rpc: 'https://ethereum-rpc.publicnode.com', icon: '/icons/eth.png' },
  { id: 'bsc', name: 'BSC', chainId: 56, symbol: 'BNB', coinId: 'binancecoin', rpc: 'https://bsc-rpc.publicnode.com', icon: '/icons/bnb.png' },
  { id: 'arbitrum', name: 'Arbitrum', chainId: 42161, symbol: 'ETH', coinId: 'ethereum', rpc: 'https://arb1.arbitrum.io/rpc', icon: '/icons/eth.png' },
  { id: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', coinId: 'ethereum', rpc: 'https://mainnet.base.org', icon: '/icons/eth.png' },
  { id: 'optimism', name: 'Optimism', chainId: 10, symbol: 'ETH', coinId: 'ethereum', rpc: 'https://mainnet.optimism.io', icon: '/icons/eth.png' },
  { id: 'polygon', name: 'Polygon PoS', chainId: 137, symbol: 'POL', coinId: 'polygon-ecosystem-token', rpc: 'https://polygon.drpc.org', icon: '' },
  { id: 'avalanche', name: 'Avalanche C-Chain', chainId: 43114, symbol: 'AVAX', coinId: 'avalanche-2', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', icon: '' },
  { id: 'gnosis', name: 'Gnosis', chainId: 100, symbol: 'XDAI', coinId: 'xdai', rpc: 'https://gnosis-rpc.publicnode.com', icon: '' },
  { id: 'scroll', name: 'Scroll', chainId: 534352, symbol: 'ETH', coinId: 'ethereum', rpc: 'https://rpc.scroll.io', icon: '/icons/eth.png' },
  { id: 'zksync', name: 'zkSync Era', chainId: 324, symbol: 'ETH', coinId: 'ethereum', rpc: 'https://mainnet.era.zksync.io', icon: '/icons/eth.png' },
] as const
export const walletFamilies = [{ id: 'evm', name: '以太坊相关网络', subtitle: 'ETH、BSC、Base 等', icon: '/icons/wallet-networks.png' }, { id: 'btc', name: '比特币', subtitle: 'BTC 地址', icon: '/icons/btc.png' }, { id: 'solana', name: 'Solana', subtitle: 'SOL 与链上代币', icon: '/icons/sol.png' }] as const
export type WalletFamily = (typeof walletFamilies)[number]['id']
export type DataMode = 'real'
export type NetworkId = (typeof networks)[number]['id']
export type LiveStatus = 'pending' | 'ok' | 'partial' | 'error'
export const binanceGroups = ['现货', '合约', '股票', '理财', '杠杆'] as const
export type BinanceGroup = (typeof binanceGroups)[number]
export type WalletCoverage = { suffix: string; label: string; group: BinanceGroup; status: 'ok' | 'pending' | 'error'; warning: string }
export type MarginPool = { id: string; label: string; asset: string; maintenance: string | null; balance: string | null }
export type LiveAccount = { id: string; sourceId: string; name: string; kind: string; icon: string; color: string; status: LiveStatus; updatedAt: string | null; warning: string; identity?: string; uid?: string; address?: string; network?: string; pnlCents: number | null; accountGroup?: BinanceGroup; originName?: string; walletCoverage?: WalletCoverage[]; marginPools?: MarginPool[] }
export type DayOpenPrice = { date: string; usdPrice: number; at: number }
export type LiveHolding = { id: string; symbol: string; name: string; category: '加密资产' | '现金与稳定币' | '股票'; market: 'crypto' | 'us'; usdPrice: number | null; priceUpdatedAt?: string; dayOpen?: DayOpenPrice; change24h: number | null; icon: string; color: string; source: string; description: string; network?: string; positions: { accountId: string; quantity: number; quantityText: string; valueCents: number | null }[] }
export type LiveContract = { id: string; symbol: string; name: string; icon: string; accountId: string; direction: '做多' | '做空'; quantity: number; baseAsset: string; entryPriceUsd: number | null; markPriceUsd: number | null; priceUpdatedAt?: string; leverage: number | null; marginMode: '逐仓' | '全仓' | '未知'; marginCents: number | null; liquidationPriceUsd: number | null; unrealizedPnlCents: number | null; exitOrders?: ContractExitOrder[] | null }
export const exchanges = [
  { id: 'binance', name: '币安', icon: '/icons/binance.svg', passphrase: false },
  { id: 'okx', name: '欧易', icon: '/icons/okx.svg', passphrase: true },
  { id: 'gate', name: '芝麻', icon: '/icons/gate.svg', passphrase: false },
  { id: 'bitget', name: 'Bitget', icon: '/icons/bitget.svg', passphrase: true },
  { id: 'bybit', name: 'Bybit', icon: '/icons/bybit.svg', passphrase: false },
  { id: 'bitunix', name: 'Bitunix', icon: '', passphrase: false },
] as const
export type ConnectionType = (typeof exchanges)[number]['id'] | 'wallet'
export const connectionRefreshMs = (type: ConnectionType) => type === 'wallet' ? 300000 : 60000
export type AddAccountType = ConnectionType | 'manual'
export type Connection = { id: string; type: ConnectionType; name: string; address?: string; chains?: NetworkId[]; walletFamily?: WalletFamily; trackedTokens?: { chain: NetworkId; address: string }[]; provider?: 'rpc' | 'moralis'; hasCredential: boolean; status: LiveStatus; updatedAt: string | null; warning: string }
export type LiveSnapshot = { accounts: LiveAccount[]; holdings: LiveHolding[]; contracts: LiveContract[] }
export type LiveState = { connections: Connection[]; snapshot: LiveSnapshot }
export const emptyLive = (): LiveState => ({ connections: [], snapshot: { accounts: [], holdings: [], contracts: [] } })
