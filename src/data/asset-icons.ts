export function automaticAssetIcon(asset: { id: string; market: string; icon: string; name?: string }) {
  if (asset.icon.startsWith('/icons/') || asset.icon.startsWith('data:image/')) return asset.icon
  // A股标志来自服务端图库；查不到时，用股票名称前两个字作占位（放在 fb 参数里，不用代码数字）。
  if (asset.market === 'cn') {
    const placeholder = asset.name && !/^\d+$/.test(asset.name) ? '&fb=' + encodeURIComponent('data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#142219"/><text x="20" y="25" text-anchor="middle" font-size="13" font-family="PingFang SC, sans-serif" fill="#c2d2c8">${asset.name.slice(0, 2).replace(/[<>&"]/g, '')}</text></svg>`)) : ''
    return '/api/asset-icon?asset=' + encodeURIComponent(asset.id) + placeholder
  }
  // 房产、车辆没有行情图标，按名称配内置图标；其他资产仍显示名称占位。
  if (asset.market === 'other' && asset.name) return /车|car|vehicle|auto/i.test(asset.name) ? '/icons/car.svg' : /房|宅|公寓|house|apartment|property/i.test(asset.name) ? '/icons/house.svg' : asset.icon
  return ['crypto', 'us'].includes(asset.market) ? '/api/asset-icon?asset=' + encodeURIComponent(asset.id) : asset.icon
}
