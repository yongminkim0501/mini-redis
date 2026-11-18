import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MiniRedis } from '../src/store.js';
import { createServer } from '../src/server.js';

let store;
let server;
let base;

before(async () => {
  store = new MiniRedis({ sweepIntervalMs: 20 });
  server = createServer({ store, maxBodyBytes: 4096 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  agent.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  store.close();
});

const enc = encodeURIComponent;

// 연결 재사용(keep-alive) + 소켓 수 제한: 동시 요청이 많아도 새 TCP 연결 폭주로 테스트가 흔들리지 않게 한다.
// (fetch 와 달리 경로를 정규화하지 않으므로 '/keys/..' 같은 날것의 경로도 그대로 보낼 수 있다)
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (payload !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path, method, agent, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined, res });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('PUT → GET → DELETE → GET(404)', async () => {
  let r = await call('PUT', '/keys/hello', { value: 'world' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { key: 'hello', stored: true });

  r = await call('GET', '/keys/hello');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { key: 'hello', value: 'world', ttlMs: null });

  r = await call('DELETE', '/keys/hello');
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, true);

  r = await call('GET', '/keys/hello');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');

  r = await call('DELETE', '/keys/hello');
  assert.equal(r.status, 404);
});

test('JSON 값 타입 보존 (객체/배열/null/false/0/빈 문자열)', async () => {
  const values = [{ a: [1, { b: null }] }, [1, 2], null, false, 0, ''];
  for (const [i, value] of values.entries()) {
    assert.equal((await call('PUT', `/keys/t${i}`, { value })).status, 200);
    const r = await call('GET', `/keys/t${i}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, value);
  }
});

test('특수문자 / 유니코드 / 슬래시가 들어간 키 (URL 인코딩)', async () => {
  const keys = ['a/b/c', 'user:1', '한글 키', 'a b&c=d?e#f', '100%', '..', 'keys', 'ttl', '😀'];
  for (const key of keys) {
    assert.equal((await call('PUT', `/keys/${enc(key)}`, { value: key })).status, 200, key);
  }
  for (const key of keys) {
    const r = await call('GET', `/keys/${enc(key)}`);
    assert.equal(r.status, 200, key);
    assert.equal(r.body.key, key);
    assert.equal(r.body.value, key);
  }
});

test('TTL: 만료 후 요청하면 404 (만료된 값을 돌려주지 않는다)', async () => {
  await call('PUT', '/keys/short', { value: 'v', ttlMs: 60 });
  let r = await call('GET', '/keys/short');
  assert.equal(r.status, 200);
  assert.ok(r.body.ttlMs > 0 && r.body.ttlMs <= 60);
  await sleep(90);
  r = await call('GET', '/keys/short');
  assert.equal(r.status, 404);
  assert.equal((await call('GET', '/keys/short/ttl')).status, 404);
});

test('TTL 초 단위(ttl) 와 ms 단위(ttlMs), 잘못된 TTL', async () => {
  await call('PUT', '/keys/sec', { value: 1, ttl: 10 });
  assert.ok((await call('GET', '/keys/sec')).body.ttlMs > 9000);
  assert.equal((await call('PUT', '/keys/x', { value: 1, ttl: 1, ttlMs: 1 })).status, 400);
  assert.equal((await call('PUT', '/keys/x', { value: 1, ttl: 0 })).status, 400);
  assert.equal((await call('PUT', '/keys/x', { value: 1, ttl: -3 })).status, 400);
  assert.equal((await call('PUT', '/keys/x', { value: 1, ttl: '10' })).status, 400);
  assert.equal((await call('GET', '/keys/x')).status, 404); // 실패한 PUT 은 저장하지 않음
});

test('expire / persist / ttl 엔드포인트', async () => {
  await call('PUT', '/keys/e', { value: 1 });
  let r = await call('GET', '/keys/e/ttl');
  assert.deepEqual(r.body, { key: 'e', ttlMs: null });

  r = await call('POST', '/keys/e/expire', { ttl: 100 });
  assert.equal(r.status, 200);
  r = await call('GET', '/keys/e/ttl');
  assert.ok(r.body.ttlMs > 90_000);

  r = await call('POST', '/keys/e/persist');
  assert.deepEqual(r.body, { key: 'e', persisted: true });
  r = await call('POST', '/keys/e/persist');
  assert.deepEqual(r.body, { key: 'e', persisted: false }); // 이미 TTL 없음 (키는 존재)

  assert.equal((await call('POST', '/keys/nope/expire', { ttl: 1 })).status, 404);
  assert.equal((await call('POST', '/keys/nope/persist')).status, 404);
  assert.equal((await call('POST', '/keys/e/expire', {})).status, 400);
});

test('NX / XX: 조건 불충족이면 409', async () => {
  assert.equal((await call('PUT', '/keys/nx', { value: 1, xx: true })).status, 409);
  assert.equal((await call('PUT', '/keys/nx', { value: 1, nx: true })).status, 200);
  const r = await call('PUT', '/keys/nx', { value: 2, nx: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'CONDITION_NOT_MET');
  assert.equal((await call('GET', '/keys/nx')).body.value, 1);
});

test('입력 검증: 잘못된 JSON / value 누락 / 본문이 객체가 아님 / 잘못된 퍼센트 인코딩', async () => {
  assert.equal((await call('PUT', '/keys/bad', '{not json')).status, 400);
  assert.equal((await call('PUT', '/keys/bad', {})).status, 400);
  assert.equal((await call('PUT', '/keys/bad')).status, 400); // 본문 없음
  assert.equal((await call('PUT', '/keys/bad', [1, 2])).status, 400);
  assert.equal((await call('PUT', '/keys/bad', 'null')).status, 400);
  assert.equal((await call('PUT', '/keys/%E0%A4%A', { value: 1 })).status, 400);
  assert.equal((await call('PUT', '/keys/', { value: 1 })).status, 400); // 빈 키
  assert.equal((await call('GET', '/keys/')).status, 200); // 끝의 슬래시는 목록으로 허용
  assert.equal((await call('POST', '/keys', { value: 1 })).status, 405);
  assert.equal((await call('PUT', `/keys/${'k'.repeat(513)}`, { value: 1 })).status, 400);
  assert.equal((await call('PUT', '/keys/bad', { value: 1, tags: 'x' })).status, 400);
  assert.equal((await call('GET', '/keys/bad')).status, 404);
});

test('요청 본문 크기 제한 → 413', async () => {
  const r = await call('PUT', '/keys/big', { value: 'x'.repeat(10_000) });
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await call('GET', '/keys/big')).status, 404);
  // 서버는 계속 정상 동작
  assert.equal((await call('GET', '/health')).status, 200);
});

test('없는 경로 / 허용되지 않는 메서드', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/')).status, 404);
  assert.equal((await call('GET', '/keys/a/b/c')).status, 404);
  assert.equal((await call('GET', '/keys/a/unknown')).status, 404);
  assert.equal((await call('POST', '/keys/a')).status, 405);
  assert.equal((await call('POST', '/stats')).status, 405);
  assert.equal((await call('GET', '/invalidate')).status, 405);
});

test('incr: 기본/증분/비정수/음수', async () => {
  let r = await call('POST', '/keys/cnt/incr');
  assert.equal(r.body.value, 1);
  r = await call('POST', '/keys/cnt/incr', { by: 10 });
  assert.equal(r.body.value, 11);
  r = await call('POST', '/keys/cnt/incr', { by: -20 });
  assert.equal(r.body.value, -9);
  assert.equal((await call('POST', '/keys/cnt/incr', { by: 1.5 })).status, 400);
  await call('PUT', '/keys/txt', { value: 'abc' });
  r = await call('POST', '/keys/txt/incr');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'WRONG_TYPE');
});

test('동시성: 500개 동시 INCR → 정확히 500 (유실 업데이트 없음)', async () => {
  const results = await Promise.all(
    Array.from({ length: 500 }, () => call('POST', '/keys/race-counter/incr')),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await call('GET', '/keys/race-counter')).body.value, 500);
  // 반환값도 모두 유일 (1..500) → 각 INCR 이 원자적으로 실행됨
  const returned = new Set(results.map((r) => r.body.value));
  assert.equal(returned.size, 500);
  assert.equal(Math.min(...returned), 1);
  assert.equal(Math.max(...returned), 500);
});

test('동시성: 동시 SET NX 는 정확히 한 명만 성공 (분산 락 패턴)', async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => call('PUT', '/keys/lock', { value: `owner-${i}`, nx: true, ttl: 5 })),
  );
  const winners = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 99);
  const idx = results.indexOf(winners[0]);
  assert.equal((await call('GET', '/keys/lock')).body.value, `owner-${idx}`);
});

test('동시성: 같은 키에 대한 동시 PUT/GET/DELETE 가 섞여도 서버가 깨지지 않고 일관된 값만 관찰', async () => {
  const ops = [];
  for (let i = 0; i < 300; i++) {
    ops.push(call('PUT', '/keys/mixed', { value: { n: i, pair: [i, i] } }));
    ops.push(call('GET', '/keys/mixed'));
    if (i % 10 === 0) ops.push(call('DELETE', '/keys/mixed'));
  }
  const results = await Promise.all(ops);
  for (const r of results) {
    assert.ok([200, 404].includes(r.status), `status=${r.status}`);
    if (r.status === 200 && r.body.value) {
      assert.equal(r.body.value.pair[0], r.body.value.n); // 찢어진(torn) 값 없음
      assert.equal(r.body.value.pair[1], r.body.value.n);
    }
  }
});

test('동시성: 많은 키에 대한 병렬 쓰기/읽기', async () => {
  await Promise.all(Array.from({ length: 1000 }, (_, i) => call('PUT', `/keys/bulk:${i}`, { value: i })));
  const reads = await Promise.all(Array.from({ length: 1000 }, (_, i) => call('GET', `/keys/bulk:${i}`)));
  reads.forEach((r, i) => assert.equal(r.body.value, i));
  const list = await call('GET', `/keys?prefix=${enc('bulk:')}&limit=5000`);
  assert.equal(list.body.count, 1000);
});

test('무효화: key / tag / prefix / all', async () => {
  await call('PUT', '/keys/inv:a', { value: 1, tags: ['grp'] });
  await call('PUT', '/keys/inv:b', { value: 2, tags: ['grp'] });
  await call('PUT', '/keys/inv:c', { value: 3 });
  await call('PUT', '/keys/other', { value: 4 });

  let r = await call('POST', '/invalidate', { tag: 'grp' });
  assert.deepEqual(r.body, { invalidated: 2 });
  assert.equal((await call('GET', '/keys/inv:a')).status, 404);
  assert.equal((await call('GET', '/keys/inv:c')).status, 200);

  r = await call('POST', '/invalidate', { prefix: 'inv:' });
  assert.deepEqual(r.body, { invalidated: 1 });

  r = await call('POST', '/invalidate', { key: 'other' });
  assert.deepEqual(r.body, { invalidated: 1 });
  r = await call('POST', '/invalidate', { key: 'other' });
  assert.deepEqual(r.body, { invalidated: 0 });

  assert.equal((await call('POST', '/invalidate', {})).status, 400);
  assert.equal((await call('POST', '/invalidate', { key: 'a', tag: 'b' })).status, 400);
  assert.equal((await call('POST', '/invalidate')).status, 400);
});

test('무효화 → 즉시 반영: 직후 GET 은 반드시 404', async () => {
  for (let i = 0; i < 50; i++) {
    await call('PUT', '/keys/fresh', { value: i, tags: ['fresh'] });
    await call('POST', '/invalidate', { tag: 'fresh' });
    assert.equal((await call('GET', '/keys/fresh')).status, 404);
  }
});

test('GET /keys 와 /stats', async () => {
  await call('POST', '/invalidate', { all: true });
  await call('PUT', '/keys/s1', { value: 1 });
  await call('PUT', '/keys/s2', { value: 1 });
  await call('GET', '/keys/s1');
  await call('GET', '/keys/missing');
  const keys = await call('GET', '/keys');
  assert.deepEqual(keys.body.keys.sort(), ['s1', 's2']);
  assert.equal((await call('GET', '/keys?limit=0')).status, 400);
  assert.equal((await call('GET', '/keys?limit=abc')).status, 400);

  const stats = (await call('GET', '/stats')).body;
  assert.equal(stats.keys, 2);
  assert.ok(stats.hits >= 1 && stats.misses >= 1);
  assert.ok(stats.table.capacity >= 16);
});

test('응답 헤더: JSON + no-store', async () => {
  const r = await call('GET', '/health');
  assert.match(r.res.headers['content-type'], /application\/json/);
  assert.equal(r.res.headers['cache-control'], 'no-store');
});

test('인증: AUTH_TOKEN 설정 시 Bearer 토큰 필수 (health 제외)', async () => {
  const s = new MiniRedis({ sweepIntervalMs: 0 });
  const srv = createServer({ store: s, authToken: 's3cret' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/stats`)).status, 401);
    assert.equal((await fetch(`${url}/stats`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${url}/stats`, { headers: { Authorization: 'Bearer s3cret-longer' } })).status, 401);
    assert.equal((await fetch(`${url}/stats`, { headers: { Authorization: 's3cret' } })).status, 401);
    assert.equal((await fetch(`${url}/stats`, { headers: { Authorization: 'Bearer s3cret' } })).status, 200);
    const unauth = await fetch(`${url}/keys/a`, { method: 'PUT', body: '{"value":1}' });
    assert.equal(unauth.status, 401);
    assert.equal(s.size, 0);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    s.close();
  }
});

test('서버 에러 응답은 내부 정보를 노출하지 않는다', async () => {
  const broken = new MiniRedis({ sweepIntervalMs: 0 });
  broken.inspect = () => {
    throw new Error('secret internal path /etc/passwd');
  };
  const errors = [];
  const srv = createServer({ store: broken, logger: (lvl, info) => lvl === 'error' && errors.push(info) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/keys/a`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes('passwd'));
    assert.equal(errors.length, 1);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    broken.close();
  }
});
