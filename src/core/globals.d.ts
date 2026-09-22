// Web-platform globals that exist in both browsers and Node >= 18. The core
// tsconfig deliberately omits the DOM lib so nothing browser-only can leak in;
// these are the only shared globals the core relies on.
declare const crypto: { randomUUID(): string }
declare function structuredClone<T>(value: T): T
declare function atob(data: string): string
