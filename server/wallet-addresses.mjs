import { createHash } from 'node:crypto'
import { base58, base58check, bech32, bech32m } from '@scure/base'
import { ConnectionError } from './connection-http.mjs'
const checkedBase58 = base58check(bytes => new Uint8Array(createHash('sha256').update(bytes).digest()))
export function walletAddress(value, family = 'evm') {
  const address = typeof value === 'string' ? value.trim() : ''
  try {
    if (address.length < 14 || address.length > 90) throw new Error()
    if (family === 'evm') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new Error()
      return address.toLowerCase()
    }
    if (family === 'solana') {
      if (address.length < 32 || address.length > 44 || base58.decode(address).length !== 32 || /^1+$/.test(address)) throw new Error()
      return address
    }
    if (family !== 'btc') throw new Error()
    if (/^(bc1)/i.test(address)) {
      const codec = address.toLowerCase().startsWith('bc1q') ? bech32 : bech32m
      const decoded = codec.decode(address, 90), version = decoded.words[0]
      const program = codec.fromWords(decoded.words.slice(1))
      if (decoded.prefix !== 'bc' || version > 16 || program.length < 2 || program.length > 40 || version === 0 && ![20, 32].includes(program.length)) throw new Error()
      return address.toLowerCase()
    }
    const decoded = checkedBase58.decode(address)
    if (decoded.length !== 21 || ![0, 5].includes(decoded[0])) throw new Error()
    return address
  } catch { throw new ConnectionError(family === 'btc' ? '请填写有效的比特币主网公开地址；暂不支持钱包总公钥。' : family === 'solana' ? '请填写有效的Solana公开地址。' : '请填写有效的0x公开地址，不要填写私钥或助记词。') }
}
