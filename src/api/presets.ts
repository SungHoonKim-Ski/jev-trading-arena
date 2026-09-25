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
  CRYPTO: [
    { ticker: 'BTC-USD', name: '비트코인' }, { ticker: 'ETH-USD', name: '이더리움' },
    { ticker: 'SOL-USD', name: '솔라나' }, { ticker: 'XRP-USD', name: '리플' },
    { ticker: 'BNB-USD', name: 'BNB' }, { ticker: 'DOGE-USD', name: '도지코인' },
    { ticker: 'ADA-USD', name: '에이다' }, { ticker: 'AVAX-USD', name: '아발란체' },
  ],
};
