import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MiniRedis } from '../src/store.js';
import { createServer } from '../src/server.js';
import { MiniRedisClient, MiniRedisHttpError } from '../src/client.js';
import { createDemoApi, FakeDb } from '../examples/demo-api.js';

let store;
let server;
let cache;
let url;

before(async () => {
  store = new MiniRedis({ sweepIntervalMs: 0 });
  server = createServer({ store, authToken: 'tok' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  cache = new MiniRedisClient(url, { token: 'tok', timeoutMs: 1000 });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  store.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 아무도 listen 하지 않는 포트를 얻는다 */
async function deadPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('클라이언트: set / get / del / exists / ttl / expire / persist / incr', async () => {
  assert.equal(await cache.get('c1'), undefined);
  assert.equal(await cache.set('c1', { a: 1 }, { ttl: 30 }), true);
  assert.deepEqual(await cache.get('c1'), { a: 1 });
  assert.equal(await cache.exists('c1'), true);
  assert.ok((await cache.ttl('c1')) > 29_000);
  assert.equal(await cache.persist('c1'), true);
  assert.equal(await cache.ttl('c1'), null);
  assert.equal(await cache.expire('c1', 5), true);
  assert.equal(await cache.del('c1'), true);
  assert.equal(await cache.del('c1'), false);
  assert.equal(await cache.exists('c1'), false);
  assert.equal(await cache.ttl('c1'), undefined);
  assert.equal(await cache.incr('c-counter'), 1);
  assert.equal(await cache.incr('c-counter', 4), 5);
  assert.equal(await cache.set('nx', 1, { nx: true }), true);
  assert.equal(await cache.set('nx', 2, { nx: true }), false);
});

test('클라이언트: 특수문자 키', async () => {
  const key = '한글/키 with spaces?&#%';
  await cache.set(key, 'ok');
  assert.equal(await cache.get(key), 'ok');
  assert.ok((await cache.keys({ prefix: '한글/' })).includes(key));
});

test('클라이언트: "." / ".." 키는 URL 정규화 때문에 전달 불가 → 로컬에서 명시적으로 거부', async () => {
  await assert.rejects(cache.set('..', 1), (e) => e instanceof MiniRedisHttpError && e.status === 400);
  await assert.rejects(cache.get('.'), MiniRedisHttpError);
  await cache.set('...', 'three dots ok'); // 점 3개 이상은 일반 키
  assert.equal(await cache.get('...'), 'three dots ok');
});

test('클라이언트: 서버 에러는 MiniRedisHttpError, 인증 실패 포함', async () => {
  await assert.rejects(cache.set('', 1), (e) => e instanceof MiniRedisHttpError && e.status === 400);
  await cache.set('word', 'abc');
  await assert.rejects(cache.incr('word'), (e) => e.status === 409 && e.code === 'WRONG_TYPE');
  const noAuth = new MiniRedisClient(url);
  await assert.rejects(noAuth.get('a'), (e) => e.status === 401);
});

test('getOrSet: 첫 호출은 loader 실행 + 저장, 두 번째는 캐시 hit', async () => {
  let calls = 0;
  const loader = async () => {
    calls++;
    return { n: calls };
  };
  const first = await cache.getOrSet('gs:1', loader, { ttl: 30 });
  assert.deepEqual(first, { value: { n: 1 }, hit: false });
  const second = await cache.getOrSet('gs:1', loader, { ttl: 30 });
  assert.deepEqual(second, { value: { n: 1 }, hit: true });
  assert.equal(calls, 1);
});

test('getOrSet: 동시 miss 20개 → loader 는 단 1번만 실행 (cache stampede 방지)', async () => {
  let calls = 0;
  const loader = async () => {
    calls++;
    await sleep(50);
    return 'expensive';
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => cache.getOrSet('stampede', loader, { ttl: 30 })));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.value === 'expensive'));
});

test('getOrSet: loader 에러는 전파되고 캐시되지 않으며, 다음 호출에서 재시도', async () => {
  let calls = 0;
  const loader = async () => {
    calls++;
    if (calls === 1) throw new Error('db down');
    return 'recovered';
  };
  await assert.rejects(cache.getOrSet('flaky', loader, { ttl: 30 }), /db down/);
  assert.equal(await cache.get('flaky'), undefined);
  const r = await cache.getOrSet('flaky', loader, { ttl: 30 });
  assert.equal(r.value, 'recovered');
  assert.equal(calls, 2);
});

test('getOrSet: null 도 캐시(negative caching), undefined 는 캐시하지 않음', async () => {
  let nullCalls = 0;
  const nullLoader = async () => {
    nullCalls++;
    return null;
  };
  await cache.getOrSet('neg', nullLoader, { ttl: 30 });
  const again = await cache.getOrSet('neg', nullLoader, { ttl: 30 });
  assert.deepEqual(again, { value: null, hit: true });
  assert.equal(nullCalls, 1);

  let undefCalls = 0;
  const undefLoader = async () => {
    undefCalls++;
    return undefined;
  };
  await cache.getOrSet('undef', undefLoader, { ttl: 30 });
  await cache.getOrSet('undef', undefLoader, { ttl: 30 });
  assert.equal(undefCalls, 2);
});

test('getOrSet: ttl 을 값에 따라 함수로 지정 가능', async () => {
  await cache.getOrSet('dyn:null', async () => null, { ttl: (v) => (v === null ? 5 : 500) });
  await cache.getOrSet('dyn:val', async () => 'x', { ttl: (v) => (v === null ? 5 : 500) });
  assert.ok((await cache.ttl('dyn:null')) <= 5000);
  assert.ok((await cache.ttl('dyn:val')) > 100_000);
});

test('getOrSet: 캐시 서버가 죽어 있어도 loader 결과를 반환 (fail-open)', async () => {
  const dead = new MiniRedisClient(`http://127.0.0.1:${await deadPort()}`, { timeoutMs: 300 });
  const r = await dead.getOrSet('k', async () => 'from-db', { ttl: 10 });
  assert.deepEqual(r, { value: 'from-db', hit: false });
  assert.equal(await dead.health(), false);
  await assert.rejects(dead.get('k')); // 일반 명령은 에러를 그대로 노출
});

test('getOrSet: 캐시 서버가 응답하지 않아도(hang) 타임아웃 후 loader 로 진행', async () => {
  const hang = net.createServer(() => {}); // 연결만 받고 아무 응답도 안 함
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const c = new MiniRedisClient(`http://127.0.0.1:${hang.address().port}`, { timeoutMs: 150 });
  try {
    const t0 = Date.now();
    const r = await c.getOrSet('k', async () => 'from-db');
    assert.equal(r.value, 'from-db');
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    hang.close();
    hang.unref();
  }
});

test('클라이언트: 무효화(tag / prefix / key / all)', async () => {
  await cache.set('t:1', 1, { tags: ['tg'] });
  await cache.set('t:2', 2, { tags: ['tg'] });
  await cache.set('p:1', 3);
  assert.equal(await cache.invalidate({ tag: 'tg' }), 2);
  assert.equal(await cache.invalidate({ prefix: 'p:' }), 1);
  assert.equal(await cache.invalidate({ key: 'nope' }), 0);
  await cache.set('z', 1);
  assert.ok((await cache.invalidate({ all: true })) >= 1);
  assert.equal(await cache.get('z'), undefined);
});

// ───────────── 데모 API (캐시 연동) ─────────────

async function withDemo(fn, { cacheClient = cache, latencyMs = 20 } = {}) {
  const db = new FakeDb({ latencyMs, poolSize: 5 });
  const { server: api } = createDemoApi({ cache: cacheClient, db });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  try {
    await fn(apiUrl, db);
  } finally {
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
  }
}

test('데모 API: 첫 요청 MISS(DB 조회) → 이후 HIT(DB 조회 없음), 응답 내용 동일', async () => {
  await cache.invalidate({ all: true });
  await withDemo(async (api, db) => {
    const a = await fetch(`${api}/products/7`);
    assert.equal(a.headers.get('x-cache'), 'MISS');
    const first = await a.json();
    const b = await fetch(`${api}/products/7`);
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.deepEqual(await b.json(), first);
    assert.equal(db.queries, 1);
  });
});

test('데모 API: 상품 수정 시 캐시 무효화 → 최신 가격 반영 (stale 데이터 없음)', async () => {
  await cache.invalidate({ all: true });
  await withDemo(async (api) => {
    await fetch(`${api}/products/3`); // 캐시에 적재
    const put = await fetch(`${api}/products/3`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: 777 }),
    });
    assert.equal(put.status, 200);
    const after = await fetch(`${api}/products/3`);
    assert.equal(after.headers.get('x-cache'), 'MISS');
    assert.equal((await after.json()).price, 777);
    assert.equal((await fetch(`${api}/products/3`)).headers.get('x-cache'), 'HIT');
  });
});

test('데모 API: 카테고리 태그로 일괄 무효화', async () => {
  await cache.invalidate({ all: true });
  await withDemo(async (api) => {
    for (const id of [5, 10, 15, 1]) await fetch(`${api}/products/${id}`); // 5,10,15 → c0 / 1 → c1
    const r = await fetch(`${api}/cache/category/c0`, { method: 'DELETE' });
    assert.deepEqual(await r.json(), { invalidated: 3 });
    assert.equal((await fetch(`${api}/products/5`)).headers.get('x-cache'), 'MISS');
    assert.equal((await fetch(`${api}/products/1`)).headers.get('x-cache'), 'HIT');
  });
});

test('데모 API: 존재하지 않는 상품(404)도 캐싱되어 DB 를 반복 조회하지 않는다 (cache penetration 방지)', async () => {
  await cache.invalidate({ all: true });
  await withDemo(async (api, db) => {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${api}/products/99999`)).status, 404);
    assert.equal(db.queries, 1);
    assert.equal((await fetch(`${api}/products/abc`)).status, 404);
  });
});

test('데모 API: 동시 요청 50개가 같은 상품을 요청해도 DB 조회는 1번 (single-flight)', async () => {
  await cache.invalidate({ all: true });
  await withDemo(async (api, db) => {
    const rs = await Promise.all(Array.from({ length: 50 }, () => fetch(`${api}/products/42`)));
    assert.ok(rs.every((r) => r.status === 200));
    await Promise.all(rs.map((r) => r.text()));
    assert.equal(db.queries, 1);
  });
});

test('데모 API: 캐시 서버가 죽어도 API 는 계속 응답 (fail-open)', async () => {
  const dead = new MiniRedisClient(`http://127.0.0.1:${await deadPort()}`, { timeoutMs: 200 });
  await withDemo(async (api) => {
    const r = await fetch(`${api}/products/1`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, 1);
  }, { cacheClient: dead });
});

test('데모 API: 캐시 만료(TTL) 후에는 다시 DB 에서 조회', async () => {
  await cache.invalidate({ all: true });
  const db = new FakeDb({ latencyMs: 5 });
  const { server: api } = createDemoApi({ cache, db, ttlSeconds: 0.1 });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  try {
    assert.equal((await fetch(`${apiUrl}/products/1`)).headers.get('x-cache'), 'MISS');
    assert.equal((await fetch(`${apiUrl}/products/1`)).headers.get('x-cache'), 'HIT');
    await sleep(150);
    assert.equal((await fetch(`${apiUrl}/products/1`)).headers.get('x-cache'), 'MISS');
    assert.equal(db.queries, 2);
  } finally {
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
  }
});
