/**
 * 배치(mget / mset) · SCAN · 트랜잭션 — 저장소(store) 계층 단위 테스트
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MiniRedis } from '../src/store.js';
import { InvalidArgumentError, StoreFullError } from '../src/errors.js';

/** 시간을 직접 조작할 수 있는 가짜 시계 */
function createClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function makeStore(opts = {}) {
  const clock = createClock();
  const store = new MiniRedis({ now: clock, sweepIntervalMs: 0, ...opts });
  return { store, clock };
}

const lruStore = (maxKeys = 3, opts = {}) => makeStore({ maxKeys, evictionPolicy: 'lru', ...opts });

// ───────────── mget ─────────────

test('mget: 순서·중복 유지, 없음 / null / 만료를 구분', () => {
  const { store, clock } = makeStore();
  store.set('a', 1);
  store.set('n', null);
  store.set('t', 'x', { ttlMs: 10 });
  clock.advance(10);
  const r = store.mget(['a', 'missing', 'n', 'a', 't']);
  assert.deepEqual(
    r.map((x) => (x === undefined ? 'MISSING' : x.value)),
    [1, 'MISSING', null, 1, 'MISSING'],
  );
  assert.deepEqual(store.mget([]), []);
});

test('mget: 하나라도 잘못된 키면 아무것도 읽지 않고, 에러에 위치가 표시된다', () => {
  const { store } = makeStore();
  store.set('a', 1);
  assert.throws(() => store.mget(['a', '']), /keys\[1\]/);
  assert.equal(store.stats().hits, 0);
  assert.throws(() => store.mget('a'), InvalidArgumentError);
  assert.throws(() => store.mget(undefined), InvalidArgumentError);
});

test('mget / mset / transaction: maxBatch 를 넘으면 거부', () => {
  const { store } = makeStore({ maxBatch: 3 });
  const keys = ['a', 'b', 'c', 'd'];
  assert.throws(() => store.mget(keys), /too many keys/);
  assert.throws(() => store.mset(keys.map((key) => ({ key, value: 1 }))), /too many entries/);
  assert.throws(() => store.transaction(keys.map((key) => ({ cmd: 'get', key }))), /too many commands/);
  assert.equal(store.mget(keys.slice(0, 3)).length, 3);
  assert.throws(() => makeStore({ maxBatch: 0 }), InvalidArgumentError);
});

// ───────────── mset ─────────────

test('mset: 여러 키 저장, 같은 키는 뒤의 것이 이김, ttl / tags 적용', () => {
  const { store } = makeStore();
  const n = store.mset([
    { key: 'a', value: 1 },
    { key: 'b', value: { x: 1 }, ttlMs: 1000, tags: ['g'] },
    { key: 'a', value: 2 },
  ]);
  assert.equal(n, 3);
  assert.equal(store.get('a'), 2);
  assert.equal(store.ttl('b'), 1000);
  assert.equal(store.invalidate({ tag: 'g' }), 1);
});

test('mset: 하나라도 잘못이면 전부 거부 (원자적) + 에러에 위치 표시', () => {
  const { store } = makeStore();
  store.set('keep', 1);
  assert.throws(() => store.mset([{ key: 'a', value: 1 }, { key: 'b', value: undefined }]), /entries\[1\]/);
  assert.throws(() => store.mset([{ key: 'a', value: 1 }, { key: '', value: 1 }]), /entries\[1\]/);
  assert.throws(() => store.mset([{ key: 'a', value: 1, ttlMs: -1 }]), /entries\[0\]/);
  assert.throws(() => store.mset([{ key: 'a', value: 1, nx: true }]), /nx\/xx/);
  assert.throws(() => store.mset([{ key: 'a', value: 1 }, null]), /entries\[1\]/);
  assert.throws(() => store.mset({ key: 'a', value: 1 }), InvalidArgumentError);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.size, 1);
});

test('mset: noeviction 에서 공간이 모자라면 하나도 저장하지 않는다 (덮어쓰기는 공간을 쓰지 않음)', () => {
  const { store } = makeStore({ maxKeys: 3 });
  store.set('a', 1);
  store.set('b', 1);
  assert.throws(() => store.mset([{ key: 'c', value: 1 }, { key: 'd', value: 1 }]), StoreFullError);
  assert.equal(store.size, 2);
  assert.equal(store.get('c'), undefined); // c 도 저장되지 않았다
  assert.equal(store.mset([{ key: 'a', value: 9 }, { key: 'c', value: 1 }]), 2); // a 는 덮어쓰기 → 신규는 1개
  assert.equal(store.get('a'), 9);
});

test('mset: 만료된 키는 공간 계산에서 빠진다', () => {
  const { store, clock } = makeStore({ maxKeys: 3 });
  store.set('a', 1, { ttlMs: 10 });
  store.set('b', 1);
  store.set('c', 1);
  clock.advance(10); // a 는 만료됐지만 아직 메모리에 있음
  assert.equal(store.mset([{ key: 'd', value: 1 }]), 1);
  assert.equal(store.get('a'), undefined);
});

test('mset: lru 에서는 오래된 키를 축출하며 들어가고, 서로 다른 키가 maxKeys 를 넘으면 거부', () => {
  const { store } = lruStore(3);
  store.set('a', 1);
  store.set('b', 1);
  store.set('c', 1);
  store.mset([{ key: 'd', value: 1 }, { key: 'e', value: 1 }]);
  assert.deepEqual(store.keys().sort(), ['c', 'd', 'e']);
  assert.throws(
    () => store.mset(['p', 'q', 'r', 's'].map((key) => ({ key, value: 1 }))),
    StoreFullError,
  );
  assert.deepEqual(store.keys().sort(), ['c', 'd', 'e']);
});

// ───────────── scan ─────────────

function scanAll(store, opts) {
  const keys = [];
  let cursor = 0;
  let pages = 0;
  do {
    const r = store.scan(cursor, opts);
    keys.push(...r.keys);
    cursor = r.cursor;
    pages++;
  } while (cursor !== 0);
  return { keys, pages };
}

test('scan: 끝까지 따라가면 모든 키가 정확히 한 번씩 나오고, 여러 페이지로 나뉜다', () => {
  const { store } = makeStore();
  for (let i = 0; i < 1000; i++) store.set(`k${i}`, i);
  const { keys, pages } = scanAll(store, { count: 50 });
  assert.equal(keys.length, 1000);
  assert.equal(new Set(keys).size, 1000);
  assert.ok(pages > 5, `pages=${pages}`);
});

test('scan: prefix 필터 — 빈 페이지가 나와도 cursor 가 0 이 아니면 계속 호출', () => {
  const { store } = makeStore();
  for (let i = 0; i < 100; i++) {
    store.set(`a:${i}`, i);
    store.set(`b:${i}`, i);
  }
  const { keys } = scanAll(store, { count: 10, prefix: 'a:' });
  assert.equal(keys.length, 100);
  assert.ok(keys.every((k) => k.startsWith('a:')));
});

test('scan: 만료된 키는 결과에서 빠지고 그 자리에서 정리된다', () => {
  const { store, clock } = makeStore();
  for (let i = 0; i < 5; i++) {
    store.set(`dead${i}`, 1, { ttlMs: 10 });
    store.set(`live${i}`, 1);
  }
  clock.advance(10);
  const { keys } = scanAll(store, { count: 3 });
  assert.deepEqual(keys.sort(), ['live0', 'live1', 'live2', 'live3', 'live4']);
  assert.equal(store.size, 5);
  assert.equal(store.stats().expiredLazy, 5);
});

test('scan: 순회 중에 키를 추가·삭제해도 처음부터 끝까지 있던 키는 모두 나온다', () => {
  const { store } = makeStore();
  for (let i = 0; i < 300; i++) store.set(`stable:${i}`, i);
  for (let i = 0; i < 2000; i++) store.set(`temp:${i}`, i);
  const seen = new Set();
  let cursor = 0;
  let step = 0;
  do {
    const r = store.scan(cursor, { count: 20 });
    r.keys.forEach((k) => seen.add(k));
    cursor = r.cursor;
    for (let j = 0; j < 50; j++) store.del(`temp:${step * 50 + j}`); // 지우고
    if (step < 20) for (let j = 0; j < 30; j++) store.set(`added:${step}:${j}`, 1); // 추가하고
    step++;
  } while (cursor !== 0);
  for (let i = 0; i < 300; i++) assert.ok(seen.has(`stable:${i}`), `missed stable:${i}`);
});

test('scan: 인자 검증', () => {
  const { store } = makeStore();
  assert.throws(() => store.scan(-1), InvalidArgumentError);
  assert.throws(() => store.scan(1.5), InvalidArgumentError);
  assert.throws(() => store.scan(2 ** 32), InvalidArgumentError);
  assert.throws(() => store.scan('0'), InvalidArgumentError);
  assert.throws(() => store.scan(0, { count: 0 }), InvalidArgumentError);
  assert.throws(() => store.scan(0, { count: 10_001 }), InvalidArgumentError);
  assert.throws(() => store.scan(0, { prefix: 5 }), InvalidArgumentError);
  assert.deepEqual(store.scan(0), { cursor: 0, keys: [] }); // 빈 저장소
});

// ───────────── transaction ─────────────

test('transaction: 명령 순서대로 실행하고, 앞 명령의 결과를 뒤 명령이 본다', () => {
  const { store } = makeStore();
  const r = store.transaction([
    { cmd: 'set', key: 'a', value: 5 },
    { cmd: 'incr', key: 'a', by: 10 },
    { cmd: 'get', key: 'a' },
    { cmd: 'exists', key: 'a' },
    { cmd: 'ttl', key: 'a' },
    { cmd: 'expire', key: 'a', ttlMs: 1000 },
    { cmd: 'ttl', key: 'a' },
    { cmd: 'persist', key: 'a' },
    { cmd: 'del', key: 'a' },
    { cmd: 'get', key: 'a' },
  ]);
  assert.deepEqual(r, [
    { ok: true, stored: true },
    { ok: true, value: 15 },
    { ok: true, found: true, value: 15 },
    { ok: true, exists: true },
    { ok: true, found: true, ttlMs: null },
    { ok: true, updated: true },
    { ok: true, found: true, ttlMs: 1000 },
    { ok: true, persisted: true },
    { ok: true, deleted: true },
    { ok: true, found: false },
  ]);
  assert.equal(store.size, 0);
  assert.deepEqual(store.transaction([]), []);
});

test('transaction: 형식이 잘못된 명령이 하나라도 있으면 아무것도 실행하지 않는다', () => {
  const { store } = makeStore();
  store.set('x', 1);
  assert.throws(
    () => store.transaction([{ cmd: 'incr', key: 'x' }, { cmd: 'nope', key: 'x' }]),
    /commands\[1\].*unknown command/,
  );
  assert.equal(store.get('x'), 1); // 앞의 incr 도 실행되지 않았다

  const bad = [
    { cmd: 'set', key: 'k' }, // value 없음
    { cmd: 'get' }, // key 없음
    { cmd: 'expire', key: 'x', ttlMs: -1 },
    { cmd: 'expire', key: 'x' },
    { cmd: 'incr', key: 'x', by: 1.5 },
    { cmd: 'invalidate' },
    { cmd: 'invalidate', key: 'a', tag: 'b' },
    { cmd: 'set', key: 'k', value: 1, nx: 'yes' },
    'string',
    null,
    [],
  ];
  for (const b of bad) {
    assert.throws(() => store.transaction([{ cmd: 'set', key: 'ok', value: 1 }, b]), InvalidArgumentError);
  }
  assert.equal(store.exists('ok'), false);
});

test('transaction: 실행 중 오류는 롤백하지 않는다 — 그 명령만 실패하고 나머지는 계속 실행', () => {
  const { store } = makeStore();
  store.set('s', 'text');
  const r = store.transaction([
    { cmd: 'set', key: 'a', value: 1 },
    { cmd: 'incr', key: 's' }, // 정수가 아님 → 실패
    { cmd: 'incr', key: 'a' },
  ]);
  assert.deepEqual(r[0], { ok: true, stored: true });
  assert.deepEqual(r[1], {
    ok: false,
    error: { code: 'WRONG_TYPE', message: 'value is not an integer', status: 409 },
  });
  assert.deepEqual(r[2], { ok: true, value: 2 });
  assert.equal(store.get('a'), 2); // 앞의 set 은 되돌려지지 않았다
});

test('transaction: 공간 부족(STORE_FULL)과 nx 조건 불충족도 명령 단위 결과', () => {
  const { store } = makeStore({ maxKeys: 1 });
  const r = store.transaction([
    { cmd: 'set', key: 'a', value: 1 },
    { cmd: 'set', key: 'b', value: 1 }, // 가득 참
    { cmd: 'set', key: 'a', value: 2, nx: true }, // 이미 있음
    { cmd: 'set', key: 'a', value: 3 }, // 덮어쓰기는 가능
  ]);
  assert.equal(r[0].ok, true);
  assert.equal(r[1].error.code, 'STORE_FULL');
  assert.deepEqual(r[2], { ok: true, stored: false });
  assert.deepEqual(r[3], { ok: true, stored: true });
  assert.equal(store.get('a'), 3);
});

test('transaction: 무효화(태그 / 전체) 포함, 통계에 집계', () => {
  const { store } = makeStore();
  const r = store.transaction([
    { cmd: 'set', key: 'a', value: 1, tags: ['t'] },
    { cmd: 'set', key: 'b', value: 1, tags: ['t'] },
    { cmd: 'invalidate', tag: 't' },
    { cmd: 'get', key: 'a' },
    { cmd: 'set', key: 'c', value: 1 },
    { cmd: 'invalidate', all: true },
  ]);
  assert.deepEqual(r[2], { ok: true, invalidated: 2 });
  assert.deepEqual(r[3], { ok: true, found: false });
  assert.deepEqual(r[5], { ok: true, invalidated: 1 });
  assert.equal(store.size, 0);
  assert.equal(store.stats().transactions, 1);
});
