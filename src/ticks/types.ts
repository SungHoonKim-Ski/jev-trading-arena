/** 원본 체결(틱) 저장소. 로컬 전용 (DuckDB 네이티브 모듈 사용) */
export interface TickDownload {
  /** 압축 해제된 바이낸스 trades CSV: id,price,qty,quoteQty,time,isBuyerMaker,isBestMatch */
  readonly csv: Uint8Array;
  readonly sha256: string;
}

export interface TickDownloader {
  download(symbol: string, date: string): Promise<TickDownload>;
}

export interface TickCoverage {
  readonly symbol: string;
  readonly days: number;
  readonly trades: number;
  readonly firstDate: string;
  readonly lastDate: string;
}

export interface TickStore {
  hasDay(symbol: string, date: string): Promise<boolean>;
  /** 해당 날짜 원본 체결을 받아 저장 (이미 있으면 건너뜀) */
  loadDay(symbol: string, date: string): Promise<{ readonly trades: number; readonly cached: boolean }>;
  /**
   * 시장가 주문을 참여율(participation)만큼 체결 흐름에 섞어 넣었을 때의 평균 체결가.
   * 그날 틱이 없으면 null.
   */
  fillPrice(symbol: string, date: string, quantity: number, participation: number): Promise<number | null>;
  coverage(): Promise<TickCoverage[]>;
  /** 기간 내 틱이 저장된 날짜 */
  storedDays(symbol: string, from: string, to: string): Promise<Set<string>>;
  sizeBytes(): number;
  readonly maxBytes: number;
  close(): void;
}

/** 체결가 계산만 하는 인터페이스 (로컬: 저장된 틱, 서버리스: 스트리밍) */
export interface TickPricer {
  readonly mode: 'local' | 'stream';
  /** 시장 체결량의 participation 비율만 내 주문이 가져간다고 볼 때 평균 체결가. 틱이 없으면 null */
  fillPrice(symbol: string, date: string, quantity: number, participation: number): Promise<number | null>;
}
