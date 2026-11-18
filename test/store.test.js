import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MiniRedis } from '../src/store.js';
import { InvalidArgumentError, WrongTypeError, StoreFullError } from '../src/errors.js';

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

test('저장 / 조회 / 삭제', () => {
  const { store } = makeStore();
  assert.equal(store.get('a'), undefined);
  assert.equal(store.set('a', 'hello'), true);
  assert.equal(store.get('a'), 'hello');
  assert.equal(store.exists('a'), true);
  assert.equal(store.del('a'), true);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.del('a'), false); // 이미 없음
  assert.equal(store.exists('a'), false);
});

test('다양한 JSON 값 타입 보존', () => {
  const { store } = makeStore();
  const values = [0, -1.5, 'str', '', true, false, null, [1, 2, { a: 3 }], { nested: { x: [1] } }];
  values.forEach((v, i) => store.set(`k${i}`, v));
  values.forEach((v, i) => assert.deepEqual(store.get(`k${i}`), v));
});

test('null 값은 "없음(undefined)"과 구분된다', () => {
  const { store } = makeStore();
  store.set('n', null);
  assert.equal(store.get('n'), null);
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.exists('n'), true);
});

test('덮어쓰기', () => {
  const { store } = makeStore();
  store.set('a', 1);
  store.set('a', 2);
  assert.equal(store.get('a'), 2);
  assert.equal(store.size, 1);
});

test('저장 값은 호출자 객체와 분리된다 (외부에서 수정해도 저장소 불변)', () => {
  const { store } = makeStore();
  const obj = { list: [1, 2] };
  store.set('o', obj);
  obj.list.push(3);
  assert.deepEqual(store.get('o'), { list: [1, 2] });
  const got = store.get('o');
  got.list.push(99);
  assert.deepEqual(store.get('o'), { list: [1, 2] });
});

test('입력 검증', () => {
  const { store } = makeStore();
  assert.throws(() => store.set('', 1), InvalidArgumentError);
  assert.throws(() => store.set(123, 1), InvalidArgumentError);
  assert.throws(() => store.set('x'.repeat(513), 1), InvalidArgumentError);
  assert.throws(() => store.set('k', undefined), InvalidArgumentError);
  assert.throws(() => store.set('k', () => {}), InvalidArgumentError);
  assert.throws(() => store.set('k', NaN), InvalidArgumentError);
  assert.throws(() => store.set('k', Infinity), InvalidArgumentError);
  assert.throws(() => store.set('k', 10n), InvalidArgumentError);
  const circular = {};
  circular.self = circular;
  assert.throws(() => store.set('k', circular), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { ttlMs: 0 }), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { ttlMs: -5 }), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { ttlMs: NaN }), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { ttlMs: 1e20 }), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { tags: 'x' }), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { tags: [''] }), InvalidArgumentError);
  assert.throws(() => store.set('k', 1, { nx: true, xx: true }), InvalidArgumentError);
  assert.equal(store.size, 0); // 실패한 set 은 아무것도 남기지 않는다
});

test('NX / XX 조건부 저장', () => {
  const { store } = makeStore();
  assert.equal(store.set('a', 1, { xx: true }), false); // 없는데 XX
  assert.equal(store.set('a', 1, { nx: true }), true);
  assert.equal(store.set('a', 2, { nx: true }), false); // 있는데 NX
  assert.equal(store.get('a'), 1);
  assert.equal(store.set('a', 3, { xx: true }), true);
  assert.equal(store.get('a'), 3);
});

// ───────────── TTL / 만료 ─────────────

test('TTL: 만료 전에는 조회되고, 만료 후에는 조회되지 않는다 (lazy expiration)', () => {
  const { store, clock } = makeStore();
  store.set('a', 'v', { ttlMs: 1000 });
  clock.advance(999);
  assert.equal(store.get('a'), 'v');
  clock.advance(1); // 정확히 만료 시각 → 만료로 취급
  assert.equal(store.get('a'), undefined);
  assert.equal(store.exists('a'), false);
  assert.equal(store.size, 0); // 접근 시점에 실제로 삭제됨
  assert.equal(store.stats().expiredLazy, 1);
});

test('TTL: 만료된 키에 NX 로 새로 저장 가능, 다른 연산에서도 없는 키로 취급', () => {
  const { store, clock } = makeStore();
  store.set('a', 1, { ttlMs: 100 });
  clock.advance(100);
  assert.equal(store.set('a', 2, { nx: true }), true);
  assert.equal(store.get('a'), 2);
  assert.equal(store.ttl('a'), -1); // 새 값에는 이전 TTL 이 남지 않는다
  store.set('b', 1, { ttlMs: 100 });
  clock.advance(100);
  assert.equal(store.del('b'), false);
  assert.equal(store.expire('b', 1000), false);
  assert.equal(store.ttl('b'), -2);
});

test('TTL: 값을 덮어쓰면 기존 TTL 은 제거된다', () => {
  const { store, clock } = makeStore();
  store.set('a', 1, { ttlMs: 100 });
  store.set('a', 2); // TTL 없이 덮어쓰기
  clock.advance(10_000);
  assert.equal(store.get('a'), 2);
});

test('ttl(): 남은 시간 / 만료 없음(-1) / 없는 키(-2)', () => {
  const { store, clock } = makeStore();
  store.set('a', 1, { ttlMs: 5000 });
  store.set('b', 1);
  assert.equal(store.ttl('a'), 5000);
  clock.advance(1200);
  assert.equal(store.ttl('a'), 3800);
  assert.equal(store.ttl('b'), -1);
  assert.equal(store.ttl('zzz'), -2);
});

test('expire / persist', () => {
  const { store, clock } = makeStore();
  store.set('a', 1);
  assert.equal(store.expire('a', 500), true);
  assert.equal(store.expire('nope', 500), false);
  assert.equal(store.persist('a'), true);
  assert.equal(store.persist('a'), false); // 이미 TTL 없음
  clock.advance(10_000);
  assert.equal(store.get('a'), 1);
  store.expire('a', 500);
  clock.advance(500);
  assert.equal(store.get('a'), undefined);
});

test('소수 TTL 은 올림 처리되어 0ms TTL(즉시 만료)이 되지 않는다', () => {
  const { store } = makeStore();
  store.set('a', 1, { ttlMs: 0.2 });
  assert.equal(store.ttl('a'), 1);
});

test('active expiration: 아무도 읽지 않는 만료 키도 sweep 으로 정리된다', () => {
  const { store, clock } = makeStore({ sweepBatch: 50 });
  for (let i = 0; i < 1000; i++) store.set(`tmp:${i}`, i, { ttlMs: 100 });
  for (let i = 0; i < 100; i++) store.set(`keep:${i}`, i);
  assert.equal(store.size, 1100);
  clock.advance(100);
  assert.equal(store.size, 1100); // 아직 아무도 건드리지 않았으므로 메모리에 남아 있음
  let guard = 0;
  while (store.size > 100 && guard++ < 1000) store.sweep();
  assert.equal(store.size, 100);
  assert.equal(store.stats().expiredActive, 1000);
  assert.equal(store.get('keep:5'), 5); // 살아있는 키는 건드리지 않는다
});

test('active expiration: 주기 타이머가 실제 시간에서 만료 키를 지운다', async () => {
  const store = new MiniRedis({ sweepIntervalMs: 20 });
  try {
    for (let i = 0; i < 50; i++) store.set(`k${i}`, i, { ttlMs: 30 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.size, 0);
  } finally {
    store.close();
  }
});

// ───────────── 원자적 증가 ─────────────

test('incr: 없는 키는 0에서 시작, TTL 유지', () => {
  const { store, clock } = makeStore();
  assert.equal(store.incr('c'), 1);
  assert.equal(store.incr('c', 5), 6);
  assert.equal(store.incr('c', -10), -4);
  store.set('t', 10, { ttlMs: 1000 });
  store.incr('t');
  assert.equal(store.ttl('t'), 1000);
  clock.advance(1000);
  assert.equal(store.incr('t'), 1); // 만료 후에는 새로 시작
});

test('incr: 정수가 아닌 값 / 오버플로 / 잘못된 증분은 에러', () => {
  const { store } = makeStore();
  store.set('s', 'text');
  store.set('f', 1.5);
  assert.throws(() => store.incr('s'), WrongTypeError);
  assert.throws(() => store.incr('f'), WrongTypeError);
  store.set('big', Number.MAX_SAFE_INTEGER);
  assert.throws(() => store.incr('big'), WrongTypeError);
  assert.equal(store.get('big'), Number.MAX_SAFE_INTEGER); // 실패 시 값 불변
  assert.throws(() => store.incr('x', 1.5), InvalidArgumentError);
  assert.throws(() => store.incr('x', NaN), InvalidArgumentError);
});

// ───────────── 무효화 ─────────────

test('invalidate: key / prefix / tag / all', () => {
  const { store } = makeStore();
  store.set('user:1', 'a', { tags: ['user', 'team:x'] });
  store.set('user:2', 'b', { tags: ['user'] });
  store.set('post:1', 'c', { tags: ['team:x'] });
  store.set('misc', 'd');

  assert.equal(store.invalidate({ key: 'misc' }), 1);
  assert.equal(store.invalidate({ key: 'misc' }), 0);
  assert.equal(store.get('misc'), undefined);

  assert.equal(store.invalidate({ tag: 'team:x' }), 2); // user:1, post:1
  assert.equal(store.get('user:1'), undefined);
  assert.equal(store.get('post:1'), undefined);
  assert.equal(store.get('user:2'), 'b');
  assert.equal(store.invalidate({ tag: 'team:x' }), 0);
  assert.equal(store.invalidate({ tag: 'no-such-tag' }), 0);

  store.set('user:3', 'e');
  assert.equal(store.invalidate({ prefix: 'user:' }), 2);
  assert.equal(store.size, 0);

  store.set('a', 1);
  store.set('b', 2, { tags: ['t'] });
  assert.equal(store.invalidate({ all: true }), 2);
  assert.equal(store.size, 0);
  assert.equal(store.invalidate({ tag: 't' }), 0); // 태그 인덱스도 비워짐
});

test('invalidate: 이미 만료된 키는 카운트하지 않는다', () => {
  const { store, clock } = makeStore();
  store.set('a', 1, { ttlMs: 10, tags: ['t'] });
  store.set('b', 1, { tags: ['t'] });
  clock.advance(10);
  assert.equal(store.invalidate({ tag: 't' }), 1);
});

test('invalidate: 덮어쓴 키는 이전 태그에서 빠지고 새 태그를 따른다', () => {
  const { store } = makeStore();
  store.set('k', 1, { tags: ['old'] });
  store.set('k', 2, { tags: ['new'] });
  assert.equal(store.invalidate({ tag: 'old' }), 0);
  assert.equal(store.get('k'), 2);
  assert.equal(store.invalidate({ tag: 'new' }), 1);
});

test('invalidate: 삭제/만료된 키는 태그 인덱스에 흔적을 남기지 않는다', () => {
  const { store, clock } = makeStore();
  store.set('a', 1, { tags: ['t1', 't2'] });
  store.set('b', 1, { tags: ['t3'], ttlMs: 10 });
  store.del('a');
  clock.advance(10);
  store.get('b'); // lazy expire
  assert.equal(store.stats().tags, 0);
});

test('invalidate: 기준은 정확히 하나만', () => {
  const { store } = makeStore();
  assert.throws(() => store.invalidate({}), InvalidArgumentError);
  assert.throws(() => store.invalidate({ key: 'a', tag: 'b' }), InvalidArgumentError);
  assert.throws(() => store.invalidate({ prefix: '' }), InvalidArgumentError);
  assert.throws(() => store.invalidate({ all: false }), InvalidArgumentError);
  assert.throws(() => store.invalidate(null), InvalidArgumentError);
});

// ───────────── 기타 ─────────────

test('keys: prefix / limit / 만료 키 제외', () => {
  const { store, clock } = makeStore();
  store.set('a:1', 1);
  store.set('a:2', 1);
  store.set('b:1', 1);
  store.set('a:exp', 1, { ttlMs: 5 });
  clock.advance(5);
  assert.deepEqual(store.keys({ prefix: 'a:' }).sort(), ['a:1', 'a:2']);
  assert.equal(store.keys().length, 3);
  assert.equal(store.keys({ limit: 1 }).length, 1);
});

test('maxKeys: 가득 차면 StoreFullError, 덮어쓰기/삭제 후에는 가능, 만료 키는 자리를 내준다', () => {
  const { store, clock } = makeStore({ maxKeys: 3 });
  store.set('a', 1, { ttlMs: 100 });
  store.set('b', 1);
  store.set('c', 1);
  assert.throws(() => store.set('d', 1), StoreFullError);
  assert.equal(store.set('b', 2), true); // 덮어쓰기는 허용
  assert.throws(() => store.incr('new-counter'), StoreFullError);
  clock.advance(100); // a 만료
  clock.advance(1000); // full sweep rate-limit 해제
  assert.equal(store.set('d', 1), true);
  store.del('b');
  assert.equal(store.set('e', 1), true);
});

test('stats: hit / miss / 비율', () => {
  const { store } = makeStore();
  store.set('a', 1);
  store.get('a');
  store.get('a');
  store.get('x');
  const s = store.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.hitRatio - 2 / 3) < 1e-9);
});

test('close 후에는 사용 불가', () => {
  const { store } = makeStore();
  store.close();
  assert.throws(() => store.get('a'), /closed/);
  store.close(); // 두 번 호출해도 안전
});

test('대량 데이터: 5만 키 저장/조회/삭제 후 일관성', () => {
  const { store } = makeStore();
  for (let i = 0; i < 50_000; i++) store.set(`k${i}`, i);
  assert.equal(store.size, 50_000);
  for (let i = 0; i < 50_000; i += 7) assert.equal(store.get(`k${i}`), i);
  for (let i = 0; i < 50_000; i += 2) store.del(`k${i}`);
  assert.equal(store.size, 25_000);
  assert.equal(store.get('k2'), undefined);
  assert.equal(store.get('k3'), 3);
});

// ───────────── LRU 축출 ─────────────

const lruStore = (maxKeys = 3, opts = {}) => makeStore({ maxKeys, evictionPolicy: 'lru', ...opts });

test('LRU: 가득 차면 가장 오래 안 쓴 키부터 축출', () => {
  const { store } = lruStore();
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.set('d', 4); // a 축출
  assert.equal(store.get('a'), undefined);
  assert.deepEqual(store.keys().sort(), ['b', 'c', 'd']);
  assert.equal(store.stats().evicted, 1);
  assert.equal(store.size, 3);
});

test('LRU: 읽기 / 덮어쓰기 / incr 는 최근 사용으로 갱신, keys() 는 갱신하지 않음', () => {
  let { store } = lruStore();
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.get('a'); // a 갱신 → 가장 오래된 건 b
  store.set('d', 4);
  assert.equal(store.get('b'), undefined);
  assert.equal(store.get('a'), 1);

  ({ store } = lruStore());
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.set('a', 9); // 덮어쓰기도 갱신 (그리고 축출은 일어나지 않음)
  assert.equal(store.stats().evicted, 0);
  store.set('d', 4);
  assert.equal(store.get('b'), undefined);

  ({ store } = lruStore());
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.incr('a');
  store.set('d', 4);
  assert.equal(store.get('b'), undefined);

  ({ store } = lruStore());
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.keys(); // 관리용 순회는 순서를 바꾸지 않는다
  store.set('d', 4);
  assert.equal(store.get('a'), undefined);
});

test('LRU: 만료된 키가 있으면 살아있는 키를 버리기 전에 먼저 정리', () => {
  const { store, clock } = lruStore();
  store.set('b', 1);
  store.set('c', 1);
  store.set('a', 1, { ttlMs: 100 }); // 가장 최근이지만 곧 만료
  clock.advance(100);
  store.set('d', 1);
  assert.equal(store.stats().evicted, 0);
  assert.deepEqual(store.keys().sort(), ['b', 'c', 'd']);
});

test('LRU: 축출된 키는 태그 인덱스에도 남지 않는다', () => {
  const { store } = lruStore(1);
  store.set('a', 1, { tags: ['t'] });
  store.set('b', 2);
  assert.equal(store.stats().tags, 0);
  assert.equal(store.invalidate({ tag: 't' }), 0);
});

test('LRU: 전체 무효화 / 삭제 후에도 리스트가 일관되다', () => {
  const { store } = lruStore(2);
  store.set('a', 1);
  store.set('b', 2);
  store.invalidate({ all: true });
  store.set('c', 3);
  store.set('d', 4);
  store.set('e', 5); // c 축출
  assert.deepEqual(store.keys().sort(), ['d', 'e']);
  store.del('d');
  store.set('f', 6);
  store.set('g', 7); // e 축출
  assert.deepEqual(store.keys().sort(), ['f', 'g']);
});

test('LRU: 설정 검증', () => {
  assert.throws(() => makeStore({ evictionPolicy: 'lru' }), InvalidArgumentError); // maxKeys 필요
  assert.throws(() => makeStore({ evictionPolicy: 'random', maxKeys: 5 }), InvalidArgumentError);
  assert.throws(() => makeStore({ maxKeys: 0 }), InvalidArgumentError);
  assert.throws(() => makeStore({ maxKeys: 1.5 }), InvalidArgumentError);
  assert.throws(() => makeStore({ maxKeys: NaN }), InvalidArgumentError);
});

test('LRU: noeviction(기본) 은 그대로 StoreFullError', () => {
  const { store } = makeStore({ maxKeys: 1 });
  store.set('a', 1);
  assert.throws(() => store.set('b', 1), StoreFullError);
  assert.equal(store.stats().evicted, 0);
});

test('LRU 속성 테스트: 무작위 연산 결과가 Map 기반 참조 구현과 항상 일치', () => {
  let seed = 777;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const MAX = 5;
  const { store } = lruStore(MAX);
  const oracle = new Map(); // Map 은 삽입 순서를 기억 → 맨 앞이 가장 오래된 키
  const touch = (k) => {
    const v = oracle.get(k);
    oracle.delete(k);
    oracle.set(k, v);
  };
  for (let i = 0; i < 20_000; i++) {
    const key = `k${Math.floor(rand() * 20)}`;
    const op = rand();
    if (op < 0.5) {
      if (oracle.has(key)) {
        oracle.set(key, i);
        touch(key);
      } else {
        if (oracle.size >= MAX) oracle.delete(oracle.keys().next().value);
        oracle.set(key, i);
      }
      store.set(key, i);
    } else if (op < 0.85) {
      assert.equal(store.get(key), oracle.get(key));
      if (oracle.has(key)) touch(key);
    } else {
      assert.equal(store.del(key), oracle.delete(key));
    }
    assert.deepEqual(store.keys().sort(), [...oracle.keys()].sort());
  }
});
