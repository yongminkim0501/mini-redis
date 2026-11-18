/**
 * 트랜잭션이 왜 필요한가: 이체(A 에서 빼고 B 에 더하기) 도중의 "중간 상태" 관찰
 *
 *   node examples/transaction-demo.js
 *
 * 계좌 a=1000, b=0. 이체는 "a 에서 1 빼기" + "b 에 1 더하기" 두 단계이고, 합계는 항상 1000 이어야 한다.
 * 이체가 진행되는 동안 다른 클라이언트가 두 계좌를 읽으면…
 *   - 요청 2개로 나눠 이체(트랜잭션 없음): 첫 요청과 둘째 요청 사이에 읽으면 합계가 999 로 보인다.
 *   - 트랜잭션으로 이체: 두 단계가 끼어들기 없이 연달아 실행되므로 합계가 항상 1000 으로 보인다.
 */
import { MiniRedis, createServer, MiniRedisClient } from '../src/index.js';

const TRANSFERS = 300;
const LIMIT = 20; // 동시에 열어 둘 요청 수 (수백 개를 한꺼번에 열면 연결이 몰려 거부될 수 있다)

/** tasks(함수 배열)를 최대 limit 개씩만 동시에 실행하고 결과를 순서대로 돌려준다. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

const store = new MiniRedis({ sweepIntervalMs: 0 });
const server = createServer({ store });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const client = new MiniRedisClient(`http://127.0.0.1:${server.address().port}`);

async function scenario(label, transfer) {
  await client.mset({ a: 1000, b: 0 });
  const transfers = Array.from({ length: TRANSFERS }, () => transfer);
  // 이체가 진행되는 동안 계속 읽는다 (mget 은 두 값을 한 번에 일관되게 읽는다)
  const readers = Array.from({ length: TRANSFERS }, () => async () => {
    const [a, b] = await client.mget(['a', 'b']);
    return a + b;
  });
  const [, sums] = await Promise.all([pool(transfers, LIMIT), pool(readers, LIMIT)]);
  const broken = sums.filter((s) => s !== 1000);
  const [a, b] = await client.mget(['a', 'b']);
  console.log(
    `${label.padEnd(24)} 읽기 ${sums.length}번 중 합계가 틀리게 보인 횟수: ${String(broken.length).padStart(3)}` +
      (broken.length ? ` (예: ${[...new Set(broken)].slice(0, 3).join(', ')})` : '') +
      `   최종 a=${a}, b=${b}`,
  );
}

await scenario('트랜잭션 없음 (요청 2개)', async () => {
  await client.incr('a', -1);
  await client.incr('b', 1);
});

await scenario('트랜잭션 (요청 1개)', async () => {
  await client.multi().incr('a', -1).incr('b', 1).exec();
});

server.closeAllConnections();
server.close();
store.close();
