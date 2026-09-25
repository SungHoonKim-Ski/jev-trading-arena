export type Market = 'KR' | 'US';
export type Effort = 'low' | 'medium' | 'high';
/** Jev 응답을 매매 신호로 해석하는 방식 */
export type Strategy = 'choice' | 'probability' | 'noul' | 'score';
export type EngineMode = 'live' | 'mock';
/** 체결 가격 모델: 다음 거래일 시가 / 다음 거래일 분봉 VWAP */
export type ExecutionModel = 'open' | 'vwap';
export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Bar {
  readonly date: string; // YYYY-MM-DD
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface RunParams {
  readonly nickname: string;
  readonly market: Market;
  readonly tickers: readonly string[];
  readonly startDate: string;
  readonly endDate: string;
  readonly intervalDays: number;
  readonly effort: Effort;
  readonly strategy: Strategy;
  readonly initialCapital: number;
  readonly engine: EngineMode;
  readonly execution: ExecutionModel;
}

/** 한 종목에 대한 결정. targetWeight=null 이면 현재 비중 유지 */
export interface AssetDecision {
  readonly symbol: string;
  readonly action: 'buy' | 'sell' | 'hold';
  readonly targetWeight: number | null;
  readonly confidence: number;
  readonly signal: number; // 0(약세)~1(강세) 정규화 신호
}

export interface Trade {
  readonly date: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly shares: number;
  readonly price: number;
  readonly fee: number;
}

export interface EquityPoint {
  readonly date: string;
  readonly equity: number;
  readonly benchmark: number;
}

export interface Metrics {
  readonly totalReturn: number;
  readonly cagr: number;
  readonly mdd: number;
  readonly sharpe: number;
  readonly volatility: number;
  readonly trades: number;
  readonly fees: number;
  readonly finalEquity: number;
}
