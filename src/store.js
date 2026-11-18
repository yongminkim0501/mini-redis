/**
 * MiniRedis 저장소 코어.
 *
 * 동시성 모델
 * -----------
 * Redis 와 마찬가지로 "모든 명령은 단일 스레드에서 순서대로, 원자적으로" 실행된다.
 * 이 클래스의 모든 public 메서드는 동기(sync) 함수이고 await 지점이 없으므로,
 * Node.js 이벤트 루프 상에서 한 명령이 끝나기 전에 다른 명령이 끼어들 수 없다.
 * 즉 락(mutex) 없이도 read-modify-write(INCR, SET NX 등)가 안전하다.
 * 네트워크 I/O 는 서버 레이어(server.js)가 비동기로 받고, 파싱이 끝난 명령만 이 코어에 동기 호출한다.
 *
 * 만료(TTL) 처리 = 두 가지 전략을 함께 사용 (Redis 와 동일)
 * ---------------------------------------------------
 * 1. Lazy expiration  : 키에 접근할 때 만료 시각이 지났으면 그 자리에서 삭제하고 "없음"으로 응답.
 *                       → 만료된 값이 절대 응답으로 나가지 않는다.
 * 2. Active expiration: 주기적으로 해시 테이블 일부를 scan 해서 만료 키를 지운다.
 *                       → 아무도 다시 읽지 않는 키가 메모리를 영원히 차지하는 것을 방지.
 *
 * 무효화(invalidate)
 * -----------------
 * DEL 은 "키 하나를 지우는" 것이고, invalidate 는 "원본 데이터가 바뀌어 더는 믿을 수 없게 된 캐시를
 * 한 번에 폐기하는" 것이다. key / prefix / tag / 전체 단위를 지원한다.
 * 태그는 set 할 때 붙이고, 태그 → 키 집합의 보조 인덱스로 O(해당 키 수) 에 무효화한다.
 */
import { HashTable } from './hashtable.js';
import { Aof } from './aof.js';
import { MiniRedisError, InvalidArgumentError, WrongTypeError, StoreFullError } from './errors.js';

export const DEFAULT_MAX_BATCH = 1000; // mget / mset / transaction 한 번에 처리할 수 있는 최대 개수
export const MAX_SCAN_COUNT = 10_000;
export const MAX_KEY_LENGTH = 512;
export const MAX_TAGS = 32;
export const MAX_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000; // 100년

const TTL_MISSING = -2;
const TTL_NO_EXPIRY = -1;

/** 배치/트랜잭션 안의 i 번째 항목에서 난 입력 오류에 위치를 붙여서 다시 던진다. */
function indexed(err, name, i) {
  if (err instanceof InvalidArgumentError) {
    return new InvalidArgumentError(`${name}[${i}]: ${err.message}`);
  }
  return err;
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidArgumentError('key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidArgumentError(`key is too long (max ${MAX_KEY_LENGTH} chars)`);
  }
}

/** JSON 으로 직렬화 가능한 값만 허용하고, 호출자의 객체와 분리된 사본을 저장한다. */
function normalizeValue(value) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new InvalidArgumentError('value must be a finite number');
      return value;
    case 'object': {
      if (value === null) return null;
      let json;
      try {
        json = JSON.stringify(value);
      } catch (err) {
        throw new InvalidArgumentError(`value is not JSON-serializable: ${err.message}`);
      }
      return JSON.parse(json);
    }
    default: // undefined, function, symbol, bigint
      throw new InvalidArgumentError(`value of type ${typeof value} is not supported`);
  }
}

function cloneOut(value) {
  return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

function validateTtlMs(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new InvalidArgumentError('ttl must be a positive number');
  }
  if (ttlMs > MAX_TTL_MS) throw new InvalidArgumentError('ttl is too large');
  return Math.ceil(ttlMs);
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) throw new InvalidArgumentError('tags must be an array of strings');
  if (tags.length > MAX_TAGS) throw new InvalidArgumentError(`too many tags (max ${MAX_TAGS})`);
  for (const t of tags) {
    if (typeof t !== 'string' || t.length === 0 || t.length > MAX_KEY_LENGTH) {
      throw new InvalidArgumentError('each tag must be a non-empty string');
    }
  }
  const unique = [...new Set(tags)];
  return unique.length > 0 ? unique : null;
}

/** AOF 복구용 검증: 예외를 던지지 않고 boolean 만 반환한다. */
function isValidRecordKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LENGTH;
}

function isValidRecordTags(t) {
  return (
    Array.isArray(t) &&
    t.length <= MAX_TAGS &&
    t.every((tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_KEY_LENGTH)
  );
}

/**
 * AOF 레코드 하나가 형식에 맞는지 검사한다 (적용은 하지 않음).
 * 트랜잭션(t) 은 안에 든 레코드까지 전부 검사한다 — 복구할 때도 "통째로 적용 or 통째로 무시" 를 지키기 위해
 * 적용하기 전에 먼저 검증해야 한다. 트랜잭션 안에 트랜잭션은 쓰지 않으므로 중첩은 잘못된 것으로 본다.
 */
function isValidRecord(rec, { inTx = false } = {}) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.o !== 'string') return false;
  switch (rec.o) {
    case 'p': {
      if (!isValidRecordKey(rec.k) || rec.v === undefined) return false;
      const e = rec.e ?? null;
      if (e !== null && !Number.isFinite(e)) return false;
      const t = rec.t ?? null;
      return t === null || isValidRecordTags(t);
    }
    case 'd':
      return isValidRecordKey(rec.k);
    case 't':
      return !inTx && Array.isArray(rec.r) && rec.r.every((inner) => isValidRecord(inner, { inTx: true }));
    default:
      return true; // 'f' 와 알 수 없는 레코드(상위 버전 호환)
  }
}

export class MiniRedis {
  #table = new HashTable();
  #tagIndex = new Map(); // tag -> Set<key>
  #now;
  #maxKeys;
  #lru = false;
  #lruHead = null; // 가장 최근에 쓴 엔트리
  #lruTail = null; // 가장 오래 안 쓴 엔트리 = 축출 대상
  #maxBatch;
  #txBuf = null; // 배치/트랜잭션 실행 중에 모아 두는 AOF 레코드 (끝나면 한 줄로 기록)
  #aof = null;
  #aofLines = 0;
  #aofRewriteMinLines;
  #sweepTimer = null;
  #sweepBatch;
  #sweepCursor = 0;
  #lastFullSweep = 0;
  #startedAt;
  #closed = false;
  #stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    expiredLazy: 0,
    expiredActive: 0,
    invalidated: 0,
    evicted: 0,
    transactions: 0,
  };
  loadInfo = null;

  /**
   * @param {object} [options]
   * @param {() => number} [options.now]            현재 시각(ms). 테스트에서 가짜 시계를 주입.
   * @param {string} [options.aofPath]              지정하면 AOF 영속성 활성화.
   * @param {'always'|'everysec'|'no'} [options.fsync]
   * @param {number} [options.sweepIntervalMs]      active expiration 주기. 0 이면 끔.
   * @param {number} [options.sweepBatch]           한 번의 sweep 에서 검사할 엔트리 수.
   * @param {number} [options.maxKeys]              저장 가능한 최대 키 수.
   * @param {'noeviction'|'lru'} [options.evictionPolicy]
   *   maxKeys 가 가득 찼을 때: noeviction(기본) = StoreFullError / lru = 가장 오래 안 쓴 키를 축출.
   * @param {number} [options.aofRewriteMinLines]   이 줄 수를 넘고 살아있는 키의 2배를 넘으면 자동 compaction.
   * @param {number} [options.maxBatch]             mget / mset / transaction 한 번에 허용하는 최대 개수.
   *   한 번에 너무 많이 실행하면 그동안 다른 요청이 모두 대기하므로(단일 스레드) 상한을 둔다.
   */
  constructor({
    now = Date.now,
    aofPath,
    fsync = 'everysec',
    sweepIntervalMs = 1000,
    sweepBatch = 200,
    maxKeys = Infinity,
    evictionPolicy = 'noeviction',
    aofRewriteMinLines = 10_000,
    maxBatch = DEFAULT_MAX_BATCH,
  } = {}) {
    if (!Number.isInteger(maxBatch) || maxBatch < 1) {
      throw new InvalidArgumentError('maxBatch must be a positive integer');
    }
    if (!['noeviction', 'lru'].includes(evictionPolicy)) {
      throw new InvalidArgumentError(`invalid evictionPolicy: ${evictionPolicy} (expected noeviction|lru)`);
    }
    if (maxKeys !== Infinity && !(Number.isInteger(maxKeys) && maxKeys >= 1)) {
      throw new InvalidArgumentError('maxKeys must be a positive integer');
    }
    if (evictionPolicy === 'lru' && maxKeys === Infinity) {
      throw new InvalidArgumentError("evictionPolicy 'lru' requires maxKeys");
    }
    this.#now = now;
    this.#maxKeys = maxKeys;
    this.#lru = evictionPolicy === 'lru';
    this.#maxBatch = maxBatch;
    this.#sweepBatch = sweepBatch;
    this.#aofRewriteMinLines = aofRewriteMinLines;
    this.#startedAt = now();

    if (aofPath) {
      this.#aof = new Aof(aofPath, { fsync });
      this.loadInfo = this.#aof.load((rec) => this.#replay(rec));
      this.#aofLines = this.loadInfo.records;
      this.#evictToFit(this.#maxKeys); // maxKeys 를 줄여서 재시작한 경우
      this.#maybeCompact();
    }

    if (sweepIntervalMs > 0) {
      this.#sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.#sweepTimer.unref(); // 이 타이머 때문에 프로세스가 종료되지 못하는 일이 없도록
    }
  }

  // ───────────────────────── 내부 헬퍼 ─────────────────────────

  #isExpired(entry, now) {
    return entry.expiresAt !== null && entry.expiresAt <= now;
  }

  /** 살아있는 엔트리만 반환. 만료됐다면 지금 삭제(lazy expiration). */
  #live(key) {
    const entry = this.#table.get(key);
    if (entry === undefined) return undefined;
    if (this.#isExpired(entry, this.#now())) {
      this.#remove(key, entry);
      this.#stats.expiredLazy++;
      return undefined;
    }
    this.#lruTouch(entry); // 접근 = 최근 사용
    return entry;
  }

  #remove(key, entry) {
    this.#table.delete(key);
    this.#unindexTags(key, entry.tags);
    this.#lruUnlink(entry);
  }

  // ── LRU: 해시 테이블(키 → 엔트리)과 이중 연결 리스트(사용 순서)를 함께 쓴다.
  //    찾기는 해시 테이블로 O(1), 순서 갱신/제거는 리스트 포인터 조작으로 O(1).
  //    head = 최근, tail = 가장 오래됨. (noeviction 이면 아래 함수들은 아무 일도 하지 않는다)

  #lruLink(entry) {
    if (!this.#lru) return;
    entry.prev = null;
    entry.next = this.#lruHead;
    if (this.#lruHead !== null) this.#lruHead.prev = entry;
    this.#lruHead = entry;
    if (this.#lruTail === null) this.#lruTail = entry;
  }

  #lruUnlink(entry) {
    if (!this.#lru) return;
    if (entry.prev !== null) entry.prev.next = entry.next;
    else this.#lruHead = entry.next;
    if (entry.next !== null) entry.next.prev = entry.prev;
    else this.#lruTail = entry.prev;
    entry.prev = null;
    entry.next = null;
  }

  #lruTouch(entry) {
    if (!this.#lru || this.#lruHead === entry) return;
    this.#lruUnlink(entry);
    this.#lruLink(entry);
  }

  #lruReset() {
    this.#lruHead = null;
    this.#lruTail = null;
  }

  /** 가장 오래 안 쓴 엔트리 하나를 축출. AOF 에는 삭제로 기록해 재시작 후 되살아나지 않게 한다. */
  #evictOne() {
    const victim = this.#lruTail;
    if (victim === null) return false;
    this.#remove(victim.key, victim);
    this.#log({ o: 'd', k: victim.key });
    this.#stats.evicted++;
    return true;
  }

  #evictToFit(limit) {
    if (!this.#lru) return;
    while (this.#table.size > limit && this.#evictOne());
  }

  #indexTags(key, tags) {
    if (tags === null) return;
    for (const tag of tags) {
      let keys = this.#tagIndex.get(tag);
      if (keys === undefined) {
        keys = new Set();
        this.#tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  #unindexTags(key, tags) {
    if (tags === null) return;
    for (const tag of tags) {
      const keys = this.#tagIndex.get(tag);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) this.#tagIndex.delete(tag);
    }
  }

  /** 엔트리를 저장(덮어쓰기 포함)하고 AOF 에 기록. */
  #put(key, entry, { log = true } = {}) {
    const old = this.#table.get(key);
    if (old !== undefined) {
      this.#unindexTags(key, old.tags);
      this.#lruUnlink(old);
    }
    if (this.#lru) entry.key = key; // 축출 시 테이블에서 지우려면 키가 필요
    this.#table.set(key, entry);
    this.#indexTags(key, entry.tags);
    this.#lruLink(entry);
    if (log) this.#log({ o: 'p', k: key, v: entry.value, e: entry.expiresAt, t: entry.tags });
  }

  #log(record) {
    if (this.#aof === null) return;
    if (this.#txBuf !== null) {
      this.#txBuf.push(record); // 배치/트랜잭션 중: 모아 뒀다가 끝나면 한 번에 기록
      return;
    }
    this.#appendLog(record);
  }

  #appendLog(record) {
    this.#aof.append(record);
    this.#aofLines++;
    this.#maybeCompact();
  }

  /**
   * fn 이 만드는 모든 AOF 레코드를 {"o":"t","r":[…]} **한 줄**로 묶어 기록한다.
   * 한 줄은 "온전히 기록됐거나, 쓰다 만 줄(복구 때 통째로 버려짐)" 둘 중 하나이므로
   * 크래시가 나도 트랜잭션이 절반만 복구되는 일이 없다.
   */
  #batch(fn) {
    this.#txBuf = [];
    try {
      return fn();
    } finally {
      const buf = this.#txBuf;
      this.#txBuf = null;
      if (buf.length > 0) this.#appendLog(buf.length === 1 ? buf[0] : { o: 't', r: buf });
    }
  }

  #maybeCompact() {
    if (
      this.#aof !== null &&
      this.#aofLines > this.#aofRewriteMinLines &&
      this.#aofLines > 2 * this.#table.size
    ) {
      this.compact();
    }
  }

  /**
   * AOF 레코드 하나를 메모리에 적용한다.
   * JSON 으로는 올바르지만 필드가 잘못된 레코드(수동 편집, 디스크 손상 등)는 적용하지 않고 false 를 반환한다.
   * → Aof.load 가 skipped 로 세고, 서버는 죽지 않으며 내부 상태(태그 인덱스 등)도 오염되지 않는다.
   * 트랜잭션(t) 은 안에 든 레코드가 하나라도 잘못이면 아무것도 적용하지 않는다 (반쪽 복구 방지).
   * @returns {boolean} 적용(또는 알 수 없는 레코드라 무시)했으면 true, 잘못된 레코드라 건너뛰었으면 false
   */
  #replay(rec) {
    if (!isValidRecord(rec)) return false;
    this.#applyRecord(rec);
    return true;
  }

  /** 검증을 통과한 레코드를 적용한다. */
  #applyRecord(rec) {
    switch (rec.o) {
      case 'p': {
        const e = rec.e ?? null;
        const tags = rec.t ?? null;
        if (e !== null && e <= this.#now()) {
          // 서버가 꺼진 사이 만료된 키 → 복원하지 않는다. (이전 값이 있었다면 그것도 지운다)
          const old = this.#table.get(rec.k);
          if (old !== undefined) this.#remove(rec.k, old);
          return;
        }
        this.#put(
          rec.k,
          { value: rec.v, expiresAt: e, tags: tags === null || tags.length === 0 ? null : [...new Set(tags)] },
          { log: false },
        );
        return;
      }
      case 'd': {
        const old = this.#table.get(rec.k);
        if (old !== undefined) this.#remove(rec.k, old);
        return;
      }
      case 'f':
        this.#table.clear();
        this.#tagIndex.clear();
        this.#lruReset();
        return;
      case 't': // 트랜잭션/배치: 이미 전부 검증됐으므로 안에 든 레코드를 순서대로 적용
        for (const inner of rec.r) this.#applyRecord(inner);
        return;
      default:
      // 알 수 없는 레코드는 무시 (상위 버전 호환)
    }
  }

  #ensureCapacity() {
    if (this.#table.size < this.#maxKeys) return;
    this.#sweepIfDue();
    // 만료 키를 정리해도 여전히 가득 차 있다면: lru 는 가장 오래 안 쓴 키를 버리고, noeviction 은 거부.
    this.#evictToFit(this.#maxKeys - 1);
    if (this.#table.size >= this.#maxKeys) {
      throw new StoreFullError(`store is full (maxKeys=${this.#maxKeys})`);
    }
  }

  /** 가득 찼을 때 만료 키부터 정리해 본다 (최대 초당 1회 — 가득 찬 상태로 요청이 몰려도 연속 O(n) 방지). */
  #sweepIfDue() {
    const now = this.#now();
    if (now - this.#lastFullSweep >= 1000) {
      this.#lastFullSweep = now;
      this.#sweepAll();
    }
  }

  #sweepAll() {
    const now = this.#now();
    for (const [key, entry] of [...this.#table]) {
      if (this.#isExpired(entry, now)) {
        this.#remove(key, entry);
        this.#stats.expiredActive++;
      }
    }
  }

  // ───────────────────────── 기본 명령 ─────────────────────────

  /**
   * @param {string} key
   * @param {*} value JSON 직렬화 가능한 값
   * @param {{ ttlMs?: number, tags?: string[], nx?: boolean, xx?: boolean }} [opts]
   *   nx: 키가 없을 때만 저장 / xx: 키가 있을 때만 저장
   * @returns {boolean} 저장했으면 true
   */
  set(key, value, opts = {}) {
    this.#assertOpen();
    return this.#applySet(this.#prepareSet(key, value, opts));
  }

  /** 1단계: 입력 검증·정규화만 한다 (저장소를 건드리지 않음). 배치/트랜잭션이 "전부 검증한 뒤 실행"하는 데 쓴다. */
  #prepareSet(key, value, opts) {
    const { ttlMs, tags, nx = false, xx = false } = opts;
    validateKey(key);
    if (typeof nx !== 'boolean' || typeof xx !== 'boolean') {
      throw new InvalidArgumentError('nx and xx must be booleans');
    }
    if (nx && xx) throw new InvalidArgumentError('nx and xx cannot be used together');
    return {
      key,
      value: normalizeValue(value),
      ttl: ttlMs === undefined ? null : validateTtlMs(ttlMs),
      tags: normalizeTags(tags),
      nx,
      xx,
    };
  }

  /** 2단계: 검증된 입력을 저장소에 반영한다. */
  #applySet(p) {
    const existing = this.#live(p.key);
    if (p.nx && existing !== undefined) return false;
    if (p.xx && existing === undefined) return false;
    if (existing === undefined) this.#ensureCapacity();

    const expiresAt = p.ttl === null ? null : this.#now() + p.ttl;
    this.#put(p.key, { value: p.value, expiresAt, tags: p.tags });
    this.#stats.sets++;
    return true;
  }

  /** @returns {{ value: *, ttlMs: number|null } | undefined} 없거나 만료됐으면 undefined */
  inspect(key) {
    this.#assertOpen();
    validateKey(key);
    const entry = this.#live(key);
    if (entry === undefined) {
      this.#stats.misses++;
      return undefined;
    }
    this.#stats.hits++;
    return {
      value: cloneOut(entry.value),
      ttlMs: entry.expiresAt === null ? null : Math.max(0, entry.expiresAt - this.#now()),
    };
  }

  /** @returns {*} 값. 없거나 만료됐으면 undefined (저장된 null 과 구분됨) */
  get(key) {
    return this.inspect(key)?.value;
  }

  exists(key) {
    this.#assertOpen();
    validateKey(key);
    return this.#live(key) !== undefined;
  }

  /** @returns {boolean} 지웠으면 true */
  del(key) {
    this.#assertOpen();
    validateKey(key);
    const entry = this.#live(key);
    if (entry === undefined) return false;
    this.#remove(key, entry);
    this.#log({ o: 'd', k: key });
    this.#stats.deletes++;
    return true;
  }

  /** @returns {number} 남은 ms. 키가 없으면 -2, 만료 설정이 없으면 -1 */
  ttl(key) {
    this.#assertOpen();
    validateKey(key);
    const entry = this.#live(key);
    if (entry === undefined) return TTL_MISSING;
    if (entry.expiresAt === null) return TTL_NO_EXPIRY;
    return Math.max(0, entry.expiresAt - this.#now());
  }

  /** 기존 키에 TTL 설정. @returns {boolean} 키가 있어서 설정됐으면 true */
  expire(key, ttlMs) {
    this.#assertOpen();
    validateKey(key);
    const ms = validateTtlMs(ttlMs);
    const entry = this.#live(key);
    if (entry === undefined) return false;
    entry.expiresAt = this.#now() + ms;
    this.#log({ o: 'p', k: key, v: entry.value, e: entry.expiresAt, t: entry.tags });
    return true;
  }

  /** TTL 제거. @returns {boolean} 만료 설정이 있었으면 true */
  persist(key) {
    this.#assertOpen();
    validateKey(key);
    const entry = this.#live(key);
    if (entry === undefined || entry.expiresAt === null) return false;
    entry.expiresAt = null;
    this.#log({ o: 'p', k: key, v: entry.value, e: null, t: entry.tags });
    return true;
  }

  /** 원자적 증가. 키가 없으면 0 에서 시작. TTL 은 유지. */
  incr(key, by = 1) {
    this.#assertOpen();
    validateKey(key);
    if (!Number.isSafeInteger(by)) throw new InvalidArgumentError('increment must be a safe integer');
    const entry = this.#live(key);
    if (entry === undefined) {
      this.#ensureCapacity();
      this.#put(key, { value: by, expiresAt: null, tags: null });
      this.#stats.sets++;
      return by;
    }
    if (!Number.isSafeInteger(entry.value)) {
      throw new WrongTypeError('value is not an integer');
    }
    const next = entry.value + by;
    if (!Number.isSafeInteger(next)) throw new WrongTypeError('increment would overflow');
    entry.value = next;
    this.#log({ o: 'p', k: key, v: next, e: entry.expiresAt, t: entry.tags });
    return next;
  }

  /** 살아있는 키 목록 (prefix 필터). 전체 순회 O(n) 이므로 운영 용도보다는 디버깅/관리용. */
  keys({ prefix = '', limit = 1000 } = {}) {
    this.#assertOpen();
    const now = this.#now();
    const result = [];
    for (const [key, entry] of [...this.#table]) {
      if (this.#isExpired(entry, now)) {
        this.#remove(key, entry);
        this.#stats.expiredLazy++;
        continue;
      }
      if (key.startsWith(prefix)) {
        result.push(key);
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  // ───────────────────────── 배치 / SCAN / 트랜잭션 ─────────────────────────

  #checkBatch(list, name) {
    if (!Array.isArray(list)) throw new InvalidArgumentError(`${name} must be an array`);
    if (list.length > this.#maxBatch) {
      throw new InvalidArgumentError(`too many ${name} (max ${this.#maxBatch} per request)`);
    }
  }

  /**
   * 여러 키를 한 번에 읽는다. 전부 한 번의 동기 실행이므로 **서로 일관된 스냅샷**이다
   * (읽는 도중에 다른 요청이 값을 바꿀 수 없다).
   * 하나라도 잘못된 키가 있으면 아무것도 읽지 않고 에러.
   * @returns {Array<{ value: *, ttlMs: number|null } | undefined>} keys 와 같은 순서. 없거나 만료면 undefined
   */
  mget(keys) {
    this.#assertOpen();
    this.#checkBatch(keys, 'keys');
    for (const [i, key] of keys.entries()) {
      try {
        validateKey(key);
      } catch (err) {
        throw indexed(err, 'keys', i);
      }
    }
    return keys.map((key) => this.inspect(key));
  }

  /**
   * 여러 키를 한 번에 저장한다. **전부 저장되거나 전부 거부된다.**
   *   1. 모든 항목을 먼저 검증 (하나라도 잘못이면 아무것도 저장하지 않음)
   *   2. 공간이 모자라면(noeviction) 아무것도 저장하지 않고 StoreFullError
   *   3. 한 번의 동기 실행으로 전부 반영 → 중간 상태를 다른 요청이 볼 수 없다
   *   4. AOF 에는 한 줄로 기록 → 크래시가 나도 일부만 복구되지 않는다
   * 같은 키가 여러 번 나오면 뒤의 것이 이긴다.
   * @param {Array<{ key: string, value: *, ttlMs?: number, tags?: string[] }>} entries
   * @returns {number} 저장한 항목 수
   */
  mset(entries) {
    this.#assertOpen();
    this.#checkBatch(entries, 'entries');
    const prepared = entries.map((entry, i) => {
      try {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new InvalidArgumentError('entry must be an object');
        }
        if (entry.nx !== undefined || entry.xx !== undefined) {
          throw new InvalidArgumentError('nx/xx are not supported in mset (use a transaction)');
        }
        return this.#prepareSet(entry.key, entry.value, entry);
      } catch (err) {
        throw indexed(err, 'entries', i);
      }
    });
    this.#reserveFor(prepared.map((p) => p.key));
    this.#batch(() => {
      for (const p of prepared) this.#applySet(p);
    });
    return prepared.length;
  }

  /** mset 이 시작하기 전에 공간을 확인해서, 중간에 StoreFullError 로 일부만 저장되는 일을 막는다. */
  #reserveFor(keys) {
    if (this.#maxKeys === Infinity) return;
    const distinct = new Set(keys);
    if (distinct.size > this.#maxKeys) {
      throw new StoreFullError(`batch has ${distinct.size} distinct keys but maxKeys=${this.#maxKeys}`);
    }
    if (this.#lru) return; // lru 는 필요한 만큼 오래된 키를 축출하면 되므로 항상 들어간다
    const countFresh = () => {
      let n = 0;
      for (const key of distinct) if (this.#live(key) === undefined) n++;
      return n;
    };
    let fresh = countFresh();
    if (this.#table.size + fresh > this.#maxKeys) {
      this.#sweepIfDue(); // 만료 키를 치우면 들어갈 수도 있다
      fresh = countFresh();
    }
    if (this.#table.size + fresh > this.#maxKeys) {
      throw new StoreFullError(`store is full (maxKeys=${this.#maxKeys})`);
    }
  }

  /**
   * 커서 기반 키 순회 (Redis SCAN). `keys()` 와 달리 한 번에 조금씩만 훑으므로
   * 키가 아무리 많아도 그동안 다른 요청을 오래 막지 않는다. cursor 0 으로 시작해서
   * 돌려받은 cursor 가 다시 0 이 되면 끝.
   *
   * 보장: 순회를 시작해서 끝낼 때까지 계속 존재한 키는 **최소 한 번** 나온다.
   *       (중간에 테이블이 리사이즈되면 같은 키가 두 번 나올 수 있다)
   * 주의: count 는 "한 번에 검사할 엔트리 수"이지 "반환 개수"가 아니다. prefix 로 걸러지면
   *       한 페이지가 비어 있어도 cursor 가 0 이 아니면 계속 호출해야 한다.
   * @returns {{ cursor: number, keys: string[] }}
   */
  scan(cursor = 0, { count = 100, prefix = '' } = {}) {
    this.#assertOpen();
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > 0xffffffff) {
      throw new InvalidArgumentError('cursor must be an integer between 0 and 4294967295');
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_SCAN_COUNT) {
      throw new InvalidArgumentError(`count must be an integer between 1 and ${MAX_SCAN_COUNT}`);
    }
    if (typeof prefix !== 'string') throw new InvalidArgumentError('prefix must be a string');

    const { cursor: next, entries } = this.#table.scan(cursor, count);
    const now = this.#now();
    const keys = [];
    for (const [key, entry] of entries) {
      if (this.#isExpired(entry, now)) {
        this.#remove(key, entry); // 순회하다 만난 만료 키는 그 자리에서 정리 (entries 는 스냅샷이라 안전)
        this.#stats.expiredLazy++;
        continue;
      }
      if (key.startsWith(prefix)) keys.push(key);
    }
    return { cursor: next, keys };
  }

  /**
   * 트랜잭션: 여러 명령을 **끼어들기 없이 연달아** 실행한다 (Redis 의 MULTI/EXEC).
   *
   * 동작 규칙 (Redis 와 동일한 모델)
   *   - 격리(isolation): 전부 한 번의 동기 실행이므로 다른 요청이 중간에 끼어들 수 없다.
   *   - 사전 검증: 명령 하나라도 형식이 잘못이면(모르는 cmd, 잘못된 key/ttl 등) **아무것도 실행하지 않고** 에러.
   *   - 실행 중 오류(WRONG_TYPE, STORE_FULL 등)는 **롤백하지 않는다.** 그 명령만 실패로 기록하고 나머지는 계속 실행.
   *     (실행 시점의 값에 따라 달라지는 오류는 미리 알 수 없기 때문. Redis 도 롤백하지 않는다.)
   *   - AOF: 결과적으로 반영된 변경 전체를 한 줄로 기록 → 크래시 시 통째로 복구되거나 통째로 버려진다.
   *
   * 명령: set / get / del / exists / incr / ttl / expire / persist / invalidate
   *   { cmd: 'set', key, value, ttlMs?, tags?, nx?, xx? }   { cmd: 'incr', key, by? }
   *   { cmd: 'expire', key, ttlMs }   { cmd: 'invalidate', key | prefix | tag | all }   { cmd: 'get', key } …
   * @returns {Array<{ ok: true, ... } | { ok: false, error: { code, message, status } }>} 명령과 같은 순서
   */
  transaction(commands) {
    this.#assertOpen();
    this.#checkBatch(commands, 'commands');
    const prepared = commands.map((command, i) => {
      try {
        return this.#prepareCommand(command);
      } catch (err) {
        throw indexed(err, 'commands', i);
      }
    });
    this.#stats.transactions++;
    return this.#batch(() =>
      prepared.map((p) => {
        try {
          return { ok: true, ...this.#runCommand(p) };
        } catch (err) {
          if (err instanceof MiniRedisError) {
            return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
          }
          throw err; // 예상 못 한 버그는 숨기지 않는다
        }
      }),
    );
  }

  #prepareCommand(c) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new InvalidArgumentError('command must be an object');
    }
    switch (c.cmd) {
      case 'set':
        return { cmd: 'set', set: this.#prepareSet(c.key, c.value, c) };
      case 'get':
      case 'del':
      case 'exists':
      case 'ttl':
      case 'persist':
        validateKey(c.key);
        return { cmd: c.cmd, key: c.key };
      case 'incr': {
        validateKey(c.key);
        const by = c.by ?? 1;
        if (!Number.isSafeInteger(by)) throw new InvalidArgumentError('increment must be a safe integer');
        return { cmd: 'incr', key: c.key, by };
      }
      case 'expire':
        validateKey(c.key);
        return { cmd: 'expire', key: c.key, ttlMs: validateTtlMs(c.ttlMs) };
      case 'invalidate':
        return {
          cmd: 'invalidate',
          criteria: this.#parseCriteria({ key: c.key, prefix: c.prefix, tag: c.tag, all: c.all }),
        };
      default:
        throw new InvalidArgumentError(`unknown command: ${String(c.cmd)}`);
    }
  }

  #runCommand(p) {
    switch (p.cmd) {
      case 'set':
        return { stored: this.#applySet(p.set) };
      case 'get': {
        const found = this.inspect(p.key);
        return found === undefined ? { found: false } : { found: true, value: found.value };
      }
      case 'del':
        return { deleted: this.del(p.key) };
      case 'exists':
        return { exists: this.exists(p.key) };
      case 'incr':
        return { value: this.incr(p.key, p.by) };
      case 'ttl': {
        const ttl = this.ttl(p.key);
        return ttl === TTL_MISSING ? { found: false } : { found: true, ttlMs: ttl === TTL_NO_EXPIRY ? null : ttl };
      }
      case 'expire':
        return { updated: this.expire(p.key, p.ttlMs) };
      case 'persist':
        return { persisted: this.persist(p.key) };
      case 'invalidate':
        return { invalidated: this.#invalidateParsed(p.criteria) };
      default:
        throw new Error(`unreachable: ${p.cmd}`);
    }
  }

  // ───────────────────────── 무효화 ─────────────────────────

  /** 무효화 기준이 "정확히 하나"이고 형식이 맞는지 검증해서 { type, value } 로 돌려준다. */
  #parseCriteria(criteria) {
    if (criteria === null || typeof criteria !== 'object') {
      throw new InvalidArgumentError('invalidate requires one of: key, prefix, tag, all');
    }
    const specified = ['key', 'prefix', 'tag', 'all'].filter((k) => criteria[k] !== undefined);
    if (specified.length !== 1) {
      throw new InvalidArgumentError('invalidate requires exactly one of: key, prefix, tag, all');
    }
    const type = specified[0];
    const value = criteria[type];
    if (type === 'key') validateKey(value);
    else if (type === 'prefix' || type === 'tag') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidArgumentError(`${type} must be a non-empty string`);
      }
    } else if (value !== true) {
      throw new InvalidArgumentError('all must be true');
    }
    return { type, value };
  }

  /**
   * 캐시 무효화. 정확히 하나의 기준을 지정한다.
   *   { key }    키 하나
   *   { prefix } 접두사가 같은 모든 키  (O(n) 전체 순회)
   *   { tag }    태그가 붙은 모든 키    (O(해당 키 수))
   *   { all: true } 전체
   * @returns {number} 무효화된(살아있던) 키 개수
   */
  invalidate(criteria) {
    this.#assertOpen();
    return this.#invalidateParsed(this.#parseCriteria(criteria));
  }

  #invalidateParsed({ type, value }) {
    let count = 0;
    const drop = (key) => {
      const entry = this.#live(key);
      if (entry === undefined) return;
      this.#remove(key, entry);
      this.#log({ o: 'd', k: key });
      count++;
    };

    if (type === 'key') {
      drop(value);
    } else if (type === 'prefix') {
      for (const key of [...this.#table.keys()]) {
        if (key.startsWith(value)) drop(key);
      }
    } else if (type === 'tag') {
      const keys = this.#tagIndex.get(value);
      if (keys !== undefined) for (const key of [...keys]) drop(key);
    } else {
      count = this.#countLive();
      this.#table.clear();
      this.#tagIndex.clear();
      this.#lruReset();
      this.#log({ o: 'f' });
    }
    this.#stats.invalidated += count;
    return count;
  }

  #countLive() {
    const now = this.#now();
    let n = 0;
    for (const [, entry] of this.#table) if (!this.#isExpired(entry, now)) n++;
    return n;
  }

  // ───────────────────────── 만료 청소 / 운영 ─────────────────────────

  /**
   * Active expiration: 테이블을 조금씩 훑어 만료된 키를 지운다.
   * 검사한 키의 25% 넘게 만료되어 있었다면 만료 키가 많다는 뜻이므로 바로 한 번 더 돈다 (최대 5회).
   * @returns {number} 이번 호출에서 지운 키 수
   */
  sweep() {
    if (this.#closed) return 0;
    let removedTotal = 0;
    for (let round = 0; round < 5; round++) {
      const { cursor, entries } = this.#table.scan(this.#sweepCursor, this.#sweepBatch);
      this.#sweepCursor = cursor;
      const now = this.#now();
      let removed = 0;
      for (const [key, entry] of entries) {
        if (this.#isExpired(entry, now)) {
          this.#remove(key, entry);
          this.#stats.expiredActive++;
          removed++;
        }
      }
      removedTotal += removed;
      if (entries.length === 0 || removed / entries.length <= 0.25) break;
    }
    return removedTotal;
  }

  /** AOF 를 살아있는 키만으로 새로 쓴다. */
  compact() {
    if (this.#aof === null) return;
    const now = this.#now();
    const self = this;
    function* records() {
      for (const [key, entry] of self.#table) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
        yield { o: 'p', k: key, v: entry.value, e: entry.expiresAt, t: entry.tags };
      }
    }
    this.#aof.rewrite(records());
    this.#aofLines = this.#countLive();
  }

  /** 버퍼에 남은 AOF 데이터를 디스크에 강제 반영. */
  flushToDisk() {
    this.#aof?.sync();
  }

  get size() {
    return this.#table.size;
  }

  stats() {
    const total = this.#stats.hits + this.#stats.misses;
    return {
      ...this.#stats,
      hitRatio: total === 0 ? null : this.#stats.hits / total,
      keys: this.#table.size,
      tags: this.#tagIndex.size,
      table: this.#table.stats(),
      aof: this.#aof
        ? { enabled: true, path: this.#aof.path, lines: this.#aofLines, load: this.loadInfo }
        : { enabled: false },
      uptimeMs: this.#now() - this.#startedAt,
    };
  }

  #assertOpen() {
    if (this.#closed) throw new Error('store is closed');
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
    this.#aof?.close();
  }
}
