/**
 * Small typed JSON-over-HTTP client used by every upstream adapter.
 * - Per-attempt timeout via AbortController
 * - Retries ONLY when the caller marks the operation safe to repeat (GETs, or idempotency-keyed writes)
 * - Retryable conditions: timeout, network error, 429, 502, 503, 504 (500 is retried for idempotent calls too)
 * - Exponential backoff with full jitter; every attempt is recorded for the execution trace
 * - A successful response is checked against the caller's contract schema. A body that does not match
 *   (or is not JSON) becomes an INVALID_RESPONSE error. It is never turned into empty or default data,
 *   and it is not retried.
 */
import type { ZodType } from 'zod';

export interface AttemptRecord {
  attempt: number;
  status: number | null;
  outcome: 'OK' | 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE';
  durationMs: number;
  fault: string | null;
  errorCode: string | null;
}

export interface CallRecord {
  system: string;
  operation: string;
  method: string;
  path: string;
  attempts: AttemptRecord[];
  finalStatus: number | null;
  ok: boolean;
}

export class UpstreamError extends Error {
  constructor(
    public system: string,
    public operation: string,
    public kind: 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'NOT_CONFIGURED' | 'INVALID_RESPONSE',
    public status: number | null,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === 'TIMEOUT' || this.kind === 'NETWORK' || (this.kind === 'HTTP' && [429, 500, 502, 503, 504].includes(this.status ?? 0));
  }
}

export interface HttpClientOptions {
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  random?: () => number;
}

export type CallObserver = (record: CallRecord) => void;

export class HttpJsonClient {
  constructor(
    private system: string,
    private baseUrl: () => string,
    private token: string,
    private opts: HttpClientOptions,
  ) {}

  async request<T>(
    operation: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    init: { schema: ZodType<T>; body?: unknown; headers?: Record<string, string>; safeToRetry?: boolean; observer?: CallObserver },
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const safeToRetry = init.safeToRetry ?? method === 'GET';
    const maxAttempts = safeToRetry ? this.opts.maxAttempts : 1;
    const record: CallRecord = { system: this.system, operation, method, path, attempts: [], finalStatus: null, ok: false };
    let lastError: UpstreamError | null = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
        try {
          const res = await fetch(`${this.baseUrl()}${path}`, {
            method,
            signal: controller.signal,
            headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          });
          const text = await res.text();
          clearTimeout(timer);
          let json: unknown = null;
          let parsedJson = true;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
            parsedJson = false;
          }
          const fault = res.headers.get('x-sim-fault');
          if (res.ok) {
            record.finalStatus = res.status;
            const checked = parsedJson ? init.schema.safeParse(json) : null;
            if (!checked || !checked.success) {
              record.attempts.push({ attempt, status: res.status, outcome: 'INVALID_RESPONSE', durationMs: Date.now() - started, fault, errorCode: 'INVALID_RESPONSE' });
              const issues = checked && !checked.success ? checked.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) : ['body is not valid JSON'];
              lastError = new UpstreamError(this.system, operation, 'INVALID_RESPONSE', res.status, 'INVALID_RESPONSE', `${this.system} returned a ${operation} response that does not match the contract`, { issues });
              break;
            }
            record.attempts.push({ attempt, status: res.status, outcome: 'OK', durationMs: Date.now() - started, fault, errorCode: null });
            record.ok = true;
            return { data: checked.data, status: res.status, headers: res.headers };
          }
          const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
          record.attempts.push({ attempt, status: res.status, outcome: 'HTTP_ERROR', durationMs: Date.now() - started, fault, errorCode: err?.code ?? null });
          record.finalStatus = res.status;
          lastError = new UpstreamError(this.system, operation, 'HTTP', res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `HTTP ${res.status}`, err?.details);
        } catch (e) {
          clearTimeout(timer);
          const aborted = (e as Error).name === 'AbortError';
          record.attempts.push({ attempt, status: null, outcome: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', durationMs: Date.now() - started, fault: null, errorCode: null });
          lastError = aborted
            ? new UpstreamError(this.system, operation, 'TIMEOUT', null, 'TIMEOUT', `${this.system} did not respond within ${this.opts.timeoutMs} ms`)
            : new UpstreamError(this.system, operation, 'NETWORK', null, 'NETWORK_ERROR', `${this.system} unreachable: ${(e as Error).message}`);
        }
        if (!lastError.retryable || attempt === maxAttempts) break;
        const cap = this.opts.baseDelayMs * 2 ** (attempt - 1);
        const delay = Math.floor((this.opts.random ?? Math.random)() * cap);
        await new Promise((r) => setTimeout(r, delay));
      }
      throw lastError ?? new UpstreamError(this.system, operation, 'NETWORK', null, 'UNKNOWN', 'Request failed');
    } finally {
      init.observer?.(record);
    }
  }
}
