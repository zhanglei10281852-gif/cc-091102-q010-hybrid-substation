// 按资源名加锁的互斥锁。所有调用方都按同一稳定顺序（资源名字典序）取锁，
// 因此不存在循环等待，两个交叉争抢的计划只会串行排队，不会死锁。
export class LockTimeoutError extends Error {
  constructor(key) {
    super(`lock-timeout:${key}`);
    this.code = 'lock-timeout';
  }
}

export class KeyedMutex {
  #held = new Set();
  #queues = new Map();

  // 返回 release 函数；timeoutMs 内拿不到锁则拒绝，等待项会被移除，不会泄漏。
  acquire(key, timeoutMs = Infinity) {
    if (!this.#held.has(key)) {
      this.#held.add(key);
      return Promise.resolve(() => this.#release(key));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, timer: null };
      waiter.resolve = (release) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(release);
      };
      if (Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          const queue = this.#queues.get(key);
          if (queue) {
            const index = queue.indexOf(waiter);
            if (index > -1) queue.splice(index, 1);
            if (queue.length === 0) this.#queues.delete(key);
          }
          reject(new LockTimeoutError(key));
        }, Math.max(0, timeoutMs));
      }
      const queue = this.#queues.get(key) ?? [];
      queue.push(waiter);
      this.#queues.set(key, queue);
    });
  }

  #release(key) {
    const queue = this.#queues.get(key);
    const next = queue?.shift();
    if (next) {
      if (queue.length === 0) this.#queues.delete(key);
      next.resolve(() => this.#release(key)); // 所有权直接移交，锁保持占用
      return;
    }
    this.#queues.delete(key);
    this.#held.delete(key);
  }
}
