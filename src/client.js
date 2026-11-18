/**
 * MiniRedis HTTP 클라이언트 (Node 18+ 내장 fetch 사용).
 *
 *   const cache = new MiniRedisClient('http://localhost:6380', { token: '...' });
 *   await cache.set('user:1', { name: 'kim' }, { ttl: 60, tags: ['user'] });
 *   await cache.get('user:1');          // { name: 'kim' }  (없거나 만료되면 undefined)
 *   await cache.getOrSet('k', loader, { ttl: 30 });   // cache-aside 패턴
 */

export class MiniRedisHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'MiniRedisHttpError';
    this.status = status;
    this.code = code;
  }
}

/** cache.multi() 가 돌려주는 명령 모음. exec() 를 호출할 때 비로소 서버로 전송된다. */
export class MiniRedisTransaction {
  #commands = [];
  #send;

  constructor(send) {
    this.#send = send;
  }

  #add(command) {
    this.#commands.push(command);
    return this;
  }

  /** opts: { ttl(초), ttlMs, tags, nx, xx } */
  set(key, value, opts = {}) { return this.#add({ ...opts, cmd: 'set', key, value }); }
  get(key) { return this.#add({ cmd: 'get', key }); }
  del(key) { return this.#add({ cmd: 'del', key }); }
  exists(key) { return this.#add({ cmd: 'exists', key }); }
  incr(key, by = 1) { return this.#add({ cmd: 'incr', key, by }); }
  ttl(key) { return this.#add({ cmd: 'ttl', key }); }
  expire(key, ttlSeconds) { return this.#add({ cmd: 'expire', key, ttl: ttlSeconds }); }
  persist(key) { return this.#add({ cmd: 'persist', key }); }
  /** @param {{ key?: string, prefix?: string, tag?: string, all?: boolean }} criteria */
  invalidate(criteria) { return this.#add({ ...criteria, cmd: 'invalidate' }); }

  get length() {
    return this.#commands.length;
  }

  async exec() {
    if (this.#commands.length === 0) return [];
    return this.#send(this.#commands);
  }
}

export class MiniRedisClient {
  #baseUrl;
  #token;
  #timeoutMs;
  #inflight = new Map(); // single-flight: key -> Promise

  /**
   * @param {string} baseUrl
   * @param {{ token?: string, timeoutMs?: number }} [options]
   */
  constructor(baseUrl, { token, timeoutMs = 2000 } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async #request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    const res = await fetch(this.#baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    return { status: res.status, json };
  }

  #throwIfError({ status, json }) {
    if (status >= 400) {
      throw new MiniRedisHttpError(
        status,
        json?.error?.code ?? 'UNKNOWN',
        json?.error?.message ?? `HTTP ${status}`,
      );
    }
  }

  static #keyPath(key) {
    // URL 표준(fetch 포함)은 경로의 '.' / '..' 세그먼트를 (퍼센트 인코딩해도) 정규화해 버리므로
    // 이 두 키는 URL 경로로 안전하게 전달할 수 없다. 엉뚱한 경로로 가기 전에 명시적으로 거부한다.
    if (key === '.' || key === '..') {
      throw new MiniRedisHttpError(400, 'INVALID_ARGUMENT', 'keys "." and ".." are not supported over HTTP');
    }
    return `/keys/${encodeURIComponent(key)}`;
  }

  /** @returns {Promise<*>} 값. 없거나 만료됐으면 undefined (저장된 null 과 구분) */
  async get(key) {
    const res = await this.#request('GET', MiniRedisClient.#keyPath(key));
    if (res.status === 404) return undefined;
    this.#throwIfError(res);
    return res.json.value;
  }

  /**
   * @param {{ ttl?: number, ttlMs?: number, tags?: string[], nx?: boolean, xx?: boolean }} [opts]
   * @returns {Promise<boolean>} nx/xx 조건 때문에 저장되지 않았으면 false
   */
  async set(key, value, opts = {}) {
    const res = await this.#request('PUT', MiniRedisClient.#keyPath(key), { value, ...opts });
    if (res.status === 409 && res.json?.error?.code === 'CONDITION_NOT_MET') return false;
    this.#throwIfError(res);
    return true;
  }

  async del(key) {
    const res = await this.#request('DELETE', MiniRedisClient.#keyPath(key));
    if (res.status === 404) return false;
    this.#throwIfError(res);
    return true;
  }

  async exists(key) {
    return (await this.ttl(key)) !== undefined;
  }

  /** @returns {Promise<number|null|undefined>} 남은 ms, 만료 없음이면 null, 키가 없으면 undefined */
  async ttl(key) {
    const res = await this.#request('GET', `${MiniRedisClient.#keyPath(key)}/ttl`);
    if (res.status === 404) return undefined;
    this.#throwIfError(res);
    return res.json.ttlMs;
  }

  async expire(key, ttlSeconds) {
    const res = await this.#request('POST', `${MiniRedisClient.#keyPath(key)}/expire`, {
      ttl: ttlSeconds,
    });
    if (res.status === 404) return false;
    this.#throwIfError(res);
    return true;
  }

  async persist(key) {
    const res = await this.#request('POST', `${MiniRedisClient.#keyPath(key)}/persist`);
    if (res.status === 404) return false;
    this.#throwIfError(res);
    return res.json.persisted;
  }

  async incr(key, by = 1) {
    const res = await this.#request('POST', `${MiniRedisClient.#keyPath(key)}/incr`, { by });
    this.#throwIfError(res);
    return res.json.value;
  }

  async keys({ prefix = '', limit = 1000 } = {}) {
    const q = new URLSearchParams({ prefix, limit: String(limit) });
    const res = await this.#request('GET', `/keys?${q}`);
    this.#throwIfError(res);
    return res.json.keys;
  }

  /** @param {{ key?: string, prefix?: string, tag?: string, all?: boolean }} criteria */
  async invalidate(criteria) {
    const res = await this.#request('POST', '/invalidate', criteria);
    this.#throwIfError(res);
    return res.json.invalidated;
  }

  // ───────────── 배치 / SCAN / 트랜잭션 ─────────────

  /**
   * 여러 키를 한 번의 요청으로 읽는다 (왕복 1회, 서로 일관된 스냅샷).
   * @returns {Promise<Array<*>>} keys 와 같은 순서. 없거나 만료된 키는 undefined (저장된 null 과 구분됨)
   */
  async mget(keys) {
    const res = await this.#request('POST', '/mget', { keys });
    this.#throwIfError(res);
    return res.json.results.map((r) => (r.found ? r.value : undefined));
  }

  /**
   * 여러 키를 한 번의 요청으로 저장한다. 전부 저장되거나 전부 거부된다.
   *   mset({ a: 1, b: 2 }, { ttl: 60, tags: ['t'] })                      // 객체 형태: 옵션은 전체에 적용
   *   mset([{ key: 'a', value: 1, ttl: 10 }, { key: 'b', value: 2 }])     // 배열 형태: 항목별 옵션
   * @returns {Promise<number>} 저장한 개수
   */
  async mset(entries, opts = {}) {
    const list = Array.isArray(entries)
      ? entries
      : Object.entries(entries).map(([key, value]) => ({ key, value, ...opts }));
    const res = await this.#request('POST', '/mset', { entries: list });
    this.#throwIfError(res);
    return res.json.stored;
  }

  /**
   * 커서 기반 키 순회 한 페이지. cursor 0 으로 시작해서 돌려받은 cursor 가 0 이면 끝.
   * prefix 로 걸러지면 keys 가 비어 있어도 cursor 가 0 이 아니면 계속 호출해야 한다.
   * @returns {Promise<{ cursor: number, keys: string[] }>}
   */
  async scan(cursor = 0, { count, prefix = '' } = {}) {
    const q = new URLSearchParams({ cursor: String(cursor), prefix });
    if (count !== undefined) q.set('count', String(count));
    const res = await this.#request('GET', `/scan?${q}`);
    this.#throwIfError(res);
    return res.json;
  }

  /**
   * 모든 키를 한 번에 하나씩 비동기로 순회한다. (for await (const key of cache.scanKeys()) …)
   * 순회 중 서버 테이블이 리사이즈되면 같은 키가 두 번 나올 수 있다 (빠지는 키는 없다).
   */
  async *scanKeys({ count = 100, prefix = '' } = {}) {
    let cursor = 0;
    do {
      const page = await this.scan(cursor, { count, prefix });
      yield* page.keys;
      cursor = page.cursor;
    } while (cursor !== 0);
  }

  /**
   * 트랜잭션: 여러 명령을 한 요청으로 보내 끼어들기 없이 연달아 실행한다.
   *
   *   const [stored, count, value] = await cache.multi()
   *     .set('a', 1)
   *     .incr('counter')
   *     .get('a')
   *     .exec();
   *
   * - 결과는 명령 순서대로. 실행 중 실패한 명령(예: 정수가 아닌 값에 incr)은 값 자리에
   *   MiniRedisHttpError 객체가 들어가고(롤백은 없다), 나머지 명령은 그대로 실행된다.
   * - 형식이 잘못된 명령이 하나라도 있으면 아무것도 실행되지 않고 exec() 가 throw 한다.
   */
  multi() {
    return new MiniRedisTransaction((commands) => this.#transaction(commands));
  }

  async #transaction(commands) {
    const res = await this.#request('POST', '/transaction', { commands });
    this.#throwIfError(res);
    return res.json.results.map((r, i) => {
      if (!r.ok) return new MiniRedisHttpError(r.error.status, r.error.code, r.error.message);
      switch (commands[i].cmd) {
        case 'set': return r.stored;
        case 'get': return r.found ? r.value : undefined;
        case 'del': return r.deleted;
        case 'exists': return r.exists;
        case 'incr': return r.value;
        case 'ttl': return r.found ? r.ttlMs : undefined;
        case 'expire': return r.updated;
        case 'persist': return r.persisted;
        case 'invalidate': return r.invalidated;
        default: return r;
      }
    });
  }

  async stats() {
    const res = await this.#request('GET', '/stats');
    this.#throwIfError(res);
    return res.json;
  }

  async health() {
    try {
      const res = await this.#request('GET', '/health');
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Cache-aside 헬퍼.
   *  1. 캐시 조회 → 있으면 반환
   *  2. 없으면 loader() 로 원본 조회 후 캐시에 저장
   *
   * 장애/동시성 edge case 처리:
   *  - single-flight: 같은 키로 동시에 miss 가 나도 loader 는 한 번만 실행 (cache stampede 방지)
   *  - fail-open: 캐시 서버가 죽었거나 느려도 loader 결과를 그대로 반환 (캐시는 "있으면 좋은 것")
   *  - loader 가 throw 하면 아무것도 캐시하지 않고 그대로 전파 (에러를 캐시하지 않음)
   *  - loader 가 null 을 반환하면 null 도 캐시 (negative caching → 없는 id 반복 조회로 DB 가 뚫리는 것 방지)
   *    loader 가 undefined 를 반환하면 캐시하지 않는다.
   *
   * @param {string} key
   * @param {() => Promise<*>} loader
   * @param {{ ttl?: number | ((value: *) => number), tags?: string[] }} [opts]  ttl: 초 단위. 함수면 값에 따라 결정.
   * @returns {Promise<{ value: *, hit: boolean }>}
   */
  async getOrSet(key, loader, { ttl, tags } = {}) {
    try {
      const cached = await this.get(key);
      if (cached !== undefined) return { value: cached, hit: true };
    } catch {
      // 캐시 장애 → 캐시 없이 진행 (fail-open)
    }

    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return { value: await pending, hit: false };
    }

    const promise = (async () => {
      const value = await loader();
      if (value !== undefined) {
        const seconds = typeof ttl === 'function' ? ttl(value) : ttl;
        try {
          await this.set(key, value, { ttl: seconds, tags });
        } catch {
          // 저장 실패는 응답에 영향 없음
        }
      }
      return value;
    })();
    this.#inflight.set(key, promise);
    try {
      return { value: await promise, hit: false };
    } finally {
      this.#inflight.delete(key);
    }
  }
}
