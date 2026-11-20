import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const sha256 = (v: string) => createHash("sha256").update(v).digest();

/** Constant-time comparison of two strings of any length. */
export function safeEqual(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * The signing key mixes in the password, so changing ADMIN_PASSWORD
 * logs every existing admin session out.
 */
function signingKey(secret: string, password: string) {
  return createHash("sha256").update(secret).update("\0").update(password).digest();
}

function sign(key: Buffer, payload: string) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Stateless admin token: `admin.<expiresAtMs>.<hmac>`. */
export function issueToken(secret: string, password: string, now = Date.now()) {
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `admin.${expiresAt}`;
  return { token: `${payload}.${sign(signingKey(secret, password), payload)}`, expiresAt };
}

export function verifyToken(token: unknown, secret: string, password: string, now = Date.now()): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "admin") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return safeEqual(parts[2], sign(signingKey(secret, password), `admin.${parts[1]}`));
}

/** Fixed-window limiter for login attempts, per client IP. In memory: one API process. */
export class LoginLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns seconds to wait, or 0 if the attempt is allowed. */
  attempt(key: string, now = Date.now()): number {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.#hits.size > 10_000) this.#prune(now);
      return 0;
    }
    entry.count++;
    return entry.count > this.max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  reset(key: string) {
    this.#hits.delete(key);
  }

  #prune(now: number) {
    for (const [k, v] of this.#hits) if (v.resetAt <= now) this.#hits.delete(k);
  }
}
