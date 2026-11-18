/** 직접 구현한 HashTable 과 내장 Map 의 단순 비교 (참고용). 실행: npm run bench:hashtable */
import { performance } from 'node:perf_hooks';
import { HashTable } from '../src/hashtable.js';

const N = Number(process.env.N ?? 200_000);
const keys = Array.from({ length: N }, (_, i) => `user:${i}`);

function time(label, fn) {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  console.log(`${label.padEnd(28)} ${ms.toFixed(1).padStart(8)} ms  (${((N / ms) * 1000 / 1e6).toFixed(2)} M ops/s)`);
}

for (const [name, make] of [['HashTable (직접 구현)', () => new HashTable()], ['Map (내장)', () => new Map()]]) {
  const m = make();
  console.log(`\n${name}  N=${N}`);
  time('set', () => keys.forEach((k, i) => m.set(k, i)));
  time('get (hit)', () => keys.forEach((k) => m.get(k)));
  time('delete', () => keys.forEach((k) => m.delete(k)));
}
const t = new HashTable();
keys.forEach((k, i) => t.set(k, i));
console.log('\n해시 분포 통계:', t.stats());
