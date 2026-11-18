/**
 * 트랜잭션 / mset 의 AOF 기록 — "한 줄 = 전부 아니면 전무"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MiniRedis } from '../src/store.js';

function tmpAof() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-redis-test-'));
  return { dir, file: path.join(dir, 'test.aof') };
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('AOF: 트랜잭션과 mset 은 로그에 "한 줄"로 기록되고, 재시작 후 그대로 복원', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    a.mset([{ key: 'x', value: 1 }, { key: 'y', value: 2 }]);
    a.transaction([
      { cmd: 'incr', key: 'x', by: 5 },
      { cmd: 'del', key: 'y' },
      { cmd: 'set', key: 'z', value: 3, tags: ['t'] },
    ]);
    a.close();

    const lines = readLines(file);
    assert.equal(lines.length, 2); // 변경 5건이 줄 2개로
    assert.ok(lines.every((l) => l.startsWith('{"o":"t"')));

    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('x'), 6);
    assert.equal(b.get('y'), undefined);
    assert.equal(b.get('z'), 3);
    assert.equal(b.invalidate({ tag: 't' }), 1); // 태그 인덱스도 복원
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 쓰다 만 트랜잭션 줄은 통째로 버려진다 (절반만 복구되지 않음)', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    a.set('before', 1);
    a.close();
    // 트랜잭션의 두 번째 레코드를 쓰는 도중에 크래시한 상황
    fs.appendFileSync(
      file,
      '{"o":"t","r":[{"o":"p","k":"t1","v":1,"e":null,"t":null},{"o":"p","k":"t2","v":2,"e":nu',
    );
    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('before'), 1);
    assert.equal(b.get('t1'), undefined); // 첫 번째 레코드도 복구되지 않는다 (all-or-nothing)
    assert.equal(b.get('t2'), undefined);
    assert.ok(b.loadInfo.truncatedBytes > 0);
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 변경이 없는 트랜잭션(읽기만)은 로그에 아무것도 쓰지 않는다', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    a.set('k', 1);
    const before = readLines(file).length;
    a.transaction([{ cmd: 'get', key: 'k' }, { cmd: 'exists', key: 'k' }, { cmd: 'ttl', key: 'k' }]);
    assert.equal(readLines(file).length, before);

    // 변경이 하나뿐이면 {"o":"t"} 로 감싸지 않고 일반 레코드로 기록
    a.transaction([{ cmd: 'get', key: 'k' }, { cmd: 'incr', key: 'k' }]);
    const lines = readLines(file);
    assert.equal(lines.length, before + 1);
    assert.ok(lines.at(-1).startsWith('{"o":"p"'));
    a.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 실행 중 오류가 난 명령은 기록되지 않고, 성공한 명령만 복원된다', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    a.set('s', 'text');
    a.transaction([
      { cmd: 'set', key: 'a', value: 1 },
      { cmd: 'incr', key: 's' }, // 실패 → 상태 변화 없음
      { cmd: 'incr', key: 'a' },
    ]);
    a.close();
    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('s'), 'text');
    assert.equal(b.get('a'), 2);
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 배치 안의 LRU 축출도 함께 기록되어 재시작 후 일관', () => {
  const { dir, file } = tmpAof();
  try {
    const opts = { aofPath: file, sweepIntervalMs: 0, evictionPolicy: 'lru', maxKeys: 2 };
    const a = new MiniRedis(opts);
    a.set('a', 1);
    a.set('b', 1);
    a.mset([{ key: 'c', value: 1 }, { key: 'd', value: 1 }]); // a, b 를 축출
    a.close();
    const b = new MiniRedis(opts);
    assert.deepEqual(b.keys().sort(), ['c', 'd']);
    b.close();
  } finally {
    cleanup(dir);
  }
});
