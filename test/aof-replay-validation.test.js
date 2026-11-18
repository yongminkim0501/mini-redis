/**
 * AOF 복구(replay) 시 레코드 필드 검증 — 이슈 #1 확인용.
 *
 * JSON 으로는 올바르지만 필드가 잘못된 레코드가 들어 있을 때
 * 기대 동작: 서버(생성자)가 죽지 않고, 잘못된 레코드는 건너뛰어 skipped 로 세며,
 *           나머지 정상 레코드는 모두 복원되고, 내부 상태(태그 인덱스 등)가 오염되지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MiniRedis } from '../src/store.js';

function withAof(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-redis-replay-'));
  const file = path.join(dir, 'test.aof');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  let store;
  try {
    store = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    fn(store);
  } finally {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const A = '{"o":"p","k":"a","v":1,"e":null,"t":null}';
const B = '{"o":"p","k":"b","v":2,"e":null,"t":null}';

test('replay: 키(k)가 없는 delete 레코드 → 죽지 않고 건너뛴다', () => {
  withAof([A, '{"o":"d"}', B], (s) => {
    assert.equal(s.get('a'), 1);
    assert.equal(s.get('b'), 2);
    assert.equal(s.loadInfo.skipped, 1);
  });
});

test('replay: 키(k)가 문자열이 아닌 delete 레코드 → 건너뛴다', () => {
  withAof([A, '{"o":"d","k":123}', '{"o":"d","k":null}', B], (s) => {
    assert.equal(s.get('a'), 1);
    assert.equal(s.get('b'), 2);
    assert.equal(s.loadInfo.skipped, 2);
  });
});

test('replay: tags(t)가 숫자인 put 레코드 → 죽지 않고 건너뛴다', () => {
  withAof([A, '{"o":"p","k":"x","v":1,"e":null,"t":5}', B], (s) => {
    assert.equal(s.get('a'), 1);
    assert.equal(s.get('b'), 2);
    assert.equal(s.exists('x'), false);
    assert.equal(s.loadInfo.skipped, 1);
  });
});

test('replay: tags(t)가 문자열이면 글자 단위 태그로 오염되지 않는다', () => {
  withAof(['{"o":"p","k":"x","v":1,"e":null,"t":"abc"}'], (s) => {
    assert.equal(s.stats().tags, 0, '태그 인덱스에 "a","b","c" 가 생기면 안 된다');
    assert.equal(s.invalidate({ tag: 'a' }), 0);
  });
});

test('replay: tags(t) 배열에 문자열이 아닌 원소 → 태그 인덱스가 오염되지 않는다', () => {
  withAof(['{"o":"p","k":"x","v":1,"e":null,"t":[1,{"z":1}]}'], (s) => {
    assert.equal(s.stats().tags, 0);
  });
});

test('replay: 값(v)이 없는 put 레코드 → exists/get/size 가 서로 모순되지 않는다', () => {
  withAof(['{"o":"p","k":"x","e":null,"t":null}'], (s) => {
    // 값이 undefined 인 엔트리가 들어가면 get() 은 "없음", exists() 는 "있음" 이 된다.
    assert.equal(s.exists('x'), s.get('x') !== undefined, 'exists 와 get 의 판단이 일치해야 한다');
    assert.equal(s.size, s.exists('x') ? 1 : 0);
  });
});

test('replay: 만료 시각(e)이 숫자/null 이 아니면 영구 키로 둔갑하지 않고 건너뛴다', () => {
  withAof([A, '{"o":"p","k":"x","v":1,"e":"1700000000000","t":null}', B], (s) => {
    assert.equal(s.exists('x'), false);
    assert.equal(s.get('a'), 1);
    assert.equal(s.get('b'), 2);
    assert.equal(s.loadInfo.skipped, 1);
  });
});

test('replay: 빈 키 / 너무 긴 키 레코드는 건너뛴다', () => {
  const longKey = 'k'.repeat(513);
  withAof(['{"o":"p","k":"","v":1,"e":null,"t":null}', `{"o":"p","k":"${longKey}","v":1,"e":null,"t":null}`, A], (s) => {
    assert.equal(s.size, 1);
    assert.equal(s.get('a'), 1);
    assert.equal(s.loadInfo.skipped, 2);
  });
});

test('replay: 잘못된 레코드 이후의 정상 레코드도 모두 복원된다 (복합)', () => {
  withAof(
    [
      A,
      '{"o":"d"}',
      '{"o":"p","k":"t","v":1,"e":null,"t":7}',
      '{"o":"d","k":"a"}',
      B,
      '{"o":"p","k":"c","v":3,"e":null,"t":["tag"]}',
    ],
    (s) => {
      assert.equal(s.exists('a'), false, '정상 delete 는 적용');
      assert.equal(s.get('b'), 2);
      assert.equal(s.get('c'), 3);
      assert.equal(s.invalidate({ tag: 'tag' }), 1);
      assert.equal(s.loadInfo.skipped, 2);
    },
  );
});

// ───────── 트랜잭션 레코드 {"o":"t","r":[…]} ─────────
// 트랜잭션은 복구할 때도 "통째로 적용 or 통째로 무시" 여야 한다 (반쪽 복구 금지).

const P = (k, v) => `{"o":"p","k":"${k}","v":${v},"e":null,"t":null}`;
const T = (...inner) => `{"o":"t","r":[${inner.join(',')}]}`;

test('replay(t): 정상 트랜잭션은 안의 레코드를 순서대로 모두 적용', () => {
  withAof([T(P('x', 1), P('y', 2), '{"o":"d","k":"x"}')], (s) => {
    assert.equal(s.exists('x'), false);
    assert.equal(s.get('y'), 2);
    assert.equal(s.loadInfo.skipped, 0);
    assert.equal(s.loadInfo.records, 1);
  });
});

test('replay(t): 안에 잘못된 레코드가 하나라도 있으면 아무것도 적용하지 않고 skipped 로 센다', () => {
  withAof([A, T(P('x', 1), '{"o":"d"}', P('y', 2)), B], (s) => {
    assert.equal(s.exists('x'), false, '앞쪽 레코드도 적용되면 안 된다');
    assert.equal(s.exists('y'), false, '뒤쪽 레코드도 적용되면 안 된다');
    assert.equal(s.get('a'), 1, '트랜잭션 밖의 레코드는 그대로 복원');
    assert.equal(s.get('b'), 2);
    assert.equal(s.loadInfo.skipped, 1);
    assert.equal(s.loadInfo.records, 2);
  });
});

test('replay(t): 마지막 레코드만 잘못돼도(tags 숫자) 앞의 레코드까지 통째로 무시', () => {
  withAof([T(P('x', 1), '{"o":"p","k":"y","v":2,"e":null,"t":5}')], (s) => {
    assert.equal(s.size, 0);
    assert.equal(s.stats().tags, 0);
    assert.equal(s.loadInfo.skipped, 1);
  });
});

test('replay(t): r 이 배열이 아니거나 없으면 건너뛴다', () => {
  withAof([A, '{"o":"t","r":"garbage"}', '{"o":"t"}', '{"o":"t","r":{"0":1}}'], (s) => {
    assert.equal(s.get('a'), 1);
    assert.equal(s.loadInfo.skipped, 3);
  });
});

test('replay(t): 안에 객체가 아닌 원소(null / 숫자 / 배열)가 있으면 건너뛴다', () => {
  withAof([T(P('x', 1), 'null'), T(P('y', 1), '7'), T(P('z', 1), '[1]')], (s) => {
    assert.equal(s.size, 0);
    assert.equal(s.loadInfo.skipped, 3);
  });
});

test('replay(t): 트랜잭션 안의 트랜잭션(중첩)은 잘못된 레코드로 본다', () => {
  withAof([T(P('x', 1), T(P('y', 2)))], (s) => {
    assert.equal(s.size, 0);
    assert.equal(s.loadInfo.skipped, 1);
  });
});

test('replay(t): 빈 트랜잭션 / 안의 flush / 알 수 없는 o 는 정상 처리', () => {
  withAof([A, T(), T('{"o":"f"}', P('x', 1)), T('{"o":"future-op","k":"q"}', P('y', 2))], (s) => {
    assert.equal(s.exists('a'), false, 'flush 가 적용됨');
    assert.equal(s.get('x'), 1);
    assert.equal(s.get('y'), 2);
    assert.equal(s.loadInfo.skipped, 0);
  });
});
