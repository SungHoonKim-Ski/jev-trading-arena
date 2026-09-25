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
  sizeBytes(): number;
  readonly maxBytes: number;
  close(): void;
}
