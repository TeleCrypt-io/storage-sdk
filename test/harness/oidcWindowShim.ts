/**
 * Test-only Node shim for the browser storage touched during OIDC discovery.
 *
 * It is deliberately scoped to one callback: leaving `window` installed can
 * change rust-crypto WASM's environment detection. This is not SDK login
 * code; the production SDK accepts OAuth/OIDC access and refresh tokens and
 * does not implement password authentication.
 */
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/** Runs an OIDC discovery callback with the minimal temporary Node `window`. */
export async function withOidcWindowShim<T>(callback: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new MemoryStorage();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: storage, sessionStorage: storage },
  });
  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "window", descriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}
