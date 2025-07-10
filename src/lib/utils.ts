import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 定義可解析 Promise 的介面
interface ResolvablePromise<T> extends Promise<T> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export const resolvablePromise = <T>(): ResolvablePromise<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  // 使用 Object.assign 來添加方法，避免 any 類型
  return Object.assign(promise, {
    resolve,
    reject,
  }) as ResolvablePromise<T>;
};
