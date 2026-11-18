/**
 * 해시 테이블 (Separate Chaining 방식)
 *
 * 설계 원리
 * ---------
 * 1. 해시 함수: FNV-1a (32bit). 문자열 → 32bit 정수. 빠르고 분포가 고르다.
 * 2. 버킷 배열: 길이는 항상 2의 거듭제곱 → `hash & (capacity - 1)` 로 나머지 연산 없이 인덱스 계산.
 * 3. 충돌 해결: 같은 버킷에 들어온 키들은 단일 연결 리스트(체이닝)로 연결.
 * 4. 리사이즈: 적재율(size / capacity)이 0.75 를 넘으면 2배로 확장, 0.125 미만이면 절반으로 축소.
 *    체인이 길어지지 않게 유지해서 평균 O(1) 을 보장한다.
 * 5. scan(cursor, count): 만료 키 청소(active expiration)용 증분 순회.
 *    한 번에 전체를 훑지 않고 일부 버킷만 훑어 이벤트 루프를 오래 막지 않는다.
 *
 * 복잡도: get / set / delete 평균 O(1), 최악 O(n) (모든 키가 한 버킷에 충돌할 때)
 */

export const INITIAL_CAPACITY = 16;
export const MAX_LOAD_FACTOR = 0.75;
export const MIN_LOAD_FACTOR = 0.125;

/** FNV-1a 32bit 해시 */
export function fnv1a(str) {
  let h = 0x811c9dc5; // offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime, 32bit 곱셈 (오버플로 허용)
  }
  return h >>> 0; // unsigned 로 변환
}

/** 체인의 노드 */
class Node {
  constructor(key, value, next) {
    this.key = key;
    this.value = value;
    this.next = next;
  }
}

export class HashTable {
  #buckets;
  #capacity;
  #size = 0;
  #hash;

  /**
   * @param {{ initialCapacity?: number, hash?: (key: string) => number }} [options]
   *   hash 를 주입할 수 있게 해 두어 충돌 상황을 테스트에서 강제로 만들 수 있다.
   */
  constructor({ initialCapacity = INITIAL_CAPACITY, hash = fnv1a } = {}) {
    this.#hash = hash;
    this.#capacity = nextPowerOfTwo(Math.max(initialCapacity, 4));
    this.#buckets = new Array(this.#capacity).fill(null);
  }

  get size() {
    return this.#size;
  }

  get capacity() {
    return this.#capacity;
  }

  #index(key, capacity = this.#capacity) {
    return (this.#hash(key) >>> 0) & (capacity - 1);
  }

  /** 키가 없으면 undefined. (값으로 undefined 를 저장하지 않는다는 전제) */
  get(key) {
    let node = this.#buckets[this.#index(key)];
    while (node !== null) {
      if (node.key === key) return node.value;
      node = node.next;
    }
    return undefined;
  }

  has(key) {
    let node = this.#buckets[this.#index(key)];
    while (node !== null) {
      if (node.key === key) return true;
      node = node.next;
    }
    return false;
  }

  /** @returns {boolean} 새 키면 true, 기존 키 덮어쓰기면 false */
  set(key, value) {
    const idx = this.#index(key);
    let node = this.#buckets[idx];
    while (node !== null) {
      if (node.key === key) {
        node.value = value;
        return false;
      }
      node = node.next;
    }
    // 체인 맨 앞에 삽입 → O(1)
    this.#buckets[idx] = new Node(key, value, this.#buckets[idx]);
    this.#size++;
    if (this.#size / this.#capacity > MAX_LOAD_FACTOR) {
      this.#resize(this.#capacity * 2);
    }
    return true;
  }

  /** @returns {boolean} 삭제했으면 true */
  delete(key) {
    const idx = this.#index(key);
    let prev = null;
    let node = this.#buckets[idx];
    while (node !== null) {
      if (node.key === key) {
        if (prev === null) this.#buckets[idx] = node.next;
        else prev.next = node.next;
        this.#size--;
        if (
          this.#capacity > INITIAL_CAPACITY &&
          this.#size / this.#capacity < MIN_LOAD_FACTOR
        ) {
          this.#resize(this.#capacity / 2);
        }
        return true;
      }
      prev = node;
      node = node.next;
    }
    return false;
  }

  clear() {
    this.#capacity = INITIAL_CAPACITY;
    this.#buckets = new Array(this.#capacity).fill(null);
    this.#size = 0;
  }

  /** 모든 노드를 새 버킷 배열로 재배치(rehash). O(n) */
  #resize(newCapacity) {
    const newBuckets = new Array(newCapacity).fill(null);
    for (let i = 0; i < this.#capacity; i++) {
      let node = this.#buckets[i];
      while (node !== null) {
        const next = node.next;
        const idx = this.#index(node.key, newCapacity);
        node.next = newBuckets[idx];
        newBuckets[idx] = node;
        node = next;
      }
    }
    this.#buckets = newBuckets;
    this.#capacity = newCapacity;
  }

  /**
   * 증분 순회 (Redis SCAN 과 같은 "역순 이진 증가 커서").
   *
   * 커서를 1씩 올리는 대신 "비트를 뒤집은 값"을 1 올린다. 용량이 16 이면 방문 순서는
   * 0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15 (버킷 번호의 상위 비트부터 증가).
   *
   * 이렇게 하면 순회 도중 테이블이 커지거나 줄어도 안전하다.
   *   - 확장: 옛 버킷 i 의 키는 새 테이블에서 i 또는 i+옛용량 으로 갈라진다. 역순 증가는
   *           "하위 비트를 먼저 고정"하므로, 옛 버킷을 이미 방문했다면 갈라진 두 버킷도 연달아 방문하게 된다.
   *   - 축소: 합쳐진 버킷을 다시 방문할 수는 있지만(중복) 놓치지는 않는다.
   * → 순회 시작부터 끝까지 계속 존재한 키는 **최소 한 번** 반환된다. (리사이즈가 있었다면 중복 가능)
   *   순회 중에 추가/삭제된 키는 반환될 수도, 아닐 수도 있다.
   *
   * 커서는 "마스크하지 않은 값"을 그대로 돌려주고, 다음 호출 때의 현재 용량으로 마스크한다.
   * 끝까지 돌았으면 cursor 는 0 으로 되돌아온다. 최소 count 개를 모을 때까지(버킷 단위) 진행한다.
   * @returns {{ cursor: number, entries: Array<[string, any]> }}
   */
  scan(cursor, count) {
    const entries = [];
    const mask = this.#capacity - 1;
    let v = cursor >>> 0;
    do {
      let node = this.#buckets[v & mask];
      while (node !== null) {
        entries.push([node.key, node.value]);
        node = node.next;
      }
      // 마스크 바깥 비트를 모두 1 로 → 비트 뒤집기 → +1 → 다시 뒤집기
      v = reverseBits32(((v | ~mask) >>> 0)) + 1;
      v = reverseBits32(v >>> 0);
    } while (v !== 0 && entries.length < count);
    return { cursor: v, entries };
  }

  *keys() {
    for (let i = 0; i < this.#capacity; i++) {
      let node = this.#buckets[i];
      while (node !== null) {
        yield node.key;
        node = node.next;
      }
    }
  }

  *entries() {
    for (let i = 0; i < this.#capacity; i++) {
      let node = this.#buckets[i];
      while (node !== null) {
        yield [node.key, node.value];
        node = node.next;
      }
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  /** 해시 분포 진단용 */
  stats() {
    let usedBuckets = 0;
    let longestChain = 0;
    for (let i = 0; i < this.#capacity; i++) {
      let len = 0;
      let node = this.#buckets[i];
      while (node !== null) {
        len++;
        node = node.next;
      }
      if (len > 0) usedBuckets++;
      if (len > longestChain) longestChain = len;
    }
    return {
      size: this.#size,
      capacity: this.#capacity,
      loadFactor: this.#size / this.#capacity,
      usedBuckets,
      longestChain,
    };
  }
}

/** 32bit 정수의 비트 순서를 뒤집는다. (최상위 비트 ↔ 최하위 비트) */
function reverseBits32(x) {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
