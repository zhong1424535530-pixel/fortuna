import coinIds from './overview-coin-ids.json' with { type: 'json' }

const polygonNativeAlias = '0x0000000000000000000000000000000000001010'

export function isNativeAlias(chainId: number, address: string) {
  return chainId === 137 && address.toLowerCase() === polygonNativeAlias
}

export function coinKey(asset: { id: string; market: string }) {
  const id = asset.id.startsWith('evm:') ? asset.id.toLowerCase() : asset.id
  const canonical = id === 'evm:137:' + polygonNativeAlias ? 'evm:137:native' : id
  // shortcut: 只合并已有目录确认的币种；身份不明确的同名币保持独立，目录补齐后再扩展。
  const coin = asset.market === 'crypto' && Object.hasOwn(coinIds, canonical) ? (coinIds as Record<string, string>)[canonical] : undefined
  return coin ? 'coin:' + coin : asset.market + ':' + canonical
}

export function dedupeNativeHoldings<T extends { id: string; positions: { accountId: string }[] }>(items: readonly T[]): T[] {
  const nativeAccounts = new Set(items.filter(asset => asset.id.toLowerCase() === 'evm:137:native').flatMap(asset => asset.positions.map(position => position.accountId)))
  return items.flatMap(asset => {
    if (asset.id.toLowerCase() !== 'evm:137:' + polygonNativeAlias) return [asset]
    // POL 的 ERC20 查询入口返回原生余额；同一账户已读到原生余额时只能保留一份。
    const positions = asset.positions.filter(position => !nativeAccounts.has(position.accountId))
    return positions.length ? [{ ...asset, positions } as T] : []
  })
}
