import { t } from '../i18n'
import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Building2, ImagePlus, Landmark, Wallet, X } from 'lucide-react'
import { Avatar, Button, Modal } from './ui'
import Select from './Select'
import { saveConnection } from '../data/live'
import type { ConnectionInput } from '../data/live'
import { exchanges, networks, walletFamilies } from '../data/live-types'
import type { AddAccountType, Connection, ConnectionType, NetworkId, WalletFamily } from '../data/live-types'
import { savePortfolioWorkspace } from '../data/portfolio'
import { portfolioChange, readIcon, workspace } from '../data/workspace'
import type { ManualAccount } from '../data/workspace'
import '../connections.css'

type Kind = 'exchange' | 'wallet' | 'manual'
const kinds = [{ id: 'exchange', name: '交易所', icon: Landmark }, { id: 'wallet', name: '钱包', icon: Wallet }, { id: 'manual', name: '手动账户', icon: Building2 }] as const
const networkLogos: Record<string, string> = { arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', polygon: 'polygon', avalanche: 'avalanchec', gnosis: 'xdai', scroll: 'scroll', zksync: 'zksync' }
const networkOptions = networks.map(item => ({ value: item.id, label: item.name, icon: networkLogos[item.id] ? '/api/token-icon?url=' + encodeURIComponent(`https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${networkLogos[item.id]}/info/logo.png`) : item.icon }))
export default function ConnectionDialog({ connection, manualAccount, initialType = 'binance', onClose }: { connection?: Connection; manualAccount?: ManualAccount; initialType?: AddAccountType; onClose: () => void }) {
  const initial = connection?.type ?? initialType
  const [kind, setKind] = useState<Kind>(manualAccount || initial === 'manual' ? 'manual' : initial === 'wallet' ? 'wallet' : 'exchange')
  const [type, setType] = useState<ConnectionType>(initial === 'manual' || initial === 'wallet' ? 'binance' : initial)
  const [name, setName] = useState(connection?.name ?? manualAccount?.name ?? '')
  const [icon, setIcon] = useState(manualAccount?.icon ?? '')
  const [family, setFamily] = useState<WalletFamily>(connection?.walletFamily ?? 'evm')
  const [address, setAddress] = useState(connection?.address ?? '')
  const [chains, setChains] = useState<NetworkId[]>(connection?.chains ?? ['eth'])
  const [trackedTokens, setTrackedTokens] = useState(connection?.trackedTokens ?? [])
  const [tokenChain, setTokenChain] = useState<NetworkId>(connection?.chains?.[0] ?? 'eth')
  const [tokenAddress, setTokenAddress] = useState('')
  const [apiKey, setApiKey] = useState(''), [apiSecret, setApiSecret] = useState(''), [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const exchange = exchanges.find(item => item.id === type)!
  const editing = !!connection || !!manualAccount
  const replacingKeys = !!apiKey || !!apiSecret || !!passphrase
  async function pickIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    try { setIcon(await readIcon(file)) } catch (reason) { setError((reason as Error).message) }
    finally { event.target.value = '' }
  }
  function changeKind(next: Kind) { setKind(next); setApiKey(''); setApiSecret(''); setPassphrase(''); setError('') }
  function addToken() {
    const value = tokenAddress.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) { setError('请填写这个币在所选网络上的有效识别地址。'); return }
    if (trackedTokens.some(token => token.chain === tokenChain && token.address.toLowerCase() === value.toLowerCase())) { setError('这个代币已经补充过。'); return }
    setTrackedTokens([...trackedTokens, { chain: tokenChain, address: value }]); setTokenAddress(''); setError('')
    if (!chains.includes(tokenChain)) setChains([...chains, tokenChain])
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      if (kind === 'manual') {
        const trimmed = name.trim()
        if (!trimmed || trimmed.length > 80) throw new Error(t('请填写账户名称，最多80个字。'))
        const prior = workspace.manualAccounts ?? []
        if (prior.some(account => account.id !== manualAccount?.id && account.name === trimmed)) throw new Error(t('已经有同名的手动账户，请换一个名称。'))
        const account = { id: manualAccount?.id ?? 'manual-account-' + crypto.randomUUID(), name: trimmed, ...(icon ? { icon } : {}), updatedAt: new Date().toISOString() }
        await savePortfolioWorkspace({ ...workspace, manualAccounts: manualAccount ? prior.map(item => item.id === account.id ? account : item) : [...prior, account], changes: [portfolioChange(manualAccount ? '修改手动账户' : '创建手动账户', trimmed), ...workspace.changes].slice(0, 500) })
      } else {
        if (kind === 'wallet' && tokenAddress.trim()) throw new Error(t('还有一个识别地址未加入，请点击右侧加号，或清空后再保存。'))
        const input: ConnectionInput = { type: kind === 'wallet' ? 'wallet' : type, name, ...(kind === 'exchange' ? { apiKey, apiSecret, passphrase } : { address: address.trim(), chains: family === 'evm' ? chains : [], walletFamily: family, provider: 'rpc', trackedTokens: family === 'evm' ? trackedTokens.filter(token => chains.includes(token.chain)) : [] }) }
        await saveConnection(input, connection?.id)
      }
      setApiKey(''); setApiSecret(''); setPassphrase(''); onClose()
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title={editing ? '修改账户' : '添加账户'} className="connection-dialog">
    <form className="connection-form" onSubmit={submit} autoComplete="off">
      <fieldset className="connection-body" disabled={busy}>
        <div className="connection-kind-switch" role="group" aria-label={t('账户来源')}>{kinds.map(item => <button type="button" key={item.id} disabled={editing} aria-pressed={kind === item.id} className={kind === item.id ? 'active' : ''} onClick={() => changeKind(item.id)}><item.icon size={17} aria-hidden /><span>{item.name}</span></button>)}</div>
        {kind === 'exchange' && <label>{t('选择交易所')}<Select label={t('选择交易所')} value={type} disabled={!!connection} onChange={value => { setType(value as ConnectionType); setApiKey(''); setApiSecret(''); setPassphrase(''); setError('') }} options={exchanges.map(item => ({ value: item.id, label: item.name, icon: item.icon || <Landmark size={18} /> }))} /></label>}
        {kind === 'wallet' && <>
          <label>{t('钱包网络')}<Select label={t('钱包网络')} value={family} disabled={!!connection} onChange={value => { setFamily(value as WalletFamily); setAddress(''); setTrackedTokens([]); setTokenAddress(''); setError('') }} options={walletFamilies.map(item => ({ value: item.id, label: item.name, description: item.subtitle, icon: item.icon }))} /></label>
          {family === 'evm' && <div className="connection-network-field"><div className="connection-network-label"><span>{t('查询网络')}</span><button type="button" onClick={() => setChains(chains.length === networks.length ? [] : networks.map(item => item.id))}>{chains.length === networks.length ? '取消全选' : '全选'}</button></div><div className="connection-networks">{networks.map(network => <label key={network.id} className={chains.includes(network.id) ? 'selected' : ''}><input type="checkbox" checked={chains.includes(network.id)} onChange={event => setChains(event.target.checked ? [...chains, network.id] : chains.filter(id => id !== network.id))} /><span>{network.name}</span></label>)}</div></div>}
          <label>{t('公开钱包地址')}<input required readOnly={!!connection} maxLength={90} value={address} onChange={event => setAddress(event.target.value)} placeholder={family === 'evm' ? '0x 开头的地址' : family === 'btc' ? 'bc1、1 或 3 开头的比特币地址' : '填写 Solana 钱包地址'} spellCheck={false} /></label>
        </>}
        <label>{kind === 'wallet' ? '钱包名称' : '账户名称'}<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={kind === 'manual' ? '例如：不动产、银行存款' : kind === 'wallet' ? '例如：我的主钱包' : `例如：我的${exchange.name}`} /></label>
        {kind === 'manual' && <div className="connection-icon-field"><Avatar key={icon} src={icon} name={name || '账户'} size={40} /><label className="connection-icon-button"><ImagePlus size={15} aria-hidden />{icon ? '更换图标' : '上传图标'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('上传账户图标，最大 1 MB')} onChange={event => void pickIcon(event)} /></label>{icon && <Button onClick={() => setIcon('')}>{t('清除')}</Button>}<small>{t('可选 · PNG / JPEG / WEBP · 最大 1 MB')}</small></div>}
        {kind === 'exchange' && <>
          <label>API Key<input type="password" autoComplete="new-password" spellCheck={false} required={!connection || replacingKeys} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={connection ? '留空保留原密钥' : '填写只读 API Key'} /></label>
          <label>API Secret<input type="password" autoComplete="new-password" spellCheck={false} required={!connection || replacingKeys} value={apiSecret} onChange={event => setApiSecret(event.target.value)} placeholder={connection ? '留空保留原密钥' : '填写对应的 API Secret'} /></label>
          {exchange.passphrase && <label>{t('API 口令')}<input type="password" autoComplete="new-password" spellCheck={false} required={!connection || replacingKeys} value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder={connection ? '留空保留原口令' : '创建密钥时设置的 Passphrase'} /></label>}
          {!connection && ['gate', 'bitunix'].includes(exchange.id) && <p className="connection-warning" role="note">{t('本站无法替你确认')}{exchange.name}{t('密钥是否只读。创建密钥时只勾选“读取/查看”，不要开启交易、转账、提现；并把密钥的 IP 白名单设为服务器地址。')}</p>}
        </>}
        {kind === 'wallet' && family === 'evm' && <details className="connection-extra-tokens"><summary>{t('补充未收录的代币')} <span>{t('可选')}</span></summary><div className="connection-token-entry"><Select label={t('代币所属网络')} value={tokenChain} onChange={value => setTokenChain(value as NetworkId)} options={networkOptions} /><input aria-label={t('代币识别地址')} value={tokenAddress} maxLength={42} onChange={event => setTokenAddress(event.target.value)} placeholder={t('代币识别地址 0x…')} /><Button aria-label={t('加入代币识别地址')} disabled={trackedTokens.length >= 50} onClick={addToken}>{t('添加')}</Button></div>{trackedTokens.map(token => <div className="connection-tracked-token" key={token.chain + token.address}><span>{networks.find(item => item.id === token.chain)?.name}</span><code title={token.address}>{token.address.slice(0, 10)}…{token.address.slice(-6)}</code><Button variant="ghost" aria-label={`移除${token.address}的扫描记录`} onClick={() => setTrackedTokens(trackedTokens.filter(item => item !== token))}><X size={12} /></Button></div>)}</details>}

        {error && <p className="connection-warning" role="alert">{error}</p>}
      </fieldset>
      <div className="connection-form-actions"><Button disabled={busy} onClick={onClose}>{t('取消')}</Button><Button type="submit" variant="primary" disabled={busy || kind === 'wallet' && family === 'evm' && !chains.length}>{busy ? kind === 'manual' ? '正在保存…' : '正在保存与读取…' : editing ? '保存修改' : kind === 'manual' ? '创建账户' : '添加并读取'}</Button></div>
    </form>
  </Modal>
}
