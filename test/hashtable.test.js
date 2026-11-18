import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HashTable, fnv1a, INITIAL_CAPACITY } from '../src/hashtable.js';

test('fnv1a: 결정적이고 32bit unsigned', () => {
  assert.equal(fnv1a('hello'), fnv1a('hello'));
  assert.notEqual(fnv1a('hello'), fnv1a('hellp'));
  assert.equal(fnv1a(''), 0x811c9dc5);
  // 알려진 FNV-1a 테스트 벡터
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
  for (const s of ['', 'a', '한글키', '🔥', 'x'.repeat(1000)]) {
    const h = fnv1a(s);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  }
});

test('set / get / has / delete 기본 동작', () => {
  const t = new HashTable();
  assert.equal(t.get('a'), undefined);
  assert.equal(t.set('a', 1), true); // 새 키
  assert.equal(t.set('a', 2), false); // 덮어쓰기
  assert.equal(t.get('a'), 2);
  assert.equal(t.has('a'), true);
  assert.equal(t.size, 1);
  assert.equal(t.delete('a'), true);
  assert.equal(t.delete('a'), false);
  assert.equal(t.has('a'), false);
  assert.equal(t.size, 0);
});

test('충돌: 모든 키가 같은 버킷에 들어가도 정상 동작 (체이닝)', () => {
  const t = new HashTable({ hash: () => 7 });
  for (let i = 0; i < 50; i++) t.set(`k${i}`, i);
  assert.equal(t.size, 50);
  for (let i = 0; i < 50; i++) assert.equal(t.get(`k${i}`), i);
  assert.equal(t.stats().longestChain, 50);
  // 체인의 머리/중간/꼬리 삭제
  assert.equal(t.delete('k49'), true); // 마지막 삽입 = 체인 머리
  assert.equal(t.delete('k25'), true); // 중간
  assert.equal(t.delete('k0'), true); // 꼬리
  assert.equal(t.get('k49'), undefined);
  assert.equal(t.get('k25'), undefined);
  assert.equal(t.get('k0'), undefined);
  assert.equal(t.get('k1'), 1);
  assert.equal(t.size, 47);
});

test('리사이즈: 적재율 0.75 초과 시 2배 확장, 데이터 보존', () => {
  const t = new HashTable();
  assert.equal(t.capacity, INITIAL_CAPACITY);
  for (let i = 0; i < 13; i++) t.set(`k${i}`, i); // 13/16 > 0.75
  assert.equal(t.capacity, INITIAL_CAPACITY * 2);
  for (let i = 0; i < 13; i++) assert.equal(t.get(`k${i}`), i);
  for (let i = 13; i < 10_000; i++) t.set(`k${i}`, i);
  assert.ok(t.stats().loadFactor <= 0.75);
  for (let i = 0; i < 10_000; i += 97) assert.equal(t.get(`k${i}`), i);
});

test('리사이즈: 많이 지우면 축소되고 최소 용량 아래로는 내려가지 않음', () => {
  const t = new HashTable();
  for (let i = 0; i < 5000; i++) t.set(`k${i}`, i);
  const grown = t.capacity;
  assert.ok(grown >= 8192);
  for (let i = 0; i < 4990; i++) t.delete(`k${i}`);
  assert.ok(t.capacity < grown);
  assert.ok(t.capacity >= INITIAL_CAPACITY);
  for (let i = 4990; i < 5000; i++) assert.equal(t.get(`k${i}`), i);
  for (let i = 4990; i < 5000; i++) t.delete(`k${i}`);
  assert.equal(t.size, 0);
  assert.equal(t.capacity, INITIAL_CAPACITY);
});

test('용량은 항상 2의 거듭제곱', () => {
  const t = new HashTable({ initialCapacity: 100 });
  assert.equal(t.capacity, 128);
  for (let i = 0; i < 1000; i++) {
    t.set(`k${i}`, i);
    assert.equal(t.capacity & (t.capacity - 1), 0);
  }
});

test('해시가 음수/큰 수를 반환해도 인덱스가 범위 안', () => {
  const t = new HashTable({ hash: (k) => -k.length * 1e12 });
  for (let i = 0; i < 100; i++) t.set('x'.repeat(i + 1), i);
  for (let i = 0; i < 100; i++) assert.equal(t.get('x'.repeat(i + 1)), i);
});

test('특이한 키: 빈 문자열, 유니코드, prototype 관련 이름', () => {
  const t = new HashTable();
  const keys = ['', '한글', '🔥', '__proto__', 'constructor', 'toString', 'a b', 'a\nb'];
  keys.forEach((k, i) => t.set(k, i));
  keys.forEach((k, i) => assert.equal(t.get(k), i));
  assert.equal(t.size, keys.length);
});

test('scan: 커서를 따라가면 모든 엔트리를 정확히 한 번씩 방문', () => {
  const t = new HashTable();
  for (let i = 0; i < 1000; i++) t.set(`k${i}`, i);
  const seen = new Map();
  let cursor = 0;
  do {
    const r = t.scan(cursor, 20);
    for (const [k] of r.entries) seen.set(k, (seen.get(k) ?? 0) + 1);
    cursor = r.cursor;
  } while (cursor !== 0);
  assert.equal(seen.size, 1000);
  assert.ok([...seen.values()].every((n) => n === 1));
});

test('scan: 빈 테이블에서도 종료', () => {
  const t = new HashTable();
  assert.deepEqual(t.scan(0, 10), { cursor: 0, entries: [] });
});

test('keys / entries / iterator', () => {
  const t = new HashTable();
  t.set('a', 1);
  t.set('b', 2);
  assert.deepEqual([...t.keys()].sort(), ['a', 'b']);
  assert.deepEqual([...t].sort(), [['a', 1], ['b', 2]]);
});

test('clear', () => {
  const t = new HashTable();
  for (let i = 0; i < 100; i++) t.set(`k${i}`, i);
  t.clear();
  assert.equal(t.size, 0);
  assert.equal(t.capacity, INITIAL_CAPACITY);
  assert.equal(t.get('k1'), undefined);
});

test('분포: FNV-1a 가 버킷에 고르게 퍼뜨린다 (최장 체인이 작다)', () => {
  const t = new HashTable();
  for (let i = 0; i < 10_000; i++) t.set(`user:${i}`, i);
  const s = t.stats();
  assert.ok(s.longestChain <= 12, `longestChain=${s.longestChain}`);
  assert.ok(s.usedBuckets / s.capacity > 0.4);
});

test('속성 테스트: 무작위 연산 결과가 Map 과 항상 일치', () => {
  // 간단한 시드 PRNG(mulberry32)로 재현 가능하게
  let seed = 12345;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const table = new HashTable();
  const oracle = new Map();
  for (let i = 0; i < 50_000; i++) {
    const key = `k${Math.floor(rand() * 2000)}`;
    const op = rand();
    if (op < 0.5) {
      assert.equal(table.set(key, i), !oracle.has(key));
      oracle.set(key, i);
    } else if (op < 0.8) {
      assert.equal(table.delete(key), oracle.delete(key));
    } else {
      assert.equal(table.get(key), oracle.get(key));
    }
    assert.equal(table.size, oracle.size);
  }
  assert.deepEqual([...table].sort(), [...oracle].sort());
});

// ───────────── scan: 역순 이진 커서 ─────────────

test('scan: 역순 이진 커서 — 버킷을 상위 비트부터 방문 (용량 16: 0, 8, 4, 12, 2, 10, …)', () => {
  const t = new HashTable({ hash: (k) => Number(k) }); // 해시 = 키 숫자 → 버킷 번호가 곧 키
  for (let i = 0; i < 12; i++) t.set(String(i), i); // 12/16 = 0.75 → 확장되지 않음
  assert.equal(t.capacity, 16);

  const order = [];
  let cursor = 0;
  do {
    const r = t.scan(cursor, 1); // 한 번에 키 1개씩
    for (const [k] of r.entries) order.push(Number(k));
    cursor = r.cursor;
  } while (cursor !== 0);

  // 전체 방문 순서 [0,8,4,12,2,10,6,14,1,9,5,13,3,11,7,15] 에서 키가 있는 버킷(0~11)만
  assert.deepEqual(order, [0, 8, 4, 2, 10, 6, 1, 9, 5, 3, 11, 7]);
});

test('scan: 순회 도중 테이블이 커져도 처음부터 있던 키는 빠짐없이 반환', () => {
  const t = new HashTable();
  const original = Array.from({ length: 500 }, (_, i) => `orig:${i}`);
  for (const k of original) t.set(k, 1);
  const startCapacity = t.capacity;
  const seen = new Set();
  let cursor = 0;
  let pages = 0;
  let extra = 0;
  do {
    const r = t.scan(cursor, 7);
    for (const [k] of r.entries) seen.add(k);
    cursor = r.cursor;
    if (pages++ < 30) for (let j = 0; j < 20; j++) t.set(`new:${extra++}`, 1); // 순회 중에 키를 계속 추가
  } while (cursor !== 0);
  assert.ok(t.capacity > startCapacity, '순회 중에 확장이 일어나야 이 테스트가 의미가 있다');
  for (const k of original) assert.ok(seen.has(k), `missed ${k}`);
});

test('scan: 순회 도중 테이블이 줄어도 남아있는 키는 빠짐없이 반환', () => {
  const t = new HashTable();
  const keep = Array.from({ length: 20 }, (_, i) => `keep:${i}`);
  const drop = Array.from({ length: 3000 }, (_, i) => `drop:${i}`);
  for (const k of keep) t.set(k, 1);
  for (const k of drop) t.set(k, 1);
  const startCapacity = t.capacity;
  const seen = new Set();
  let cursor = 0;
  let next = 0;
  do {
    const r = t.scan(cursor, 10);
    for (const [k] of r.entries) seen.add(k);
    cursor = r.cursor;
    for (let j = 0; j < 100 && next < drop.length; j++) t.delete(drop[next++]); // 순회 중에 계속 삭제 → 여러 번 축소
  } while (cursor !== 0);
  assert.ok(t.capacity < startCapacity, '순회 중에 축소가 일어나야 이 테스트가 의미가 있다');
  for (const k of keep) assert.ok(seen.has(k), `missed ${k}`);
});

test('scan: 용량보다 큰 커서(리사이즈 전에 받은 값)도 안전하게 처리', () => {
  const t = new HashTable();
  for (let i = 0; i < 10; i++) t.set(`k${i}`, i);
  const r = t.scan(0xffffffff, 5);
  assert.ok(Number.isInteger(r.cursor) && r.cursor >= 0 && r.cursor <= 0xffffffff);
});
