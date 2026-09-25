import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpJevClient, JevApiError } from '../src/jev/httpClient.ts';
import { MockJevClient } from '../src/jev/mockClient.ts';
import { CachedJevClient } from '../src/jev/cachedClient.ts';
import { buildJevRequest } from '../src/jev/questions.ts';
import type { JevClient, JevResponse } from '../src/jev/types.ts';

const OK_BODY: JevResponse = { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 10, output_tokens: 2 } };
const REQ = { model: 'jev-latest', state: 's', questions: { q: { type: 'noul' as const, instructions: 'x?' } } };

function fakeFetch(statuses: number[], calls: RequestInit[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? JSON.stringify(OK_BODY) : '{"error":"x"}', { status });
  }) as typeof fetch;
}

test('HttpJevClient: Bearer 인증 헤더로 /v1/systemone 호출', async () => {
  const calls: RequestInit[] = [];
  const client = new HttpJevClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: fakeFetch([200], calls), sleep: async () => {} });
  const res = await client.evaluate(REQ);
  assert.equal(res.answers.q!.type, 'noul');
  assert.equal((calls[0]!.headers as Record<string, string>).Authorization, 'Bearer k');
});

test('HttpJevClient: 429/529는 재시도 후 성공', async () => {
  const calls: RequestInit[] = [];
  const client = new HttpJevClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: fakeFetch([429, 529, 200], calls), sleep: async () => {} });
  await client.evaluate(REQ);
  assert.equal(calls.length, 3);
});

test('HttpJevClient: 401은 재시도하지 않고 JevApiError', async () => {
  const calls: RequestInit[] = [];
  const client = new HttpJevClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl: fakeFetch([401], calls), sleep: async () => {} });
  await assert.rejects(client.evaluate(REQ), (e: unknown) => e instanceof JevApiError && e.status === 401);
  assert.equal(calls.length, 1);
});

test('HttpJevClient: API 키 없으면 생성 시 예외', () => {
  assert.throws(() => new HttpJevClient({ apiKey: '', baseUrl: 'https://api.test' }), /API key/);
});

test('MockJevClient: 모든 질문에 타입이 맞는 답변, 확률 합 1, 결정적', async () => {
  const req = buildJevRequest({
    assets: { asset_1: { trend_past_month: 'sharp rise', price_vs_20_day_average: 'well above its average' } },
    strategy: 'score', effort: 'high', intervalDays: 5, model: 'm',
  });
  const mock = new MockJevClient();
  const a = await mock.evaluate(req);
  const b = await mock.evaluate(req);
  assert.deepEqual(a, b);
  for (const [id, ans] of Object.entries(a.answers)) {
    assert.equal(ans.type, req.questions[id]!.type);
    if (ans.type !== 'noul') {
      const sum = Object.values(ans.probabilities).reduce((s, p) => s + p, 0);
      assert.ok(Math.abs(sum - 1) < 1e-6);
      if (ans.type === 'score') assert.ok(ans.score > 2, 'bullish state -> score above neutral');
    }
  }
  for (const s of ['choice', 'noul'] as const) {
    const r = await mock.evaluate(buildJevRequest({ assets: { asset_1: { trend_past_month: 'sharp decline' } }, strategy: s, effort: 'low', intervalDays: 1, model: 'm' }));
    const ans = Object.values(r.answers)[0]!;
    if (ans.type === 'noul') assert.ok(ans.noul < 0.5);
    if (ans.type === 'choice') assert.equal(ans.choice, 'sell');
  }
});

test('CachedJevClient: 같은 요청은 한 번만 호출', async () => {
  let n = 0;
  const inner: JevClient = { mode: 'live', evaluate: async () => { n++; return OK_BODY; } };
  const store = new Map<string, string>();
  const cached = new CachedJevClient(inner, { get: (k) => store.get(k) ?? null, set: (k, _m, v) => { store.set(k, v); } });
  const r1 = await cached.evaluate(REQ);
  const r2 = await cached.evaluate(REQ);
  assert.equal(n, 1);
  assert.deepEqual(r2.answers, r1.answers);
  assert.equal(r2.cached, true);
  assert.equal(r2.usage.input_tokens, 0);
  assert.equal(cached.mode, 'live');
});
