/**
 * 데모 실행: Mini Redis 서버(6380) + 캐시 적용 API(4000) + 캐시 없는 API(4001)
 *   npm run demo
 *   curl -i localhost:4000/products/1   # 첫 호출 X-Cache: MISS (느림), 두 번째 HIT (빠름)
 *   curl -i localhost:4001/products/1   # 항상 BYPASS (느림)
 */
import { MiniRedis, createServer, MiniRedisClient } from '../src/index.js';
import { createDemoApi, FakeDb } from './demo-api.js';

const store = new MiniRedis({ aofPath: './data/demo.aof' });
const redis = createServer({ store });
await new Promise((r) => redis.listen(6380, '127.0.0.1', r));

const cache = new MiniRedisClient('http://127.0.0.1:6380');
const cached = createDemoApi({ cache, db: new FakeDb({ latencyMs: 100 }) });
const uncached = createDemoApi({ cache: null, db: new FakeDb({ latencyMs: 100 }) });
await new Promise((r) => cached.server.listen(4000, '127.0.0.1', r));
await new Promise((r) => uncached.server.listen(4001, '127.0.0.1', r));

console.log('Mini Redis        : http://127.0.0.1:6380');
console.log('API (with cache)  : http://127.0.0.1:4000/products/1');
console.log('API (no cache)    : http://127.0.0.1:4001/products/1');

process.on('SIGINT', () => { store.close(); process.exit(0); });
