/**
 * 배치(MGET / MSET) 성능: 키 N개를 "하나씩" vs "한 번에" 다룰 때의 차이
 *   npm run bench:batch      (환경변수 N 으로 개수 조절, 기본 1000 — maxBatch 상한이 1000 이다)
 *
 * 같은 프로세스 안에서 실제 HTTP(keep-alive 재사용)로 서버 API 를 직접 호출한다.
 * 서버가 다른 머신에 있으면 요청마다 네트워크 왕복 지연이 붙어서 "하나씩" 방식이 훨씬 더 불리해진다.
 *
 * 참고: 이 스크립트는 node:http 로 직접 호출한다. Node 내장 fetch 는 Windows 에서 요청당 수 ms 의
 *       고정 오버헤드가 있어(측정: 순차 요청 14.5ms vs http 0.14ms) 배치 자체의 효과를 가려 버리기 때문이다.
 */
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { MiniRedis, createServer } from '../src/index.js';

const N = Number(process.env.N ?? 1000);
const CONCURRENCY = 50;

const store = new MiniRedis({ maxBatch: Math.max(N, 1000) });
const server = createServer({ store });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = http.request({ host: '127.0.0.1', port, path, method, agent, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`${method} ${path} → ${res.statusCode}`));
        else resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const keys = Array.from({ length: N }, (_, i) => `bench:${i}`);
const valueOf = (i) => ({ id: i, name: `item ${i}` });
const enc = encodeURIComponent;

async function time(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

async function inChunks(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

// 워밍업
await call('PUT', '/keys/warm', { value: 1 });
await call('GET', '/keys/warm');
await call('POST', '/mget', { keys: ['warm'] });
await call('POST', '/invalidate', { all: true });

const rows = [];
const add = (label, ms, base) =>
  rows.push([label, ms.toFixed(1), base === undefined ? '-' : `${(base / ms).toFixed(1)}x`]);

const setOne = (k) => call('PUT', `/keys/${enc(k)}`, { value: valueOf(Number(k.split(':')[1])) });
const getOne = (k) => call('GET', `/keys/${enc(k)}`);

const writeSeq = await time(async () => {
  for (const k of keys) await setOne(k);
});
add(`쓰기 ${N}개: PUT 을 하나씩 (순차)`, writeSeq);
await call('POST', '/invalidate', { all: true });
const writePar = await time(() => inChunks(keys, CONCURRENCY, setOne));
add(`쓰기 ${N}개: PUT 동시 ${CONCURRENCY}개`, writePar, writeSeq);
await call('POST', '/invalidate', { all: true });
const writeBatch = await time(() =>
  call('POST', '/mset', { entries: keys.map((key, i) => ({ key, value: valueOf(i) })) }),
);
add(`쓰기 ${N}개: POST /mset 한 번`, writeBatch, writeSeq);

const readSeq = await time(async () => {
  for (const k of keys) await getOne(k);
});
add(`읽기 ${N}개: GET 을 하나씩 (순차)`, readSeq);
const readPar = await time(() => inChunks(keys, CONCURRENCY, getOne));
add(`읽기 ${N}개: GET 동시 ${CONCURRENCY}개`, readPar, readSeq);
const readBatch = await time(() => call('POST', '/mget', { keys }));
add(`읽기 ${N}개: POST /mget 한 번`, readBatch, readSeq);

const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const w0 = Math.max(...rows.map((r) => width(r[0])), width('방식'));
const pad = (s, w) => s + ' '.repeat(w - width(s));
console.log(`키 ${N}개, 실제 HTTP 통신 (keep-alive)\n`);
console.log(`| ${pad('방식', w0)} | 시간(ms) | 순차 대비 |`);
console.log(`|${'-'.repeat(w0 + 2)}|----------|-----------|`);
for (const r of rows) console.log(`| ${pad(r[0], w0)} | ${r[1].padStart(8)} | ${r[2].padStart(9)} |`);

agent.destroy();
server.closeAllConnections();
server.close();
store.close();
process.exit(0);
