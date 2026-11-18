#!/usr/bin/env node
/**
 * Mini Redis 서버 실행.
 *
 * 환경 변수
 *   PORT          기본 6380
 *   HOST          기본 127.0.0.1 (외부 공개는 HOST=0.0.0.0 + AUTH_TOKEN 권장)
 *   AOF_PATH      지정하면 영속성 활성화 (예: ./data/mini-redis.aof)
 *   FSYNC         always | everysec(기본) | no
 *   AUTH_TOKEN    지정하면 Authorization: Bearer <token> 필수
 *   MAX_KEYS      최대 키 수 (기본 무제한)
 *   MAX_BATCH     mget/mset/transaction 한 번에 허용하는 최대 개수 (기본 1000)
 *   EVICTION      noeviction(기본) | lru — MAX_KEYS 가 가득 찼을 때 에러 / 가장 오래 안 쓴 키 축출 (lru 는 MAX_KEYS 필요)
 */
import { MiniRedis } from '../src/store.js';
import { createServer } from '../src/server.js';

const port = Number(process.env.PORT ?? 6380);
const host = process.env.HOST ?? '127.0.0.1';

const store = new MiniRedis({
  aofPath: process.env.AOF_PATH || undefined,
  fsync: process.env.FSYNC || 'everysec',
  maxKeys: process.env.MAX_KEYS ? Number(process.env.MAX_KEYS) : Infinity,
  evictionPolicy: process.env.EVICTION || 'noeviction',
  maxBatch: process.env.MAX_BATCH ? Number(process.env.MAX_BATCH) : undefined,
});

const server = createServer({
  store,
  authToken: process.env.AUTH_TOKEN || undefined,
  logger: (level, info) => {
    if (level === 'error') console.error('[error]', info);
    else if (process.env.LOG_REQUESTS) console.log(`${info.method} ${info.url} ${info.status} ${info.ms.toFixed(2)}ms`);
  },
});

server.listen(port, host, () => {
  console.log(`Mini Redis listening on http://${host}:${port}`);
  if (store.loadInfo) {
    const { records, skipped, truncatedBytes } = store.loadInfo;
    console.log(`AOF restored: ${store.size} keys (records=${records}, skipped=${skipped}, truncatedBytes=${truncatedBytes})`);
  }
  if (!process.env.AUTH_TOKEN && host !== '127.0.0.1') {
    console.warn('WARNING: listening on a non-loopback address without AUTH_TOKEN');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    store.close(); // AOF fsync + close
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => { store.close(); process.exit(1); }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
