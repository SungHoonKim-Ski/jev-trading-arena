import type { Market } from '../types.ts';
import { CRYPTO_ASSETS } from './binance.ts';

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
    { ticker: 'AAPL', name: '애플', kind: 'stock' }, { ticker: 'MSFT', name: '마이크로소프트', kind: 'stock' },
    { ticker: 'NVDA', name: '엔비디아', kind: 'stock' }, { ticker: 'AMZN', name: '아마존', kind: 'stock' },
    { ticker: 'GOOGL', name: '알파벳(구글)', kind: 'stock' }, { ticker: 'TSLA', name: '테슬라', kind: 'stock' },
    { ticker: 'META', name: '메타', kind: 'stock' },
    { ticker: 'SPY', name: 'S&P 500 (SPY)', kind: 'etf' }, { ticker: 'QQQ', name: '나스닥 100 (QQQ)', kind: 'etf' },
    { ticker: 'DIA', name: '다우존스 (DIA)', kind: 'etf' }, { ticker: 'SCHD', name: '미국 배당 (SCHD)', kind: 'etf' },
  ],
  // 코인은 바이낸스 USDT 마켓 대표 5종만 제공
  CRYPTO: CRYPTO_ASSETS.map((a) => ({ ticker: a.ticker, name: a.name, kind: 'coin' as const })),
};

/** 저장·조회에 쓰는 심볼(005930.KS, AAPL, BTCUSDT) → 한국어 표시 이름 */
const NAME_BY_SYMBOL: ReadonlyMap<string, string> = new Map([
  ...TICKER_PRESETS.KR.flatMap((p) => [[`${p.ticker}.KS`, p.name], [`${p.ticker}.KQ`, p.name]] as const),
  ...TICKER_PRESETS.US.map((p) => [p.ticker, p.name] as const),
  ...CRYPTO_ASSETS.map((a) => [a.symbol, a.name] as const),
]);

/** 프리셋에 있는 종목이면 한국어 이름, 아니면 대체 이름(시세 소스 이름) */
export function koreanName(symbol: string, fallback: string): string {
  return NAME_BY_SYMBOL.get(symbol) ?? fallback;
}
