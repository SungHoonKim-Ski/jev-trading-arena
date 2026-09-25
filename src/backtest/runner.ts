import { CONFIG, MARKETS, WARMUP_CALENDAR_DAYS } from '../config.ts';
import type { RunRepository } from '../db/runRepository.ts';
import { buildAssetState, computeRawFeatures, type AssetState } from '../market/features.ts';
import type { PriceService, SymbolBars } from '../market/priceService.ts';
import { interpretAnswers } from '../jev/interpret.ts';
import { buildJevRequest } from '../jev/questions.ts';
import type { JevClient } from '../jev/types.ts';
import type { AssetDecision, Bar, RunParams, Trade } from '../types.ts';
import { logger } from '../logger.ts';
import { koreanName } from '../market/presets.ts';
import type { IntradayDay, IntradayRepository } from '../db/intradayRepository.ts';
import type { IntradayCollector } from '../market/intradayCollector.ts';
import type { TickStore } from '../ticks/types.ts';
import { countFills, makeFillPrice, type MinuteFetcher } from './fills.ts';
import { simulate, type DecideContext } from './engine.ts';
import { computeMetrics, totalReturnOf } from './metrics.ts';

export interface RunnerDeps {
  readonly prices: PriceService;
  readonly runs: RunRepository;
  readonly jevFor: (engine: RunParams['engine']) => JevClient;
  readonly model: string;
  readonly intraday: IntradayRepository;
  readonly collector: IntradayCollector;
  readonly ticks: TickStore | null;
  readonly cryptoMinutes: MinuteFetcher;
  readonly participation: number;
}

const MIN_WARMUP_BARS = 20;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function loadSymbols(params: RunParams, prices: PriceService): Promise<SymbolBars[]> {
  const from = shiftDate(params.startDate, -WARMUP_CALENDAR_DAYS);
  const loaded = await Promise.all(params.tickers.map((t) => prices.getBars(params.market, t, from, params.endDate)));
  const seen = new Set<string>();
  return loaded.filter((s) => (seen.has(s.symbol) ? false : (seen.add(s.symbol), true)));
}

async function loadIndex(params: RunParams, prices: PriceService): Promise<readonly Bar[]> {
  try {
    return (await prices.getBars(params.market, MARKETS[params.market].indexSymbol, params.startDate, params.endDate)).bars;
  } catch (err) {
    logger.warn('runner', 'index load failed', err);
    return [];
  }
}

interface JevUsage { calls: number; tokens: number; model: string }

/** 결정일마다 익명화된 state로 Jev를 호출하고 답변을 목표 비중으로 변환하는 decide 함수 */
function makeDecider(params: RunParams, symbols: readonly SymbolBars[], jev: JevClient, deps: RunnerDeps, runId: number) {
  const market = MARKETS[params.market];
  const keyOf = new Map(symbols.map((s, i) => [s.symbol, `asset_${i + 1}`]));
  const decisions: (AssetDecision & { date: string })[] = [];
  const usage: JevUsage = { calls: 0, tokens: 0, model: deps.model };

  const decide = async (ctx: DecideContext) => {
    const eligible = symbols.filter((s) => (ctx.barIndex[s.symbol] ?? -1) >= MIN_WARMUP_BARS - 1);
    if (eligible.length === 0) return {};
    const assets: Record<string, AssetState> = Object.fromEntries(eligible.map((s) => [
      keyOf.get(s.symbol)!, buildAssetState(computeRawFeatures(s.bars, ctx.barIndex[s.symbol]!, market.periodsPerYear), params.effort),
    ]));
    const request = buildJevRequest({
      assets, strategy: params.strategy, effort: params.effort, intervalDays: params.intervalDays, model: deps.model,
      assetNoun: market.assetNoun, dayUnit: market.dayUnit,
    });
    const res = await jev.evaluate(request);
    if (!res.cached) usage.calls += 1;
    usage.tokens += res.usage.input_tokens;
    usage.model = res.model;
    const interpreted = interpretAnswers({
      answers: res.answers, assetKeys: Object.keys(assets), strategy: params.strategy, effort: params.effort,
      currentWeights: Object.fromEntries(eligible.map((s) => [keyOf.get(s.symbol)!, ctx.currentWeights[s.symbol] ?? 0])),
      threshold: params.threshold, exitRule: params.exitRule,
    });
    const targets: Record<string, number | null> = {};
    for (const s of eligible) {
      const d = interpreted[keyOf.get(s.symbol)!]!;
      decisions.push({ date: ctx.date, symbol: s.symbol, ...d });
      targets[s.symbol] = d.targetWeight;
    }
    if (ctx.step % 5 === 0) await deps.runs.setProgress(runId, 0.1 + 0.85 * ((ctx.step + 1) / Math.max(1, ctx.totalSteps)));
    return targets;
  };
  return { decide, decisions, usage };
}

function indexSeries(indexBars: readonly Bar[], dates: readonly string[], capital: number): (number | null)[] {
  const byDate = new Map(indexBars.map((b) => [b.date, b.close]));
  const first = dates.map((d) => byDate.get(d)).find((v) => v !== undefined);
  let last: number | null = null;
  return dates.map((d) => {
    const c = byDate.get(d);
    if (c !== undefined) last = c;
    return first && last !== null ? (capital * last) / first : null;
  });
}

type IntradayBySymbol = ReadonlyMap<string, ReadonlyMap<string, IntradayDay>>;

/** 주식: 수집해 둔 분봉을 기간 단위로 한 번에 읽는다 (코인은 체결일마다 필요한 만큼 받아 온다) */
async function loadStockIntradayDays(symbols: readonly SymbolBars[], params: RunParams, intraday: IntradayRepository): Promise<IntradayBySymbol> {
  if (params.market === 'CRYPTO' || params.execution === 'open') return new Map();
  const entries = await Promise.all(symbols.map(async (s) => [s.symbol, await intraday.getFinestDays(s.symbol, params.startDate, params.endDate)] as const));
  return new Map(entries);
}

async function ensureIntraday(symbols: readonly SymbolBars[], collector: IntradayCollector): Promise<void> {
  try {
    const results = await collector.collectMany(symbols.map((s) => s.symbol));
    for (const r of results) if (r.errors.length) logger.warn('runner', `intraday ${r.symbol}: ${r.errors.join('; ')}`);
  } catch (err) {
    logger.warn('runner', 'intraday collection failed; falling back to daily prices', err);
  }
}

/** 한 번의 백테스트 실행 전체: 시세 → 지표 → Jev 결정 → 시뮬레이션 → 지표 저장 */
export async function executeRun(runId: number, deps: RunnerDeps): Promise<void> {
  const params = await deps.runs.getParams(runId);
  if (!params) throw new Error(`run ${runId} not found`);
  // 다른 인스턴스가 이미 가져간 실행이면 건너뛴다
  if (!(await deps.runs.claim(runId))) return;
  // 재시작 후 틱 저장소가 꺼진 상태라면 조용히 분봉으로 바꾸지 않고 실패로 기록
  if (params.execution === 'tick' && !deps.ticks) throw new Error('원본 틱 저장소가 꺼져 있어 틱 체결 실행을 진행할 수 없습니다 (TICKS 설정 확인)');
  await deps.runs.setProgress(runId, 0.02);

  const symbols = await loadSymbols(params, deps.prices);
  await deps.runs.setSymbolNames(runId, Object.fromEntries(symbols.map((s) => [s.symbol, koreanName(s.symbol, s.name)])));
  const indexBars = await loadIndex(params, deps.prices);
  // 주식 분봉은 Yahoo에서 최근분을 먼저 수집 (코인은 체결일마다 바이낸스에서 받는다)
  if (params.execution !== 'open' && params.market !== 'CRYPTO') await ensureIntraday(symbols, deps.collector);
  const stockDays = await loadStockIntradayDays(symbols, params, deps.intraday);
  const { fillPrice, sources } = makeFillPrice(params, symbols, stockDays, deps);
  await deps.runs.setProgress(runId, 0.1);

  const market = MARKETS[params.market];
  const { decide, decisions, usage } = makeDecider(params, symbols, deps.jevFor(params.engine), deps, runId);
  const sim = await simulate({
    symbols: symbols.map((s) => s.symbol), bars: Object.fromEntries(symbols.map((s) => [s.symbol, s.bars])),
    startDate: params.startDate, endDate: params.endDate, intervalDays: params.intervalDays,
    initialCapital: params.initialCapital, buyFeeRate: market.buyFeeRate, sellFeeRate: market.sellFeeRate, decide,
    lotSize: market.lotSize,
    fillPrice,
  });

  const fills = params.execution === 'open' ? null : countFills(sim.trades, sources);
  const idx = indexSeries(indexBars, sim.equity.map((p) => p.date), params.initialCapital);
  const metrics = computeMetrics(sim.equity, sim.trades, params.initialCapital, market.periodsPerYear);
  const lastIdx = idx.findLast((v) => v !== null) ?? null;
  await deps.runs.complete(runId, {
    equity: sim.equity.map((p, i) => ({ ...p, index: idx[i] })),
    trades: sim.trades,
    decisions,
    metrics,
    summary: {
      totalReturn: metrics.totalReturn,
      benchmarkReturn: totalReturnOf(sim.equity.map((p) => p.benchmark), params.initialCapital),
      indexReturn: lastIdx === null ? null : lastIdx / params.initialCapital - 1,
      jevCalls: usage.calls,
      jevInputTokens: usage.tokens,
      jevCostUsd: params.engine === 'live' ? usage.tokens * CONFIG.jev.usdPerInputToken : 0,
      model: usage.model,
      tickFills: fills?.tick ?? null,
      intradayFills: fills?.minute ?? null,
      fallbackFills: fills?.daily ?? null,
    },
  });
}
