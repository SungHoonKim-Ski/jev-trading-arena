import { CRYPTO_ASSETS } from '../market/binance.ts';
import type { Market } from '../types.ts';

export const TICKER_PRESETS: Record<Market, readonly { readonly ticker: string; readonly name: string }[]> = {
  KR: [
    { ticker: '005930', name: '삼성전자' }, { ticker: '000660', name: 'SK하이닉스' },
    { ticker: '035420', name: 'NAVER' }, { ticker: '035720', name: '카카오' },
    { ticker: '005380', name: '현대차' }, { ticker: '051910', name: 'LG화학' },
    { ticker: '068270', name: '셀트리온' }, { ticker: '105560', name: 'KB금융' },
  ],
  US: [
    { ticker: 'AAPL', name: 'Apple' }, { ticker: 'MSFT', name: 'Microsoft' },
    { ticker: 'NVDA', name: 'NVIDIA' }, { ticker: 'AMZN', name: 'Amazon' },
    { ticker: 'GOOGL', name: 'Alphabet' }, { ticker: 'TSLA', name: 'Tesla' },
    { ticker: 'META', name: 'Meta' }, { ticker: 'SPY', name: 'S&P 500 ETF' },
  ],
  // 코인은 바이낸스 USDT 마켓 대표 5종만 제공
  CRYPTO: CRYPTO_ASSETS.map((a) => ({ ticker: a.ticker, name: a.name })),
};
