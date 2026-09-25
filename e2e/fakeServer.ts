/** E2E 전용 서버: 외부 네트워크 없이 결정적인 가짜 시세 + Mock Jev 사용 */
import { createServer } from 'node:http';
import { openLocalDatabase } from '../src/db/client.node.ts';
import { createApp } from '../src/app.ts';
import type { BarFetcher } from '../src/market/priceService.ts';
import type { IntradayFetcher } from '../src/market/intradayCollector.ts';
import { tradingDates } from '../test/helpers.ts';

const fetcher: BarFetcher = async (_market, input, from, to) => {
  const seed = [...input].reduce((s, c) => s + c.charCodeAt(0), 0);
  const bars = tradingDates(from, 3000).filter((d) => d <= to).map((date, i) => {
    const c = 100 + i * 0.08 + 12 * Math.sin(i / (9 + (seed % 7)));
    return { date, open: c * 0.997, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 };
  });
  return { symbol: /^\d{6}$/.test(input) ? `${input}.KS` : input, name: `Fake ${input}`, currency: 'USD', bars };
};
const intradayFetcher: IntradayFetcher = async () => [];

const app = createApp({ db: await openLocalDatabase(':memory:'), fetcher, liveJev: null, intradayFetcher });
createServer((req, res) => { void app.handle(req, res); }).listen(Number(process.env.PORT ?? 3199));
