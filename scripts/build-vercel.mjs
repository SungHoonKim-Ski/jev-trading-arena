// Vercel Build Output API v3 산출물 생성: 정적 화면(public) + API 함수 1개 + 일일 크론
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const OUT = '.vercel/output';
const FUNC = `${OUT}/functions/api.func`;

await rm(OUT, { recursive: true, force: true });
await mkdir(FUNC, { recursive: true });

await build({
  entryPoints: ['src/vercel/handler.ts'],
  outfile: `${FUNC}/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  // 일부 의존성이 CommonJS require를 쓰므로 ESM 번들에 require를 제공
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

await writeFile(`${FUNC}/.vc-config.json`, JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  maxDuration: 300,
  // 바이낸스 API는 미국 IP를 차단하므로 서울 리전에서 실행
  regions: ['icn1'],
}, null, 2));

await cp('public', `${OUT}/static`, { recursive: true });
// Vercel에서는 화면과 API가 같은 출처이므로 API 주소를 비워 둔다
await writeFile(`${OUT}/static/config.js`, "window.JEV_API_BASE = '';\n");

await writeFile(`${OUT}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: '/api?__path=$1' },
    { handle: 'filesystem' },
  ],
  // 한국·미국 장 마감 후(22:00 UTC) 하루 1회: 분봉 수집 + 멈춘 실행 복구
  crons: [{ path: '/api/cron/tick', schedule: '0 22 * * *' }],
}, null, 2));

console.log('Vercel build output ready:', OUT);
