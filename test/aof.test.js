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

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('AOF: 재시작 후 데이터 복원 (set / del / incr / expire / invalidate)', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, fsync: 'always' });
    a.set('str', 'hello');
    a.set('obj', { x: [1, 2, 3] }, { tags: ['grp'] });
    a.set('gone', 1);
    a.del('gone');
    a.incr('counter');
    a.incr('counter', 9);
    a.set('inv1', 1, { tags: ['bulk'] });
    a.set('inv2', 1, { tags: ['bulk'] });
    a.invalidate({ tag: 'bulk' });
    a.set('ttl', 'v', { ttlMs: 60_000 });
    a.set('persisted', 'p', { ttlMs: 60_000 });
    a.persist('persisted');
    a.close();

    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('str'), 'hello');
    assert.deepEqual(b.get('obj'), { x: [1, 2, 3] });
    assert.equal(b.get('gone'), undefined);
    assert.equal(b.get('counter'), 10);
    assert.equal(b.get('inv1'), undefined);
    assert.equal(b.get('inv2'), undefined);
    assert.equal(b.get('ttl'), 'v');
    assert.ok(b.ttl('ttl') > 0 && b.ttl('ttl') <= 60_000);
    assert.equal(b.ttl('persisted'), -1);
    // 태그 인덱스도 복원되어야 한다
    assert.equal(b.invalidate({ tag: 'grp' }), 1);
    assert.equal(b.get('obj'), undefined);
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 서버가 꺼져 있던 동안 만료된 키는 복원되지 않는다 (절대 시각 저장)', () => {
  const { dir, file } = tmpAof();
  try {
    let t = 1_000_000;
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, now: () => t });
    a.set('short', 1, { ttlMs: 1000 });
    a.set('long', 2, { ttlMs: 100_000 });
    a.close();

    t += 5000; // 5초 뒤에 재시작
    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, now: () => t });
    assert.equal(b.get('short'), undefined);
    assert.equal(b.get('long'), 2);
    assert.equal(b.ttl('long'), 95_000); // 남은 시간이 "재시작 시점 기준"으로 다시 시작되지 않음
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 키가 만료된 뒤 같은 키를 다시 set 해도 올바르게 복원', () => {
  const { dir, file } = tmpAof();
  try {
    let t = 1_000_000;
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, now: () => t });
    a.set('k', 'old', { ttlMs: 10 });
    t += 20;
    a.set('k', 'new'); // 만료된 뒤 새 값
    a.close();
    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, now: () => t + 100_000 });
    assert.equal(b.get('k'), 'new');
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 마지막 줄이 쓰다 만 상태(크래시)여도 나머지는 복구하고 파일을 정리', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    a.set('a', 1);
    a.set('b', 2);
    a.close();
    fs.appendFileSync(file, '{"o":"p","k":"c","v":3'); // 개행 없이 끊김

    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('a'), 1);
    assert.equal(b.get('b'), 2);
    assert.equal(b.get('c'), undefined);
    assert.ok(b.loadInfo.truncatedBytes > 0);
    b.set('d', 4); // 잘라낸 뒤 이어쓰기 해도 파일이 깨지지 않아야 한다
    b.close();

    const c = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(c.get('d'), 4);
    assert.equal(c.loadInfo.skipped, 0);
    c.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: 중간에 깨진 줄은 건너뛰고 나머지를 복구', () => {
  const { dir, file } = tmpAof();
  try {
    fs.writeFileSync(
      file,
      [
        '{"o":"p","k":"a","v":1,"e":null,"t":null}',
        'this is garbage',
        '{"o":"p","k":"b","v":2,"e":null,"t":null}',
        '{"no":"op"}',
        '[1,2,3]',
        '{"o":"unknown-future-op","k":"x"}',
        '{"o":"p","k":"c","v":3,"e":null,"t":null}',
        '',
      ].join('\n'),
    );
    const s = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(s.get('a'), 1);
    assert.equal(s.get('b'), 2);
    assert.equal(s.get('c'), 3);
    assert.equal(s.loadInfo.skipped, 3);
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: flush(all) 가 복원 시에도 반영된다', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    a.set('a', 1);
    a.invalidate({ all: true });
    a.set('b', 2);
    a.close();
    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('a'), undefined);
    assert.equal(b.get('b'), 2);
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF compaction: 로그가 줄어들고 내용은 동일, 이후 쓰기도 정상', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, aofRewriteMinLines: Infinity });
    for (let i = 0; i < 2000; i++) a.incr('counter'); // 로그 2000줄, 살아있는 키는 1개
    a.set('keep', { v: 1 });
    a.set('temp', 1);
    a.del('temp');
    const before = fs.statSync(file).size;
    a.compact();
    const after = fs.statSync(file).size;
    assert.ok(after < before / 100, `before=${before} after=${after}`);
    assert.equal(fs.existsSync(file + '.tmp'), false); // 임시 파일 정리됨
    a.set('after', 'compaction');
    a.close();

    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('counter'), 2000);
    assert.deepEqual(b.get('keep'), { v: 1 });
    assert.equal(b.get('temp'), undefined);
    assert.equal(b.get('after'), 'compaction');
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF 자동 compaction: 임계치를 넘으면 스스로 로그를 줄인다', () => {
  const { dir, file } = tmpAof();
  try {
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, aofRewriteMinLines: 100 });
    for (let i = 0; i < 1000; i++) a.incr('counter');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(lines < 300, `lines=${lines}`);
    a.close();
    const b = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(b.get('counter'), 1000);
    b.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF: compaction 은 만료된 키를 버린다', () => {
  const { dir, file } = tmpAof();
  try {
    let t = 1_000_000;
    const a = new MiniRedis({ aofPath: file, sweepIntervalMs: 0, now: () => t });
    a.set('dead', 1, { ttlMs: 10 });
    a.set('alive', 1);
    t += 10;
    a.compact();
    a.close();
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('dead'));
    assert.ok(text.includes('alive'));
  } finally {
    cleanup(dir);
  }
});

test('AOF: 잘못된 fsync 정책은 거부', () => {
  const { dir, file } = tmpAof();
  try {
    assert.throws(() => new MiniRedis({ aofPath: file, fsync: 'sometimes' }), /fsync/);
  } finally {
    cleanup(dir);
  }
});

test('AOF: 존재하지 않는 디렉터리도 자동 생성', () => {
  const { dir } = tmpAof();
  try {
    const file = path.join(dir, 'nested', 'deeper', 'x.aof');
    const s = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    s.set('a', 1);
    s.close();
    assert.ok(fs.existsSync(file));
  } finally {
    cleanup(dir);
  }
});

test('AOF: 서버 프로세스가 비정상 종료(SIGKILL)돼도 write 된 데이터는 남는다', async () => {
  const { dir, file } = tmpAof();
  try {
    const { spawn } = await import('node:child_process');
    const script = `
      import { MiniRedis } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
      const s = new MiniRedis({ aofPath: ${JSON.stringify(file)}, fsync: 'everysec' });
      for (let i = 0; i < 100; i++) s.set('k' + i, i);
      console.log('ready');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => d.toString().includes('ready') && resolve());
      child.on('error', reject);
      child.on('exit', () => reject(new Error('child exited early')));
    });
    child.removeAllListeners('exit');
    child.kill('SIGKILL'); // close() 도 fsync 도 호출되지 않는 강제 종료
    await new Promise((r) => child.on('exit', r));

    const s = new MiniRedis({ aofPath: file, sweepIntervalMs: 0 });
    assert.equal(s.size, 100);
    assert.equal(s.get('k99'), 99);
    s.close();
  } finally {
    cleanup(dir);
  }
});

test('AOF + LRU: 축출도 로그에 남아 재시작 후 되살아나지 않고, maxKeys 를 줄여 재시작하면 맞춰 축출', () => {
  const { dir, file } = tmpAof();
  try {
    const opts = { aofPath: file, sweepIntervalMs: 0, evictionPolicy: 'lru' };
    const a = new MiniRedis({ ...opts, maxKeys: 3 });
    a.set('a', 1);
    a.set('b', 2);
    a.set('c', 3);
    a.get('a');
    a.set('d', 4); // b 축출
    a.set('e', 5); // c 축출
    a.close();

    const b = new MiniRedis({ ...opts, maxKeys: 3 });
    assert.deepEqual(b.keys().sort(), ['a', 'd', 'e']);
    assert.equal(b.get('b'), undefined);
    b.close();

    // 읽기 기록은 로그에 없으므로 복원 후 순서는 "마지막으로 쓴 순서" (a, d, e) → a 가 가장 오래된 것으로 취급
    const c = new MiniRedis({ ...opts, maxKeys: 2 });
    assert.deepEqual(c.keys().sort(), ['d', 'e']);
    c.close();

    const d = new MiniRedis({ ...opts, maxKeys: 2 });
    assert.deepEqual(d.keys().sort(), ['d', 'e']); // 그 축출도 영속화됨
    d.close();
  } finally {
    cleanup(dir);
  }
});
