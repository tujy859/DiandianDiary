/** 一个请求独享的取消信号；旧请求不能修改新请求的状态。 */
export class AbortedError extends Error {
  constructor() { super('已停止生成'); this.name = 'AbortedError'; }
}

export interface AbortToken {
  aborted: boolean;
  onAbort?: (listener: () => void) => () => void;
}

export class RequestToken implements AbortToken {
  aborted = false;
  private listeners: Array<() => void> = [];
  onAbort = (listener: () => void): (() => void) => {
    if (this.aborted) { listener(); return () => {}; }
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((fn) => fn !== listener); };
  };
  cancel() {
    if (this.aborted) return;
    this.aborted = true;
    const listeners = this.listeners.slice();
    this.listeners = [];
    listeners.forEach((fn) => fn());
  }
}

export function throwIfAborted(token?: AbortToken) {
  if (token && token.aborted) throw new AbortedError();
}
