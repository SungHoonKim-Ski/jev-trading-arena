import type { Market } from '../types.ts';
import { CRYPTO_ASSETS } from '../market/binance.ts';

export type PresetKind = 'stock' | 'etf' | 'coin';

export interface Preset {
  readonly ticker: string;
  readonly name: string;
  readonly kind: PresetKind;
}

/** 사용자가 고를 수 있는 종목: 시장별 대표 개별 종목과 ETF (직접 입력은 받지 않는다) */
export const TICKER_PRESETS: Record<Market, readonly Preset[]> = {
  KR: [
    { ticker: '005930', name: '삼성전자', kind: 'stock' }, { ticker: '000660', name: 'SK하이닉스', kind: 'stock' },
    { ticker: '035420', name: 'NAVER', kind: 'stock' }, { ticker: '035720', name: '카카오', kind: 'stock' },
    { ticker: '005380', name: '현대차', kind: 'stock' }, { ticker: '068270', name: '셀트리온', kind: 'stock' },
    { ticker: '069500', name: 'KODEX 200', kind: 'etf' }, { ticker: '229200', name: 'KODEX 코스닥150', kind: 'etf' },
    { ticker: '360750', name: 'TIGER 미국S&P500', kind: 'etf' }, { ticker: '133690', name: 'TIGER 미국나스닥100', kind: 'etf' },
  ],
  US: [
    { ticker: 'AAPL', name: 'Apple', kind: 'stock' }, { ticker: 'MSFT', name: 'Microsoft', kind: 'stock' },
    { ticker: 'NVDA', name: 'NVIDIA', kind: 'stock' }, { ticker: 'AMZN', name: 'Amazon', kind: 'stock' },
    { ticker: 'GOOGL', name: 'Alphabet', kind: 'stock' }, { ticker: 'TSLA', name: 'Tesla', kind: 'stock' },
    { ticker: 'META', name: 'Meta', kind: 'stock' },
    { ticker: 'SPY', name: 'S&P 500 (SPY)', kind: 'etf' }, { ticker: 'QQQ', name: '나스닥 100 (QQQ)', kind: 'etf' },
    { ticker: 'DIA', name: '다우존스 (DIA)', kind: 'etf' }, { ticker: 'SCHD', name: '미국 배당 (SCHD)', kind: 'etf' },
  ],
  // 코인은 바이낸스 USDT 마켓 대표 5종만 제공
  CRYPTO: CRYPTO_ASSETS.map((a) => ({ ticker: a.ticker, name: a.name, kind: 'coin' as const })),
};
