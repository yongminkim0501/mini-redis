# Mini Redis

해시 테이블을 직접 구현해 만든 인메모리 키-값 저장소입니다. HTTP API 로 외부에서 쓸 수 있고, TTL 만료, 캐시 무효화, AOF 영속성을 지원합니다.
**외부 의존성이 없습니다** (Node.js 20+ 내장 모듈만 사용: `node:http`, `node:test`, `fetch`).

```bash
npm test            # 단위 + 기능 테스트 (162개)
npm start           # Mini Redis 서버 (기본 http://127.0.0.1:6380)
npm run demo        # 데모 API(캐시 적용 :4000 / 캐시 없음 :4001) 실행
npm run bench       # 캐시 사용 vs 미사용 성능 비교
npm run bench:batch # 키를 하나씩 vs 배치(mget/mset)로 다룰 때 성능 비교
npm run demo:tx     # 트랜잭션 없이 이체 vs 트랜잭션 이체 (중간 상태가 보이는지)
```

## 1. 구조

```
src/hashtable.js   해시 테이블 (FNV-1a + 체이닝 + 동적 리사이즈 + 증분 scan)   ← 핵심
src/store.js       저장소 코어: 명령(set/get/del/incr…), TTL, 무효화, 통계
src/aof.js         Append-Only File 영속성 (복구 / compaction)
src/server.js      REST API 서버 (node:http)
src/client.js      HTTP 클라이언트 + cache-aside 헬퍼(getOrSet)
bin/server.js      서버 실행 진입점 (환경변수 설정)
examples/          "느린 DB" 앞에 캐시를 붙인 데모 API
bench/             성능 비교 스크립트
test/              단위/기능 테스트
```

```
 외부 클라이언트 ──HTTP/JSON──▶ server.js ──동기 호출──▶ store.js ──▶ hashtable.js
                                                          │
                                                          └─(변경 명령만)─▶ aof.js ─▶ 디스크
```

## 2. 해시 테이블 설계 (`src/hashtable.js`)

| 항목 | 선택 | 이유 |
|---|---|---|
| 해시 함수 | **FNV-1a 32bit** | 구현이 짧고 빠르며 분포가 고르다. `Math.imul` 로 32bit 오버플로 곱셈 |
| 버킷 인덱스 | `hash & (capacity - 1)` | 용량을 항상 **2의 거듭제곱**으로 유지 → 나머지(%) 연산 대신 비트 AND |
| 충돌 해결 | **체이닝** (버킷마다 단일 연결 리스트) | 구현이 단순하고 삭제가 쉽다. 새 노드는 체인 **맨 앞에 삽입 → O(1)** |
| 리사이즈 | 적재율 > 0.75 → **2배 확장**, < 0.125 → **절반 축소** | 체인 길이를 짧게 유지해 평균 O(1) 보장. 확장/축소 임계값 사이에 간격을 둬서 경계에서 왔다 갔다(thrashing)하지 않음 |
| 순회 | `scan(cursor, count)` — **역순 이진 증가 커서** | 만료 청소와 `SCAN` API 가 전체를 한 번에 훑어 서버를 멈추지 않게 **조금씩** 순회. 순회 도중 리사이즈가 일어나도 키를 놓치지 않음 |

### 주요 함수 동작

```
set(key, value)
  1. idx = fnv1a(key) & (capacity-1)
  2. buckets[idx] 체인을 따라가며 같은 key 가 있는지 비교
       있으면 → value 만 교체, return false (덮어쓰기)
  3. 없으면 → 새 Node 를 체인 맨 앞에 삽입, size++
  4. size/capacity > 0.75 이면 resize(capacity*2)
       └ 모든 노드를 새 배열로 재배치(rehash). 2배가 됐으니 각 노드는 같은 인덱스 또는 (인덱스+옛 용량)로 간다. O(n)이지만 2배씩 늘리므로 분할 상환(amortized) O(1)

get(key)    idx 계산 → 체인 순회하며 key 비교 → 값 또는 undefined
delete(key) idx 계산 → 체인에서 노드 제거(머리/중간/꼬리 모두 처리) → 너무 비면 축소
```

> 해시가 같아도 **키 문자열을 직접 비교**하므로 충돌이 나도 값이 섞이지 않습니다. (`hash` 를 주입받는 옵션이 있어서, 테스트에서 모든 키를 같은 버킷에 몰아넣어 체이닝을 검증합니다.)

참고용 비교(`npm run bench:hashtable`, 20만 키): 직접 구현 set 6.3M ops/s, get 17.5M ops/s로 내장 `Map` 의 약 60~70% 수준. 최장 체인은 5.

### LRU 축출 (`EVICTION=lru MAX_KEYS=1000`)

`MAX_KEYS` 가 가득 찼을 때 기본(`noeviction`)은 새 키를 거부(507)하고, `lru` 는 **가장 오래 안 쓴 키를 버리고** 새 키를 받습니다.

```
해시 테이블:  key ──▶ entry          (찾기 O(1))
이중 연결 리스트:  head(최근) ⇄ entry ⇄ entry ⇄ tail(가장 오래됨)   (순서 갱신/제거 O(1))
```

- 키에 접근(get/set/incr/expire/ttl…)하면 리스트에서 떼어 head 로 옮깁니다. 해시 테이블이 노드를 바로 가리키므로 리스트를 훑을 필요가 없습니다.
- 가득 차면 **만료된 키를 먼저 정리**하고, 그래도 가득이면 tail 을 버립니다.
- `keys()` 같은 관리용 순회와 만료 sweep 은 "사용"으로 치지 않습니다.
- 축출도 AOF 에 삭제로 기록되어 재시작 후 되살아나지 않습니다. 단, **읽기 기록은 로그에 없어서** 재시작 후 순서는 "마지막으로 쓴 순서"로 복원됩니다.
- `lru` 는 `MAX_KEYS` 가 필요합니다. `/stats` 의 `evicted` 로 축출 횟수를 볼 수 있습니다.

## 3. 동시성 — 어떻게 안전하게 만들었나

**"단일 스레드 + 원자적 명령"** 아키텍처입니다. (Redis 와 같은 모델)

- `MiniRedis` 의 모든 명령은 **`await` 가 없는 동기 함수**입니다. Node.js 이벤트 루프는 한 번에 하나의 콜백만 실행하므로, 명령 하나가 끝나기 전에 다른 명령이 끼어들 수 없습니다.
- 그래서 락(mutex) 없이도 read-modify-write 가 안전합니다. `INCR`, `SET NX`(분산 락 용도), 만료 확인 후 삭제 등이 모두 원자적입니다.
- 네트워크 I/O 만 비동기이고, **요청 본문이 완전히 도착한 뒤에** 명령을 동기 실행합니다.
- AOF 쓰기도 `writeSync` 로 같은 흐름 안에서 처리 → **실행 순서 = 로그 순서**가 보장됩니다.
- 저장/조회 시 값을 **복사**합니다. 호출자가 나중에 객체를 수정해도 저장소 내부가 오염되지 않습니다.

테스트로 검증합니다 (`test/server.test.js`):
500개 동시 `INCR` → 정확히 500, 모든 반환값 유일 / 100개 동시 `SET NX` → 정확히 1명만 성공 / 같은 키에 PUT·GET·DELETE 를 섞어 보내도 값이 찢어지지(torn) 않음.

> 한계: CPU 코어 1개만 씁니다. 확장하려면 키 해시로 샤딩한 여러 프로세스를 두는 방식(Redis Cluster 와 유사)이 필요합니다.

## 4. 만료(TTL)된 값 요청 처리

Redis 와 같은 **두 가지 전략을 함께** 씁니다.

1. **Lazy expiration** — 키에 접근하는 *모든 경로*(get / exists / ttl / incr / expire / del / nx 판정 …)가 만료 시각을 먼저 확인합니다. 만료됐으면 **그 자리에서 삭제**하고 "없음"으로 응답합니다. → **만료된 값이 응답으로 나가는 일은 없습니다.** HTTP 에서는 `404`.
2. **Active expiration** — 1초마다 해시 테이블을 `scan` 으로 200개씩 훑어 만료 키를 지웁니다. 검사한 키의 25% 넘게 만료돼 있으면 바로 한 번 더 (최대 5회). → 다시는 읽히지 않는 키가 메모리를 영원히 차지하는 것을 막습니다.

만료 시각은 **절대 시각(ms)** 으로 저장합니다 (재시작 후에도 의미가 유지됨). 경계는 `expiresAt <= now` → 만료 (TTL 1000ms 면 정확히 1000ms 시점에 이미 만료).

## 5. 무효화(deprecated 처리)

`DEL` 은 키 하나를 지우는 것이고, **무효화(invalidate)** 는 "원본이 바뀌어 더는 믿을 수 없는 캐시를 한 번에 폐기"하는 용도입니다.

| 기준 | 예 | 비용 |
|---|---|---|
| `key` | `{ "key": "product:7" }` | O(1) |
| `tag` | `{ "tag": "category:c0" }` — set 할 때 `tags` 로 붙여 둔 그룹 | O(해당 키 수) (태그→키 보조 인덱스) |
| `prefix` | `{ "prefix": "product:" }` | O(n) 전체 순회 |
| `all` | `{ "all": true }` | O(n) |

- 무효화 직후 같은 키를 조회하면 반드시 `404` 입니다 (테스트에서 50회 반복 검증).
- 정확히 **하나의 기준만** 받습니다 (`{key, tag}` 동시 지정은 400). 실수로 전체가 날아가는 것을 막기 위함.
- 데모 API 는 `PUT /products/:id` 로 원본을 수정하면 해당 캐시를 무효화하고, `DELETE /cache/category/:c` 로 카테고리 단위로 한 번에 무효화합니다.
- TTL 은 "시간이 지나서 자연스럽게" 폐기, 무효화는 "이벤트가 발생해서 즉시" 폐기 — 두 가지를 같이 쓰는 것을 권장합니다 (무효화가 누락돼도 TTL 이 안전망).

## 6. 서버 다운 대비 — AOF 영속성 (선택 과제)

`AOF_PATH=./data/mini-redis.aof npm start` 로 켭니다.

- 데이터를 바꾸는 명령을 **로그 파일 끝에 한 줄씩(JSON) 덧붙이고**, 재시작 시 처음부터 재생해 상태를 복원합니다.
- **fsync 정책** (`FSYNC=`): `always`(쓰기마다, 가장 안전) / `everysec`(기본, 크래시 시 최대 ~1초 유실 가능) / `no`.
  프로세스만 죽는 경우(`kill -9`)는 `write` 가 끝난 데이터가 OS 캐시에 있으므로 어느 정책이든 보존됩니다 (테스트로 검증).
- **TTL 은 절대 시각으로 저장** → 서버가 꺼져 있던 동안 만료된 키가 재시작 후 되살아나지 않습니다.
- **크래시 복구**: 마지막 줄이 쓰다 만 상태면 버리고 파일을 잘라냅니다. 중간에 깨진 줄은 건너뛰고 나머지를 복구합니다.
- **트랜잭션 / `mset`**: 안의 변경을 `{"o":"t","r":[…]}` **한 줄**로 기록합니다. 한 줄은 "온전히 기록됐거나, 쓰다 만 줄(복구 때 통째로 버려짐)"이라 크래시가 나도 **절반만 복구되지 않습니다**.
- **Compaction**: 로그가 살아있는 키 수의 2배(최소 1만 줄)를 넘으면 현재 상태만 새 파일로 쓴 뒤 `rename` 으로 **원자적 교체**. 중간에 죽어도 옛 파일이 그대로 남습니다.
- `SIGINT/SIGTERM` 시 정상 종료하며 fsync 후 닫습니다.

## 7. HTTP API

키는 URL 경로에 들어가므로 **`encodeURIComponent` 로 인코딩**해서 보내세요. 값은 JSON 이면 무엇이든 가능합니다 (객체/배열/문자열/숫자/불리언/null). 응답은 항상 JSON.

| 메서드 | 경로 | 본문 | 설명 |
|---|---|---|---|
| `PUT` | `/keys/:key` | `{ "value": …, "ttl": 초, "ttlMs": 밀리초, "tags": [], "nx": true, "xx": true }` | 저장. `nx`: 없을 때만, `xx`: 있을 때만 (조건 불충족 시 `409`) |
| `GET` | `/keys/:key` | | `{ key, value, ttlMs }` — 없거나 만료면 `404` |
| `DELETE` | `/keys/:key` | | 삭제. 없으면 `404` |
| `GET` | `/keys/:key/ttl` | | `{ ttlMs }` (`null` = 만료 없음) |
| `POST` | `/keys/:key/expire` | `{ "ttl": 초 }` | TTL 설정 |
| `POST` | `/keys/:key/persist` | | TTL 제거 |
| `POST` | `/keys/:key/incr` | `{ "by": 1 }` | 원자적 증가 (정수 아니면 `409`) |
| `POST` | `/invalidate` | `{key}` \| `{prefix}` \| `{tag}` \| `{all:true}` | 무효화 → `{ invalidated: n }` |
| `GET` | `/keys?prefix=&limit=` | | 키 목록 (디버깅/관리용, O(n)) |
| `POST` | `/mget` | `{ "keys": [...] }` | 여러 키를 한 번에 읽기 → `{ results: [{ key, found, value? }] }` |
| `POST` | `/mset` | `{ "entries": [{ "key", "value", "ttl", "tags" }] }` | 여러 키를 한 번에 저장 (**전부 저장되거나 전부 거부**) |
| `GET` | `/scan?cursor=0&count=100&prefix=` | | 커서 기반 키 순회 → `{ cursor, keys }` (cursor 가 `0` 으로 돌아오면 끝) |
| `POST` | `/transaction` | `{ "commands": [{ "cmd": "incr", "key": "a" }, …] }` | 명령 여러 개를 끼어들기 없이 연달아 실행 |
| `GET` | `/stats` | | hit/miss, 만료 수, 해시 테이블 상태, AOF 상태 |
| `GET` | `/health` | | 헬스체크 (인증 불필요) |

오류 형식: `{ "error": { "code": "NOT_FOUND", "message": "…" } }` — `400` 입력 오류 / `401` 인증 / `404` / `405` / `409` 조건·타입 / `413` 본문 과다 / `507` maxKeys 초과 / `500` (내부 정보는 노출하지 않음).

```bash
curl -X PUT localhost:6380/keys/user:1 -H 'content-type: application/json' \
     -d '{"value":{"name":"kim"},"ttl":60,"tags":["user"]}'
curl localhost:6380/keys/user:1
curl -X POST localhost:6380/invalidate -H 'content-type: application/json' -d '{"tag":"user"}'
```

환경변수: `PORT`(6380) `HOST`(127.0.0.1) `AOF_PATH` `FSYNC` `AUTH_TOKEN`(설정 시 `Authorization: Bearer …` 필수) `MAX_KEYS` `EVICTION`(noeviction | lru) `MAX_BATCH`(배치/트랜잭션 한 번에 최대 개수, 기본 1000) `LOG_REQUESTS`.
기본은 **로컬(127.0.0.1)에서만** 열립니다. 외부 공개는 `HOST=0.0.0.0` 과 `AUTH_TOKEN` 을 함께 쓰세요.

### JS 클라이언트

```js
import { MiniRedisClient } from './src/client.js';
const cache = new MiniRedisClient('http://localhost:6380', { token: process.env.AUTH_TOKEN });

await cache.set('user:1', { name: 'kim' }, { ttl: 60, tags: ['user'] });
await cache.get('user:1');                 // { name: 'kim' } — 없거나 만료면 undefined (저장된 null 과 구분됨)

// cache-aside: 캐시 조회 → miss 면 loader 실행 후 저장
const { value, hit } = await cache.getOrSet('product:7', () => db.findProduct(7), { ttl: 60 });
```

`getOrSet` 이 처리하는 edge case:
- **cache stampede 방지** — 같은 키에 동시 miss 가 나도 loader 는 1번만 실행 (single-flight)
- **fail-open** — 캐시 서버가 죽었거나 응답이 없어도(타임아웃) loader 결과로 정상 응답. 캐시는 "있으면 좋은 것"
- **loader 에러는 캐시하지 않고** 그대로 전달
- **negative caching** — loader 가 `null` 을 반환하면 `null` 도 (짧은 TTL 로) 캐시 → 없는 id 반복 조회로 DB 가 뚫리는 cache penetration 방지

### 배치 · SCAN · 트랜잭션

**배치 (`mget` / `mset`)** — 키 1,000개를 읽는데 요청 1,000번 대신 1번. 요청마다 붙는 고정 비용(HTTP 헤더, 왕복 지연)을 한 번만 냅니다. 한 번에 실행되므로 `mget` 은 **서로 일관된 스냅샷**이고, `mset` 은 **전부 검증한 뒤 전부 반영**합니다(하나라도 잘못이면 아무것도 저장 안 됨, 공간이 모자라도 마찬가지). 한 번에 최대 1,000개(`MAX_BATCH`) — 단일 스레드라 너무 크면 그동안 다른 요청이 모두 기다립니다.

**SCAN** — `GET /keys` 는 O(n) 전체 순회라 키가 많으면 서버가 멈춥니다. `SCAN` 은 커서로 조금씩 나눠 돌려줍니다.

```bash
curl "localhost:6380/scan?cursor=0&count=100"      # → {"cursor":8,"keys":[…]}
curl "localhost:6380/scan?cursor=8&count=100"      # … 돌려받은 cursor 가 0 이면 끝
```

- 순회를 시작해서 끝낼 때까지 계속 존재한 키는 **최소 한 번** 나옵니다. 순회 도중 테이블이 커지거나 줄어도 마찬가지입니다 (Redis 와 같은 *역순 이진 증가 커서*). 대신 리사이즈가 있었다면 **같은 키가 두 번** 나올 수 있고, 순회 중에 추가·삭제된 키는 나올 수도 안 나올 수도 있습니다.
- `count` 는 "한 번에 검사할 개수"이지 "반환 개수"가 아닙니다. `prefix` 로 걸러지면 `keys` 가 빈 배열이어도 `cursor` 가 0 이 아니면 계속 호출해야 합니다.

**트랜잭션 (`POST /transaction`)** — 명령 여러 개를 한 요청에 담아 보내면 서버가 **다른 요청이 끼어들지 못하게** 연달아 실행합니다 (명령이 동기 실행이라 가능한 것과 같은 원리).

```bash
curl -X POST localhost:6380/transaction -H 'content-type: application/json' -d '{"commands":[
  {"cmd":"incr","key":"acct:a","by":-10},
  {"cmd":"incr","key":"acct:b","by":10}
]}'
# → {"results":[{"ok":true,"value":990},{"ok":true,"value":10}]}
```

지원 명령: `set` `get` `del` `exists` `incr` `ttl` `expire` `persist` `invalidate`. 규칙은 Redis 의 `MULTI/EXEC` 와 같습니다.

| 상황 | 동작 |
|---|---|
| 명령 형식이 잘못됨 (모르는 `cmd`, 잘못된 key/ttl 등) | **아무것도 실행하지 않고** 400 (`commands[1]: …` 처럼 위치 표시) |
| 실행 중에 실패 (정수 아닌 값에 `incr`, 공간 부족 등) | **롤백하지 않음.** 그 명령만 `{ok:false,error}` 이고 나머지는 계속 실행 |
| 서버가 중간에 죽음 | AOF 에 한 줄로 기록하므로 **통째로 복구되거나 통째로 버려짐** |

```js
const [stored, counter, value, failed] = await cache.multi()
  .set('a', 1).incr('counter').get('a').incr('some-text-key')
  .exec();                       // failed 는 MiniRedisHttpError 객체
const values = await cache.mget(['a', 'b', 'c']);            // 없는 키는 undefined
await cache.mset({ a: 1, b: 2 }, { ttl: 60 });
for await (const key of cache.scanKeys({ prefix: 'user:' })) { … }
```

`npm run demo:tx` 로 차이를 볼 수 있습니다: 이체(a 에서 빼고 b 에 더하기)를 요청 2개로 나눠 하면 읽기 300번 중 160번에서 합계가 틀리게 보이고(예: 980), 트랜잭션으로 하면 0번입니다.

`npm run bench:batch`(키 1,000개, 같은 머신의 keep-alive HTTP): 하나씩 읽기 76ms → `mget` 2.3ms, 하나씩 쓰기 111ms → `mset` 2.2ms (약 30~50배). 절대값은 머신마다 다르고, 서버가 원격이면 요청마다 왕복 지연이 붙어 차이가 더 벌어집니다.

## 8. 테스트 (`npm test` — 162개)

| 파일 | 내용 |
|---|---|
| `hashtable.test.js` | 해시 벡터, 충돌(체이닝 머리/중간/꼬리 삭제), 확장/축소, 용량 2의 거듭제곱, scan 완전성, **scan 도중 확장/축소해도 키를 놓치지 않음**, 분포, **무작위 연산 5만 회를 `Map` 과 비교하는 속성 테스트** |
| `store.test.js` | 저장/조회/삭제, 타입 보존, null vs 없음, 값 격리, 입력 검증, NX/XX, **가짜 시계로 TTL 경계**, lazy/active 만료, INCR, 무효화(key/prefix/tag/all), maxKeys, 5만 키 |
| `aof.test.js` | 재시작 복원, 오프라인 중 만료 키 미복원, 잘린 마지막 줄/깨진 줄 복구, compaction, **`SIGKILL` 후 복구** |
| `aof-replay-validation.test.js` | 필드가 잘못된 AOF 레코드(키 없음/비문자열 키, 잘못된 tags·만료 시각, 값 누락)를 만나도 죽지 않고 건너뛰어 `skipped` 로 세며, 태그 인덱스가 오염되지 않음. 트랜잭션 레코드는 안의 레코드가 하나라도 잘못이면 통째로 건너뜀 (반쪽 복구 없음) |
| `server.test.js` | CRUD, 특수문자/유니코드/슬래시 키, 만료 후 404, 입력 검증, 413, 인증, **500 동시 INCR / 100 동시 NX / 혼합 동시 요청**, 무효화, 에러 비노출 |
| `batch.test.js` | `mget`/`mset`(전부 검증 후 반영, 공간 부족 시 무저장, LRU), `scan`(1회씩 순회, prefix, 만료 정리, 순회 중 변경), `transaction`(순서, 사전 검증 → 무실행, 실행 중 오류는 부분 실패) |
| `batch-aof.test.js` | 트랜잭션/`mset` 이 로그에 한 줄로 기록, **쓰다 만 트랜잭션은 통째로 버려짐**, 재시작 복원 |
| `batch-http.test.js` | 새 엔드포인트와 클라이언트 + **동시성**: 100개 트랜잭션이 서로 끼어들지 않음 / 이체 중에도 `mget` 합계가 항상 일정 / 겹치는 `mset` 이 섞이지 않음 |
| `client.test.js` | 클라이언트 전 기능, stampede, fail-open(서버 다운 / 응답 없음), negative caching, **데모 API 연동**(HIT/MISS, 수정 시 무효화, 태그 무효화, TTL 만료 후 재조회) |

## 9. 성능 비교 — 캐시 사용 vs 미사용 (`npm run bench`)

조건: 요청 3,000건 · 동시 50 · DB 쿼리 50ms(커넥션 풀 10개) · 상품 200종, 인기 상품에 쏠린 분포. 모두 실제 HTTP 로 통신 (Windows 11, Node 24).

|                   | 캐시 없음 | 캐시 사용 (cold) | 캐시 사용 (warm) |
|-------------------|-----------|------------------|------------------|
| 총 소요 시간 (ms) | 18760     | 1545             | 548              |
| 처리량 (req/s)    | 160       | 1942             | 5474             |
| 평균 지연 (ms)    | 310.5     | 25.7             | 9.1              |
| p50 (ms)          | 312.9     | 9.3              | 8.4              |
| p95 (ms)          | 315.8     | 171.8            | 13.9             |
| p99 (ms)          | 317.3     | 249.4            | 15.9             |
| DB 쿼리 수        | 3000      | 200              | 0                |
| 캐시 HIT / MISS   | -         | 2677 / 323       | 3000 / 0         |

- **cold** 는 빈 캐시에서 시작한 값(첫 요청들의 miss 포함), **warm** 은 이미 채워진 상태입니다.
- 캐시 없음의 처리량(160 req/s)은 `풀 10 ÷ 50ms = 200 req/s` 라는 DB 한계에 거의 그대로 묶입니다. 캐시를 쓰면 DB 쿼리가 3,000 → 200 으로 줄어(그것도 single-flight 로 동시 miss 를 합친 결과) 병목이 사라집니다.
- cold 의 p95/p99 가 높은 것은 시작 직후 miss 가 몰려 DB 풀 대기가 생기기 때문입니다.
- 이 수치는 **"DB 가 느린 상황"을 가정한 시뮬레이션**입니다. 원본이 이미 매우 빠르면(예: 1ms 미만) 캐시를 한 번 더 거치는 네트워크 비용 때문에 이득이 작거나 없을 수 있습니다. 환경변수 `LATENCY_MS=1 npm run bench` 로 직접 확인해 보세요. 절대값은 머신마다 다릅니다.

## 10. 한계와 개선 아이디어

솔직하게 정리한 현재 한계입니다.

- **리사이즈가 한 번에 전체 rehash** — 키가 수백만이면 순간적으로 멈춥니다. Redis 는 증분(incremental) rehash 로 이를 나눠서 처리합니다.
- **AOF 쓰기/compaction 이 동기 I/O** — 이벤트 루프를 잠깐 막습니다 (대신 순서와 원자성이 단순). `fsync=always` 는 특히 느립니다. 개선: 쓰기 큐 + 별도 워커, compaction 을 worker thread 로.
- **단일 프로세스·단일 코어**, 복제(replication) 없음 → 서버 한 대가 죽으면 AOF 로 복구하는 동안 서비스 중단.
- 값은 **JSON 직렬화 가능한 것만** (`NaN`/함수/`undefined`/BigInt 는 거부). 중첩된 `Date` 는 문자열로 바뀝니다.
- 키 `"."` 와 `".."` 는 URL 표준이 경로를 정규화하므로 `fetch` 기반 클라이언트로는 전달할 수 없습니다 (클라이언트가 명시적으로 거부. 날것의 HTTP 로는 동작).
- 메모리 상한은 `MAX_KEYS`(키 **개수**)뿐이고 값의 바이트 크기는 따지지 않습니다. 축출 정책은 `noeviction` 과 `lru` 두 가지뿐입니다 (LFU 등 없음). LRU 는 정확한 LRU 이지만, 읽기 순서는 AOF 에 남지 않습니다.
- `prefix` 무효화와 `GET /keys` 는 O(n). (`SCAN` 으로 나눠 돌 수 있지만 무효화는 아직 한 번에 처리)
- 트랜잭션은 **롤백이 없고**, 낙관적 락(`WATCH`)도 없습니다. 읽고 → 클라이언트에서 판단하고 → 쓰는 로직을 원자적으로 만들려면 `incr`/`set nx` 같은 단일 명령을 쓰세요. HTTP 는 요청 단위라 Redis 처럼 `MULTI` 로 세션을 열어 두는 방식은 없고, 한 요청에 명령을 모두 담습니다.
- `SCAN` 은 리사이즈가 있으면 같은 키를 두 번 돌려줄 수 있습니다 (빠뜨리지는 않음).
- 태그 보조 인덱스는 내장 `Map` 을 사용합니다 (메인 키-값 저장소만 직접 만든 해시 테이블).
