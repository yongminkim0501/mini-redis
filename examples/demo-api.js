/**
 * 데모 API: "느린 원본(DB)" 앞에 Mini Redis 캐시를 붙인 간단한 상품 API.
 *
 *   GET    /products/:id              상품 조회 (응답 헤더 X-Cache: HIT | MISS | BYPASS)
 *   PUT    /products/:id  {price}     가격 수정 → 해당 상품 캐시 무효화
 *   DELETE /cache/category/:c         카테고리 단위 캐시 일괄 무효화 (태그 사용)
 *
 * cache 를 null 로 넘기면 캐시 없이 매번 DB 를 조회한다 (성능 비교용 기준선).
 */
import http from 'node:http';

export const PRODUCT_COUNT = 1000;

/** 커넥션 풀이 있는 가짜 DB. 쿼리 1건 = latencyMs, 동시에 poolSize 개까지만 처리. */
export class FakeDb {
  #latencyMs;
  #poolSize;
  #active = 0;
  #waiters = [];
  #prices = new Map();
  queries = 0;

  constructor({ latencyMs = 50, poolSize = 10 } = {}) {
    this.#latencyMs = latencyMs;
    this.#poolSize = poolSize;
  }

  async #acquire() {
    if (this.#active < this.#poolSize) {
      this.#active++;
      return;
    }
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release() {
    const next = this.#waiters.shift();
    if (next) next(); // 슬롯을 대기자에게 바로 넘김 (#active 유지)
    else this.#active--;
  }

  async #query(fn) {
    await this.#acquire();
    try {
      this.queries++;
      await new Promise((r) => setTimeout(r, this.#latencyMs));
      return fn();
    } finally {
      this.#release();
    }
  }

  getProduct(id) {
    return this.#query(() => {
      if (!Number.isInteger(id) || id < 1 || id > PRODUCT_COUNT) return null;
      return {
        id,
        name: `Product ${id}`,
        category: `c${id % 5}`,
        price: this.#prices.get(id) ?? 1000 + id * 10,
      };
    });
  }

  updatePrice(id, price) {
    return this.#query(() => {
      if (!Number.isInteger(id) || id < 1 || id > PRODUCT_COUNT) return false;
      this.#prices.set(id, price);
      return true;
    });
  }
}

/**
 * @param {{ cache?: import('../src/client.js').MiniRedisClient | null, db?: FakeDb, ttlSeconds?: number }} options
 */
export function createDemoApi({ cache = null, db = new FakeDb(), ttlSeconds = 60 } = {}) {
  const NOT_FOUND_TTL = 10; // 없는 id 는 짧게 negative caching

  async function getProduct(id) {
    if (cache === null) return { value: await db.getProduct(id), source: 'BYPASS' };
    const { value, hit } = await cache.getOrSet(`product:${id}`, async () => {
      const p = await db.getProduct(id);
      return p; // 없으면 null → 그대로 캐싱 (cache penetration 방지)
    }, {
      ttl: (v) => (v === null ? NOT_FOUND_TTL : ttlSeconds),
      tags: [`category:c${id % 5}`],
    });
    return { value, source: hit ? 'HIT' : 'MISS' };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = /^\/products\/([^/]+)$/.exec(url.pathname);
      const c = /^\/cache\/category\/([^/]+)$/.exec(url.pathname);

      if (m && req.method === 'GET') {
        const id = Number(m[1]);
        const { value, source } = await getProduct(id);
        res.setHeader('X-Cache', source);
        return json(res, value === null ? 404 : 200, value ?? { error: 'product not found' });
      }

      if (m && req.method === 'PUT') {
        const id = Number(m[1]);
        const body = await readBody(req);
        if (!Number.isFinite(body?.price) || body.price < 0) {
          return json(res, 400, { error: '"price" must be a non-negative number' });
        }
        const updated = await db.updatePrice(id, body.price);
        if (!updated) return json(res, 404, { error: 'product not found' });
        // 원본이 바뀌었으니 캐시 무효화 (cache = null 이면 해당 없음)
        await cache?.invalidate({ key: `product:${id}` }).catch(() => {});
        return json(res, 200, { id, price: body.price });
      }

      if (c && req.method === 'DELETE' && cache) {
        const invalidated = await cache.invalidate({ tag: `category:${c[1]}` });
        return json(res, 200, { invalidated });
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  return { server, db };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
