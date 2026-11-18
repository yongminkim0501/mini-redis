/**
 * AOF (Append-Only File) 영속성
 *
 * Redis 의 AOF 와 같은 아이디어: 데이터를 바꾸는 명령을 로그 파일 끝에 계속 덧붙이고,
 * 서버가 다시 뜰 때 로그를 처음부터 재생(replay)해서 메모리 상태를 복원한다.
 *
 * - 한 줄에 JSON 레코드 하나 (사람이 읽기 쉽고, 일부가 깨져도 줄 단위로 복구 가능)
 *     {"o":"p","k":"key","v":<json>,"e":<만료 절대시각(ms)|null>,"t":["tag"]}   put
 *     {"o":"d","k":"key"}                                                       delete
 *     {"o":"f"}                                                                 flush all
 * - 만료 시각은 "남은 시간"이 아니라 "절대 시각"으로 저장한다.
 *   그래야 서버가 꺼져 있던 시간 동안 만료된 키가 재시작 후 되살아나지 않는다.
 * - fsync 정책 (Redis appendfsync 와 동일한 개념)
 *     always   : 쓰기마다 fsync. 가장 안전하지만 느림.
 *     everysec : 1초마다 fsync (기본). 크래시 시 최대 ~1초 분량 유실 가능.
 *     no       : OS 에 맡김. 가장 빠르지만 OS 크래시 시 유실 폭이 큼.
 *   (프로세스만 죽는 경우에는 write 가 끝난 데이터는 OS 캐시에 있으므로 어느 정책이든 보존된다.)
 * - 로그가 계속 커지므로 compaction(rewrite): 현재 살아 있는 키만 새 파일에 쓰고
 *   임시 파일 → rename 으로 원자적으로 교체한다. 도중에 죽어도 옛 파일이 그대로 남는다.
 * - 마지막 줄이 쓰다 만 상태(전원 차단 등)면 버리고 파일을 잘라낸다.
 */
import fs from 'node:fs';
import path from 'node:path';

export const FSYNC_POLICIES = ['always', 'everysec', 'no'];

export class Aof {
  #path;
  #fsync;
  #fd = null;
  #dirty = false;
  #timer = null;

  constructor(filePath, { fsync = 'everysec' } = {}) {
    if (!FSYNC_POLICIES.includes(fsync)) {
      throw new Error(`invalid fsync policy: ${fsync} (expected ${FSYNC_POLICIES.join('|')})`);
    }
    this.#path = filePath;
    this.#fsync = fsync;
  }

  get path() {
    return this.#path;
  }

  /**
   * 파일을 읽어 각 레코드를 onRecord 로 전달한 뒤, 이후 append 를 위해 파일을 연다.
   * onRecord 가 false 를 반환한 레코드(필드가 잘못된 레코드)는 skipped 로 센다.
   * @returns {{ records: number, skipped: number, truncatedBytes: number }}
   */
  load(onRecord) {
    fs.mkdirSync(path.dirname(path.resolve(this.#path)), { recursive: true });
    let records = 0;
    let skipped = 0;
    let truncatedBytes = 0;

    if (fs.existsSync(this.#path)) {
      const text = fs.readFileSync(this.#path, 'utf8');
      const lastNewline = text.lastIndexOf('\n');
      const complete = text.slice(0, lastNewline + 1);
      const tail = text.slice(lastNewline + 1);

      if (tail.length > 0) {
        // 개행으로 끝나지 않는 마지막 조각 = 쓰다 만 레코드 → 버린다.
        truncatedBytes = Buffer.byteLength(tail);
        fs.truncateSync(this.#path, Buffer.byteLength(complete));
      }

      for (const line of complete.split('\n')) {
        if (line === '') continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          skipped++; // 깨진 줄은 건너뛰고 나머지를 최대한 복구
          continue;
        }
        if (!record || typeof record !== 'object' || typeof record.o !== 'string') {
          skipped++;
          continue;
        }
        // onRecord 가 false 를 반환하면 의미상 잘못된 레코드 → 건너뛴 것으로 센다.
        if (onRecord(record) === false) {
          skipped++;
          continue;
        }
        records++;
      }
    }

    this.#open();
    return { records, skipped, truncatedBytes };
  }

  #open() {
    this.#fd = fs.openSync(this.#path, 'a');
    if (this.#fsync === 'everysec' && this.#timer === null) {
      this.#timer = setInterval(() => this.sync(), 1000);
      this.#timer.unref();
    }
  }

  append(record) {
    if (this.#fd === null) throw new Error('AOF is closed');
    // writeSync: 명령 실행 순서 == 로그 순서를 보장하고, 쓰는 동안 다른 명령이 끼어들 수 없다.
    fs.writeSync(this.#fd, JSON.stringify(record) + '\n');
    if (this.#fsync === 'always') fs.fsyncSync(this.#fd);
    else this.#dirty = true;
  }

  sync() {
    if (this.#fd !== null && this.#dirty) {
      fs.fsyncSync(this.#fd);
      this.#dirty = false;
    }
  }

  /** 주어진 레코드들만으로 로그를 새로 쓴다 (compaction). */
  rewrite(records) {
    const tmp = this.#path + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      let buf = [];
      let bufLen = 0;
      for (const rec of records) {
        const line = JSON.stringify(rec) + '\n';
        buf.push(line);
        bufLen += line.length;
        if (bufLen > 1 << 20) {
          fs.writeSync(fd, buf.join(''));
          buf = [];
          bufLen = 0;
        }
      }
      if (buf.length > 0) fs.writeSync(fd, buf.join(''));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (this.#fd !== null) {
      this.sync();
      fs.closeSync(this.#fd);
      this.#fd = null;
    }
    fs.renameSync(tmp, this.#path); // 원자적 교체
    this.#fd = fs.openSync(this.#path, 'a');
    this.#dirty = false;
  }

  close() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#fd !== null) {
      try {
        fs.fsyncSync(this.#fd);
      } finally {
        fs.closeSync(this.#fd);
        this.#fd = null;
      }
    }
  }
}
