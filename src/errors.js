export class MiniRedisError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL' } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
  }
}

export class InvalidArgumentError extends MiniRedisError {
  constructor(message) {
    super(message, { status: 400, code: 'INVALID_ARGUMENT' });
  }
}

/** 정수가 아닌 값에 INCR 을 호출하는 등 */
export class WrongTypeError extends MiniRedisError {
  constructor(message) {
    super(message, { status: 409, code: 'WRONG_TYPE' });
  }
}

/** maxKeys 초과 (Redis 의 noeviction 정책과 동일) */
export class StoreFullError extends MiniRedisError {
  constructor(message) {
    super(message, { status: 507, code: 'STORE_FULL' });
  }
}

export class PayloadTooLargeError extends MiniRedisError {
  constructor(message) {
    super(message, { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
}
