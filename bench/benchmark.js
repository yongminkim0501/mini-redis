/**
 * 성능 비교: Mini Redis 캐시를 "사용할 때" vs "사용하지 않을 때"
 *
 * 구성 (모두 한 프로세스 안에서 실제 HTTP 로 통신)
 *   load generator ──HTTP──▶ Demo API ──(캐시 사용 시)HTTP──▶ Mini Redis
 *                                  └────────────────────────▶ FakeDb (쿼리당 LATENCY_MS, 커넥션 풀 POOL_SIZE)
 *
 * 환경 변수: REQUESTS(기본 3000) CONCURRENCY(50) LATENCY_MS(50) POOL_SIZE(10) PRODUCTS(200) SKEW(2)
 * 실행: npm run bench
 */
import { performance } from 'node:perf_hooks';
import { MiniRedis, createServer, MiniRedisClient } from '../src/index.js';
import { createDemoApi, FakeDb } from '../examples/demo-api.js';

const env = (name, dflt) => Number(process.env[name] ?? dflt);
const REQUESTS = env('REQUESTS', 3000);
const CONCURRENCY = env('CONCURRENCY', 50);
const LATENCY_MS = env('LATENCY_MS', 50);
const POOL_SIZE = env('POOL_SIZE', 10);
const PRODUCTS = env('PRODUCTS', 200);
const SKEW = env('SKEW', 2); // 클수록 인기 상품에 요청이 쏠림 (실제 트래픽은 대체로 쏠려 있음)

// 재현 가능한 난수 (mulberry32)
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeIds() {
  const rand = rng(42);
  return Array.from({ length: REQUESTS }, () => 1 + Math.floor(PRODUCTS * Math.pow(rand(), SKEW)));
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function runLoad(baseUrl, ids) {
  const latencies = new Array(ids.length);
  const headers = { HIT: 0, MISS: 0, BYPASS: 0 };
  let next = 0;
  let errors = 0;
  const t0 = performance.now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= ids.length) return;
      const s = performance.now();
      try {
        const res = await fetch(`${baseUrl}/products/${ids[i]}`);
        await res.json();
        if (res.status !== 200) errors++;
        headers[res.headers.get('x-cache')]++;
      } catch {
        errors++;
      }
      latencies[i] = performance.now() - s;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const totalMs = performance.now() - t0;
  const sorted = latencies.filter((x) => x !== undefined).sort((a, b) => a - b);
  return {
    totalMs,
    rps: ids.length / (totalMs / 1000),
    avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    errors,
    headers,
  };
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

// ── 서버 기동
const store = new MiniRedis();
const redisServer = createServer({ store });
const redisUrl = await listen(redisServer);
const cacheClient = new MiniRedisClient(redisUrl);

const noCacheDb = new FakeDb({ latencyMs: LATENCY_MS, poolSize: POOL_SIZE });
const cacheDb = new FakeDb({ latencyMs: LATENCY_MS, poolSize: POOL_SIZE });
const noCacheApi = createDemoApi({ cache: null, db: noCacheDb });
const cachedApi = createDemoApi({ cache: cacheClient, db: cacheDb });
const noCacheUrl = await listen(noCacheApi.server);
const cachedUrl = await listen(cachedApi.server);

const ids = makeIds();
const distinct = new Set(ids).size;
console.log(`요청 ${REQUESTS}건, 동시 ${CONCURRENCY}, DB 지연 ${LATENCY_MS}ms, DB 커넥션 풀 ${POOL_SIZE}, 상품 ${PRODUCTS}종(실제 요청된 종류 ${distinct}), 쏠림 지수 ${SKEW}\n`);

// 워밍업 (JIT / 커넥션)
await runLoad(noCacheUrl, ids.slice(0, 50).map(() => 1));
noCacheDb.queries = 0;
await cacheClient.invalidate({ all: true });
await runLoad(cachedUrl, [1]);
await cacheClient.invalidate({ all: true });
cacheDb.queries = 0;

const without = await runLoad(noCacheUrl, ids);
const withCold = await runLoad(cachedUrl, ids); // 빈 캐시에서 시작 (cold start 포함)
const coldQueries = cacheDb.queries;
const withWarm = await runLoad(cachedUrl, ids); // 이미 채워진 캐시
const stats = await cacheClient.stats();

const fmt = (n, d = 1) => n.toFixed(d);
const rows = [
  ['', '캐시 없음', '캐시 사용 (cold)', '캐시 사용 (warm)'],
  ['총 소요 시간 (ms)', fmt(without.totalMs, 0), fmt(withCold.totalMs, 0), fmt(withWarm.totalMs, 0)],
  ['처리량 (req/s)', fmt(without.rps, 0), fmt(withCold.rps, 0), fmt(withWarm.rps, 0)],
  ['평균 지연 (ms)', fmt(without.avg), fmt(withCold.avg), fmt(withWarm.avg)],
  ['p50 (ms)', fmt(without.p50), fmt(withCold.p50), fmt(withWarm.p50)],
  ['p95 (ms)', fmt(without.p95), fmt(withCold.p95), fmt(withWarm.p95)],
  ['p99 (ms)', fmt(without.p99), fmt(withCold.p99), fmt(withWarm.p99)],
  ['DB 쿼리 수', String(noCacheDb.queries), String(coldQueries), String(cacheDb.queries - coldQueries)],
  ['캐시 HIT / MISS', '-', `${withCold.headers.HIT} / ${withCold.headers.MISS}`, `${withWarm.headers.HIT} / ${withWarm.headers.MISS}`],
  ['오류', String(without.errors), String(withCold.errors), String(withWarm.errors)],
];
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => [...r[c]].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))));
const pad = (s, w) => s + ' '.repeat(w - [...s].reduce((x, ch) => x + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0));
for (const [i, r] of rows.entries()) {
  console.log('| ' + r.map((c, j) => pad(c, widths[j])).join(' | ') + ' |');
  if (i === 0) console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
}
console.log(`\n속도 향상: cold ${fmt(without.totalMs / withCold.totalMs)}x, warm ${fmt(without.totalMs / withWarm.totalMs)}x`);
console.log(`Mini Redis hit ratio (서버 집계): ${fmt((stats.hitRatio ?? 0) * 100)}%  keys=${stats.keys}  table.capacity=${stats.table.capacity}  longestChain=${stats.table.longestChain}`);

for (const s of [noCacheApi.server, cachedApi.server, redisServer]) s.closeAllConnections();
store.close();
process.exit(0);
