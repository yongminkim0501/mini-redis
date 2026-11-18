/**
 * 배치(mget / mset) · SCAN · 트랜잭션 — HTTP API 와 클라이언트 기능 테스트
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MiniRedis } from '../src/store.js';
import { createServer } from '../src/server.js';
import { MiniRedisClient, MiniRedisHttpError } from '../src/client.js';

let store;
let server;
let client;

// keep-alive 소켓을 재사용해서 동시 요청이 많아도 연결 폭주 없이 테스트한다.
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

before(async () => {
  store = new MiniRedis({ sweepIntervalMs: 0 });
  server = createServer({ store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  client = new MiniRedisClient(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 5000 });
});

after(async () => {
  agent.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  store.close();
});

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, agent, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// ───────────── POST /mget ─────────────

test('POST /mget: 순서 유지, 없음(found:false) 과 null 값을 구분', async () => {
  await call('PUT', '/keys/m1', { value: 1 });
  await call('PUT', '/keys/m2', { value: null });
  const r = await call('POST', '/mget', { keys: ['m1', 'nope', 'm2', 'm1'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, [
    { key: 'm1', found: true, value: 1 },
    { key: 'nope', found: false },
    { key: 'm2', found: true, value: null },
    { key: 'm1', found: true, value: 1 },
  ]);
});

test('POST /mget: 입력 오류는 400, 메서드 오류는 405', async () => {
  assert.equal((await call('POST', '/mget', {})).status, 400); // keys 없음
  assert.equal((await call('POST', '/mget', { keys: 'm1' })).status, 400);
  assert.equal((await call('POST', '/mget', { keys: ['ok', ''] })).status, 400);
  assert.equal((await call('POST', '/mget')).status, 400); // 본문 없음
  assert.equal((await call('GET', '/mget')).status, 405);
});

// ───────────── POST /mset ─────────────

test('POST /mset: 저장하고 ttl(초) 와 tags 를 항목별로 적용', async () => {
  const r = await call('POST', '/mset', {
    entries: [
      { key: 'ms1', value: 1, ttl: 10 },
      { key: 'ms2', value: { a: 1 }, tags: ['mg'] },
      { key: 'ms3', value: 'x', ttlMs: 500 },
    ],
  });
  assert.deepEqual(r.body, { stored: 3 });
  assert.ok((await call('GET', '/keys/ms1')).body.ttlMs > 9000);
  assert.ok((await call('GET', '/keys/ms3')).body.ttlMs <= 500);
  assert.deepEqual((await call('POST', '/invalidate', { tag: 'mg' })).body, { invalidated: 1 });
});

test('POST /mset: 하나라도 잘못이면 400 + 위치 표시, 아무것도 저장되지 않는다', async () => {
  let r = await call('POST', '/mset', { entries: [{ key: 'bad1', value: 1 }, { key: 'bad2' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /entries\[1\]/);
  assert.equal((await call('GET', '/keys/bad1')).status, 404);

  r = await call('POST', '/mset', { entries: [{ key: 'bad1', value: 1, ttl: '1' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /entries\[0\]/);

  assert.equal((await call('POST', '/mset', { entries: 'x' })).status, 400);
  assert.equal((await call('POST', '/mset', { entries: [1] })).status, 400);
  assert.equal((await call('POST', '/mset', { entries: [{ key: 'bad1', value: 1, nx: true }] })).status, 400);
  assert.equal((await call('GET', '/keys/bad1')).status, 404);
});

// ───────────── GET /scan ─────────────

test('GET /scan: 페이지 단위로 전체 키를 순회하고, prefix 로 거른다', async () => {
  await call('POST', '/invalidate', { all: true });
  await Promise.all(Array.from({ length: 120 }, (_, i) => call('PUT', `/keys/sc:${i}`, { value: i })));
  await call('PUT', '/keys/other', { value: 1 });

  async function collect(query) {
    const keys = [];
    let cursor = 0;
    let pages = 0;
    do {
      const r = await call('GET', `/scan?cursor=${cursor}&count=25${query}`);
      assert.equal(r.status, 200);
      keys.push(...r.body.keys);
      cursor = r.body.cursor;
      pages++;
    } while (cursor !== 0);
    return { keys, pages };
  }

  const all = await collect('');
  assert.equal(new Set(all.keys).size, 121);
  assert.ok(all.pages > 1);

  const filtered = await collect('&prefix=sc%3A');
  assert.equal(filtered.keys.length, 120);
  assert.ok(filtered.keys.every((k) => k.startsWith('sc:')));

  // 파라미터를 안 주면 cursor=0, 기본 count
  assert.equal((await call('GET', '/scan')).status, 200);
});

test('GET /scan: 잘못된 파라미터는 400, 메서드 오류는 405', async () => {
  for (const q of ['cursor=-1', 'cursor=abc', 'cursor=1.5', 'cursor=4294967296', 'count=0', 'count=10001', 'count=x']) {
    assert.equal((await call('GET', `/scan?${q}`)).status, 400, q);
  }
  assert.equal((await call('POST', '/scan')).status, 405);
});

// ───────────── POST /transaction ─────────────

test('POST /transaction: 결과 순서, ttl(초) 변환, 실행 중 오류는 부분 실패', async () => {
  await call('PUT', '/keys/txtext', { value: 'abc' });
  const r = await call('POST', '/transaction', {
    commands: [
      { cmd: 'set', key: 'tx1', value: 1, ttl: 30 },
      { cmd: 'incr', key: 'tx1', by: 4 },
      { cmd: 'get', key: 'tx1' },
      { cmd: 'incr', key: 'txtext' }, // 실패
      { cmd: 'ttl', key: 'tx1' },
      { cmd: 'del', key: 'tx1' },
    ],
  });
  assert.equal(r.status, 200); // 부분 실패여도 요청 자체는 200
  const res = r.body.results;
  assert.deepEqual(res[0], { ok: true, stored: true });
  assert.deepEqual(res[1], { ok: true, value: 5 });
  assert.deepEqual(res[2], { ok: true, found: true, value: 5 });
  assert.equal(res[3].ok, false);
  assert.equal(res[3].error.code, 'WRONG_TYPE');
  assert.ok(res[4].ttlMs > 29_000 && res[4].ttlMs <= 30_000); // ttl: 30(초) → ms
  assert.deepEqual(res[5], { ok: true, deleted: true });
});

test('POST /transaction: 형식 오류는 400 이고 아무것도 실행하지 않는다', async () => {
  await call('PUT', '/keys/guard', { value: 1 });
  let r = await call('POST', '/transaction', {
    commands: [{ cmd: 'incr', key: 'guard' }, { cmd: 'bogus', key: 'guard' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /commands\[1\]/);
  assert.equal((await call('GET', '/keys/guard')).body.value, 1); // 앞의 incr 도 실행되지 않음

  assert.equal((await call('POST', '/transaction', {})).status, 400);
  assert.equal((await call('POST', '/transaction', { commands: [null] })).status, 400);
  assert.equal((await call('POST', '/transaction', { commands: [{ cmd: 'expire', key: 'guard', ttl: 0 }] })).status, 400);
  assert.equal((await call('GET', '/transaction')).status, 405);
});

test('POST /transaction: 명령 개수 상한(기본 1000) 초과는 400', async () => {
  const commands = Array.from({ length: 1001 }, () => ({ cmd: 'exists', key: 'x' }));
  const r = await call('POST', '/transaction', { commands });
  // 본문이 크면 413, 아니면 400 — 어느 쪽이든 실행되지 않고 거부된다
  assert.ok([400, 413].includes(r.status), `status=${r.status}`);
});

// ───────────── 동시성 ─────────────

test('동시성: 100개의 트랜잭션이 각각 같은 카운터를 두 번 올려도 서로 끼어들지 않는다', async () => {
  const rs = await Promise.all(
    Array.from({ length: 100 }, () =>
      call('POST', '/transaction', { commands: [{ cmd: 'incr', key: 'txc' }, { cmd: 'incr', key: 'txc' }] }),
    ),
  );
  for (const r of rs) {
    const [a, b] = r.body.results;
    assert.equal(b.value, a.value + 1, '한 트랜잭션의 두 incr 사이에 다른 요청이 끼어들었다');
  }
  assert.equal((await call('GET', '/keys/txc')).body.value, 200);
});

test('동시성: 이체 트랜잭션이 진행되는 동안에도 mget 은 항상 합계가 일정한 일관된 스냅샷을 본다', async () => {
  await call('PUT', '/keys/acct:a', { value: 1000 });
  await call('PUT', '/keys/acct:b', { value: 0 });
  const ops = [];
  for (let i = 0; i < 200; i++) {
    ops.push(
      call('POST', '/transaction', {
        commands: [{ cmd: 'incr', key: 'acct:a', by: -1 }, { cmd: 'incr', key: 'acct:b', by: 1 }],
      }),
    );
    ops.push(call('POST', '/mget', { keys: ['acct:a', 'acct:b'] }));
  }
  const results = await Promise.all(ops);
  let snapshots = 0;
  for (const r of results) {
    if (r.body.results?.[0]?.key === 'acct:a' && 'found' in r.body.results[0] && r.body.results.length === 2) {
      const [a, b] = r.body.results;
      assert.equal(a.value + b.value, 1000, `부분 이체 상태를 읽었다: a=${a.value} b=${b.value}`);
      snapshots++;
    }
  }
  assert.equal(snapshots, 200);
  const final = (await call('POST', '/mget', { keys: ['acct:a', 'acct:b'] })).body.results;
  assert.deepEqual([final[0].value, final[1].value], [800, 200]);
});

test('동시성: 동시에 들어온 mset 들이 겹치는 키를 써도 "한 요청의 값만" 남는다 (섞이지 않음)', async () => {
  const keys = ['mix:1', 'mix:2', 'mix:3', 'mix:4', 'mix:5'];
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      call('POST', '/mset', { entries: keys.map((key) => ({ key, value: i })) }),
    ),
  );
  const values = (await call('POST', '/mget', { keys })).body.results.map((r) => r.value);
  assert.equal(new Set(values).size, 1, `서로 다른 요청의 값이 섞였다: ${values}`);
});

// ───────────── 클라이언트 ─────────────

test('클라이언트: mset(객체 / 배열) 과 mget', async () => {
  assert.equal(await client.mset({ ca: 1, cb: null, cc: 'x' }, { ttl: 60 }), 3);
  assert.deepEqual(await client.mget(['ca', 'cb', 'zzz', 'cc']), [1, null, undefined, 'x']);
  assert.ok((await client.ttl('ca')) > 59_000);
  assert.equal(await client.mset([{ key: 'cd', value: 1, ttl: 5 }, { key: 'ce', value: 2 }]), 2);
  assert.deepEqual(await client.mget([]), []);
  await assert.rejects(client.mset([{ key: 'cf', value: 1 }, { key: '', value: 1 }]), (e) => e.status === 400);
  assert.equal(await client.get('cf'), undefined);
});

test('클라이언트: scanKeys 로 전체 키를 for await 로 순회', async () => {
  await client.invalidate({ all: true });
  const obj = {};
  for (let i = 0; i < 250; i++) obj[`sk:${i}`] = i;
  await client.mset(obj);
  await client.set('plain', 1);

  const seen = new Set();
  for await (const key of client.scanKeys({ count: 20, prefix: 'sk:' })) seen.add(key);
  assert.equal(seen.size, 250);

  const page = await client.scan(0, { count: 10 });
  assert.equal(typeof page.cursor, 'number');
  assert.ok(Array.isArray(page.keys));
});

test('클라이언트: multi().exec() — 결과가 명령 순서대로, 실패한 명령은 Error 객체', async () => {
  await client.set('word', 'text');
  const [stored, counter, value, failed, exists, deleted] = await client
    .multi()
    .set('mt', 1, { ttl: 30 })
    .incr('mt', 9)
    .get('mt')
    .incr('word')
    .exists('mt')
    .del('mt')
    .exec();
  assert.equal(stored, true);
  assert.equal(counter, 10);
  assert.equal(value, 10);
  assert.ok(failed instanceof MiniRedisHttpError);
  assert.equal(failed.code, 'WRONG_TYPE');
  assert.equal(failed.status, 409);
  assert.equal(exists, true);
  assert.equal(deleted, true);
  assert.equal(await client.get('mt'), undefined);
});

test('클라이언트: multi 의 get/ttl 은 없는 키를 undefined 로, invalidate/expire/persist 도 동작', async () => {
  await client.set('tg1', 1, { tags: ['tt'] });
  const r = await client
    .multi()
    .get('nope')
    .ttl('nope')
    .ttl('tg1')
    .expire('tg1', 100)
    .persist('tg1')
    .invalidate({ tag: 'tt' })
    .get('tg1')
    .exec();
  assert.deepEqual(r, [undefined, undefined, null, true, true, 1, undefined]);
});

test('클라이언트: 빈 multi 는 [] / 형식이 잘못되면 exec() 가 throw 하고 아무것도 실행되지 않는다', async () => {
  assert.deepEqual(await client.multi().exec(), []);
  await client.set('safe', 1);
  await assert.rejects(
    client.multi().incr('safe').set('bad', undefined).exec(),
    (e) => e instanceof MiniRedisHttpError && e.status === 400,
  );
  assert.equal(await client.get('safe'), 1);
});
