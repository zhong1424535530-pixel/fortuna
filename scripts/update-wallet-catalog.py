"""只下载公开代币资料，不查询用户钱包，不执行上游SQL。"""
import hashlib
import json
import pathlib
import re
import sqlite3
import tempfile
import urllib.request

COMMIT = 'ce4136b5ecd7197c35d4e3f278723a6c39bd856c'
URL = f'https://raw.githubusercontent.com/rotki/rotki/{COMMIT}/rotkehlchen/data/global.db'
CHAINS = [1, 10, 56, 100, 137, 324, 8453, 42161, 43114, 534352]

def extract(raw):
    with tempfile.TemporaryDirectory(prefix='rotki-token-catalog-') as folder:
        path = pathlib.Path(folder) / 'global.db'
        path.write_bytes(raw)
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            evm = {}
            for chain in CHAINS:
                rows = db.execute('''SELECT t.address,t.decimals,c.symbol,a.name,c.coingecko
                    FROM evm_tokens t JOIN assets a ON a.identifier=t.identifier
                    JOIN common_asset_details c ON c.identifier=t.identifier
                    WHERE t.chain=? AND t.token_kind='A' AND (t.protocol IS NULL OR t.protocol!='spam')
                    ORDER BY t.address''', (chain,)).fetchall()
                evm[str(chain)] = [list(row) for row in rows if re.fullmatch(r'0x[0-9a-fA-F]{40}', row[0]) and isinstance(row[1], int) and 0 <= row[1] <= 36 and isinstance(row[2], str) and 0 < len(row[2]) <= 40 and isinstance(row[3], str) and 0 < len(row[3]) <= 120]
            solana = []
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='solana_tokens'").fetchone():
                rows = db.execute('''SELECT t.address,c.symbol,a.name,c.coingecko FROM solana_tokens t
                    JOIN assets a ON a.identifier=t.identifier JOIN common_asset_details c ON c.identifier=t.identifier''').fetchall()
                solana = [list(row) for row in rows if re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', row[0]) and isinstance(row[1], str) and isinstance(row[2], str)]
            # 保留交易所专属对应关系，不能拿另一家交易所的同名币直接套用。
            locations = {'E': 'binance', 'e': 'okx', 'm': 'bybit'}
            mappings = {}
            rows = db.execute('''SELECT m.location,m.exchange_symbol,c.coingecko
                FROM location_asset_mappings m JOIN common_asset_details c ON c.identifier=m.local_id''').fetchall()
            for location, symbol, coin_id in rows:
                if (location is not None and location not in locations) or not isinstance(symbol, str) or not isinstance(coin_id, str) or not coin_id:
                    continue
                key = (locations.get(location, 'common'), symbol.upper())
                mappings.setdefault(key, set()).add(coin_id)
            exchange_icons = {}
            for (location, symbol), ids in mappings.items():
                # 空字符串明确表示歧义，查询时不能再退回其他同名资产。
                exchange_icons.setdefault(location, {})[symbol] = next(iter(ids)) if len(ids) == 1 else ''
            symbols = {}
            for symbol, coin_id in db.execute('SELECT symbol,coingecko FROM common_asset_details WHERE coingecko IS NOT NULL AND coingecko != \'\''):
                if isinstance(symbol, str):
                    symbols.setdefault(symbol.upper(), set()).add(coin_id)
            unique_icons = {symbol: next(iter(ids)) if len(ids) == 1 else '' for symbol, ids in symbols.items()}
    return {'source': URL, 'commit': COMMIT, 'sha256': hashlib.sha256(raw).hexdigest(), 'evm': evm, 'solana': solana, 'exchangeIcons': exchange_icons, 'symbolIcons': unique_icons}

if __name__ == '__main__':
    with urllib.request.urlopen(URL, timeout=40) as response:
        raw = response.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError('公开目录超过允许大小，未替换原目录')
    result = extract(raw)
    path = pathlib.Path(__file__).resolve().parents[1] / 'server/data/wallet-tokens.json'
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    temp.replace(path)
    print(json.dumps({'evm_tokens': {chain: len(rows) for chain, rows in result['evm'].items()}, 'solana_metadata': len(result['solana'])}))
