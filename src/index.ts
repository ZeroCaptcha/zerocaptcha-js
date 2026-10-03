/**
 * ZeroCaptcha's official client for JavaScript and TypeScript: create a Cloudflare Turnstile task
 * or a Cloudflare challenge page's task, wait for its result, read the balance, and check a task
 * callback's signature. It has no
 * dependencies: it uses `fetch`, `AbortSignal` and Web Crypto, so it runs in Node.js 20 and later,
 * Deno, Bun and browsers.
 *
 * ```ts
 * const client = new ZeroCaptcha({ apiKey: process.env.ZEROCAPTCHA_KEY!, baseUrl: process.env.ZEROCAPTCHA_API! });
 * const token = await client.solve({ websiteURL: "https://shop.example.com/login", websiteKey: "0x4AAAAAAAB1cD2eF3gH4iJ5" });
 * ```
 */

/** The API's address when `baseUrl` is not given. */
export const DEFAULT_BASE_URL = "https://api.zerocaptcha.io";

/** `TurnstileTaskProxyless`, or `TurnstileTask` to solve through your own proxy. */
export type TaskType = "TurnstileTaskProxyless" | "TurnstileTask";

/** Where a task is: queued and running end in succeeded, failed or expired. */
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

/** A Turnstile task to create. */
export interface NewTask {
  /** By default `TurnstileTaskProxyless`, or `TurnstileTask` when `proxy` is set. */
  type?: TaskType;
  /** The page the widget is on. */
  websiteURL: string;
  /** The widget's site key. */
  websiteKey: string;
  /** The widget's action, if it sets one. */
  action?: string;
  /** The widget's cData, if it sets one. */
  cdata?: string;
  /** Your proxy as a URL with its port, such as `http://user:pass@proxy.example.net:8080`. */
  proxy?: string;
  /** Where to POST the task once it ends, signed with your callback secret (see verifySignature). */
  callbackUrl?: string;
}

/**
 * A Cloudflare challenge page's task (`CloudflareChallengeTask`), always through your proxy: its
 * clearance works only from the proxy's address, with the user agent that earned it.
 */
export interface NewChallengeTask {
  /** The page behind the challenge. */
  websiteURL: string;
  /** Your proxy as a URL with its port, such as `http://user:pass@proxy.example.net:8080`. */
  proxy: string;
  /** Where to POST the task once it ends, signed with your callback secret (see verifySignature). */
  callbackUrl?: string;
}

/**
 * A challenge page's clearance: send the cookie as `cf_clearance`, with exactly this user agent,
 * through the proxy the task used.
 */
export interface Clearance {
  /** The `cf_clearance` cookie's value. */
  cfClearance: string;
  /** The `User-Agent` the clearance was earned with. */
  userAgent: string;
  /** Until when the API serves the clearance; the site's own setting decides how long it works. */
  tokenExpiresAt: string | null;
}

/** A task as the API shows it. Fields the API adds later come through as they are. */
export interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  /** What it solves: `turnstile`, a widget's token, or `cloudflare`, a challenge page's clearance. */
  kind?: "turnstile" | "cloudflare";
  websiteURL: string;
  /** The widget's site key; `null` for a challenge page. */
  websiteKey: string | null;
  /** US dollars, as a decimal string: what the task costs if it succeeds. */
  price: string;
  /** US dollars held while it runs. */
  held: string;
  /** US dollars charged: the price once it succeeded, otherwise zero. */
  cost: string;
  /** Why it failed or expired, such as `ERROR_CAPTCHA_UNSOLVABLE`. */
  errorCode?: string | null;
  errorDescription?: string | null;
  /**
   * The token, while it is available. A challenge page's also has the `cf_clearance` cookie and
   * the user agent it is bound to.
   */
  solution?: {
    token: string;
    userAgent?: string | null;
    cookie?: { name: string; value: string; expiresAt: string | null } | null;
  } | null;
  tokenExpiresAt?: string | null;
  createdAt: string;
  [field: string]: unknown;
}

/** The account's balance, in US dollars as decimal strings. */
export interface Balance {
  /** What new tasks can be held against. */
  available: string;
  /** Held for tasks that are queued or running. */
  held: string;
  currency: string;
}

export interface ClientOptions {
  /** Your API key, `zc_live_…`. */
  apiKey: string;
  /** The API's address; `https://api.zerocaptcha.io` (DEFAULT_BASE_URL) when not given or empty. */
  baseUrl?: string | undefined;
  /** How long one request may take, in milliseconds; 30 seconds by default. */
  timeoutMs?: number;
  /** The fetch to use, such as one with a custom agent; the global one by default. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Cancels the call. */
  signal?: AbortSignal;
}

export interface CreateOptions extends RequestOptions {
  /**
   * Your ID for this task, 1 to 255 visible ASCII characters. Sending the same one again returns
   * the first task instead of making a second. One is made for each call when you give none, so
   * the client's own retries never make two tasks.
   */
  idempotencyKey?: string;
}

export interface WaitOptions extends RequestOptions {
  /** How long to wait for a final status, in milliseconds; 3 minutes by default. */
  timeoutMs?: number;
  /** How often to ask, in milliseconds; 2 seconds by default. */
  intervalMs?: number;
}

/** The API refused a request, or could not serve it. */
export class ZeroCaptchaError extends Error {
  override readonly name = "ZeroCaptchaError";
  /** The HTTP status; 0 when the request never got an answer. */
  readonly status: number;
  /** The API's stable error code, such as `insufficient_funds` or `rate_limited`. */
  readonly code: string;
  /** Quote it when you ask support about this request. */
  readonly requestId: string | undefined;
  /** How long the API asked you to wait before trying again, in milliseconds. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    status: number,
    code: string,
    requestId?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A task ended without a token: it failed or expired, and nothing was charged. */
export class TaskFailedError extends Error {
  override readonly name = "TaskFailedError";
  /** Such as `ERROR_CAPTCHA_UNSOLVABLE`, from the task's `errorCode`. */
  readonly code: string;
  readonly task: Task;

  constructor(task: Task) {
    super(task.errorDescription ?? `The task ${task.status}.`);
    this.task = task;
    this.code = task.errorCode ?? (task.status === "expired" ? "ERROR_TASK_TIMEOUT" : "failed");
  }
}

/** The task had not ended when the wait ran out; it may still end, and you can wait again. */
export class WaitTimeoutError extends Error {
  override readonly name = "WaitTimeoutError";
  /** The task as it was last read; undefined when no read finished before the wait ran out. */
  readonly task: Task | undefined;
  /** The task waited for. */
  readonly taskId: string;

  constructor(task: Task | undefined, taskId: string = task?.id ?? "") {
    super(
      task === undefined
        ? "The wait ran out before the task could be read."
        : `The task was still ${task.status} when the wait ran out.`,
    );
    this.task = task;
    this.taskId = taskId;
  }
}

/** A wait's deadline came during a request: the request was cut short, and nothing is retried. */
class DeadlinePassed extends Error {}

const FINAL: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "expired"]);

/** Answers worth another try after a wait: too many requests, or a server busy or away. */
const RETRYABLE = new Set([429, 502, 503, 504]);

/** Whether `failure` may pass if the same request is sent again after a wait. */
const retryable = (failure: ZeroCaptchaError): boolean =>
  RETRYABLE.has(failure.status) ||
  // The first request with this Idempotency-Key is still being served.
  (failure.status === 409 && failure.code === "idempotency_key_in_use");

/** How many times one call is tried in all. */
const ATTEMPTS = 3;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/** The ZeroCaptcha API, as one account's key sees it. */
export class ZeroCaptcha {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options.apiKey.startsWith("zc_live_")) {
      throw new TypeError("apiKey must be a ZeroCaptcha API key, zc_live_….");
    }
    const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new TypeError("baseUrl must be the API's http or https address.");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Creates a task; it is charged only if it succeeds. */
  async createTask(task: NewTask, options: CreateOptions = {}): Promise<Task> {
    const body = {
      ...task,
      type: task.type ?? (task.proxy === undefined ? "TurnstileTaskProxyless" : "TurnstileTask"),
    };
    return this.#request<Task>("POST", "/v1/tasks", {
      body,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      signal: options.signal,
    });
  }

  /** Reads a task; its token is in `solution` while it is available. */
  async getTask(id: string, options: RequestOptions = {}): Promise<Task> {
    return this.#request<Task>("GET", `/v1/tasks/${encodeURIComponent(id)}`, {
      signal: options.signal,
    });
  }

  /**
   * Waits for a task to end: resolves with it once it succeeded, and throws TaskFailedError when
   * it failed or expired, or WaitTimeoutError when the wait ran out first. The wait never runs
   * past `timeoutMs`: each read gets only the time left, and a retry that would wait longer than
   * that, such as after a long Retry-After, is not made.
   */
  async waitForResult(id: string, options: WaitOptions = {}): Promise<Task> {
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    const interval = options.intervalMs ?? 2_000;
    const path = `/v1/tasks/${encodeURIComponent(id)}`;
    let last: Task | undefined;
    for (;;) {
      let task: Task;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, at the interval
        task = await this.#request<Task>("GET", path, { signal: options.signal, deadline });
      } catch (error) {
        if (error instanceof DeadlinePassed) throw new WaitTimeoutError(last, id);
        throw error;
      }
      last = task;
      if (task.status === "succeeded") return task;
      if (FINAL.has(task.status)) throw new TaskFailedError(task);
      const left = deadline - Date.now();
      if (left <= 0) throw new WaitTimeoutError(task, id);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await sleep(Math.min(interval, left), options.signal);
    }
  }

  /** Creates a task and waits for it: the token, or TaskFailedError or WaitTimeoutError. */
  async solve(task: NewTask, options: CreateOptions & WaitOptions = {}): Promise<string> {
    const created = await this.createTask(task, options);
    const done = await this.waitForResult(created.id, options);
    const token = done.solution?.token;
    if (token === undefined) throw new TaskFailedError(done);
    return token;
  }

  /** Creates a Cloudflare challenge page's task, through your proxy; charged only if it succeeds. */
  async createChallengeTask(task: NewChallengeTask, options: CreateOptions = {}): Promise<Task> {
    return this.#request<Task>("POST", "/v1/tasks", {
      body: { ...task, type: "CloudflareChallengeTask" },
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      signal: options.signal,
    });
  }

  /**
   * Creates a challenge page's task and waits for it: its clearance, or TaskFailedError or
   * WaitTimeoutError.
   */
  async solveChallenge(
    task: NewChallengeTask,
    options: CreateOptions & WaitOptions = {},
  ): Promise<Clearance> {
    const created = await this.createChallengeTask(task, options);
    const done = await this.waitForResult(created.id, options);
    const cookie = done.solution?.cookie;
    const userAgent = done.solution?.userAgent;
    if (cookie === undefined || cookie === null || typeof userAgent !== "string") {
      throw new TaskFailedError(done);
    }
    return { cfClearance: cookie.value, userAgent, tokenExpiresAt: done.tokenExpiresAt ?? null };
  }

  /** The account's balance. */
  async getBalance(options: RequestOptions = {}): Promise<Balance> {
    return this.#request<Balance>("GET", "/v1/balance", { signal: options.signal });
  }

  /**
   * Sends one call, trying it up to ATTEMPTS times with the same Idempotency-Key: after no answer,
   * an answer cut short (its body could not be read, or a success's did not parse), or a
   * retryable refusal. With a `deadline` (milliseconds since the epoch), no attempt and no wait
   * runs past it: DeadlinePassed says it came.
   */
  async #request<T>(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal | undefined;
      deadline?: number;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    const left = () => (options.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
    let failure: ZeroCaptchaError | undefined;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const remaining = left();
      if (remaining <= 0) throw new DeadlinePassed();
      const signals = [AbortSignal.timeout(Math.min(this.#timeoutMs, remaining))];
      if (options.signal !== undefined) signals.push(options.signal);
      let response: Response;
      let text: string;
      try {
        // oxlint-disable-next-line no-await-in-loop -- a retry follows the answer before it
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.any(signals),
        });
        // The body is part of the answer: one cut short is retried as no answer is, with the
        // same Idempotency-Key, so a task the API made is returned rather than made again.
        // oxlint-disable-next-line no-await-in-loop -- see above
        text = await response.text();
      } catch (error) {
        if (options.signal?.aborted === true) throw error;
        if (left() <= 0) throw new DeadlinePassed();
        failure = new ZeroCaptchaError("The request got no answer.", 0, "network");
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (attempt < ATTEMPTS) await pause(500 * 2 ** attempt, left(), options.signal);
        continue;
      }
      if (response.ok) {
        try {
          // The client passes the API's replies through as its contract types them, and checks
          // only that they parse.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the API's contract types it
          return JSON.parse(text) as T;
        } catch {
          failure = new ZeroCaptchaError("The answer was cut short.", response.status, "network");
          // oxlint-disable-next-line no-await-in-loop -- see above
          if (attempt < ATTEMPTS) await pause(500 * 2 ** attempt, left(), options.signal);
          continue;
        }
      }
      failure = problem(response, text);
      if (!retryable(failure) || attempt === ATTEMPTS) throw failure;
      // oxlint-disable-next-line no-await-in-loop -- see above
      await pause(failure.retryAfterMs ?? 500 * 2 ** attempt, left(), options.signal);
    }
    throw failure ?? new ZeroCaptchaError("The request failed.", 0, "network");
  }
}

/** Waits `ms` before a retry, unless that would run past the time `left`. */
async function pause(ms: number, left: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms >= left) throw new DeadlinePassed();
  await sleep(ms, signal);
}

/** The fields of a problem document, or none when the body is not one. */
function fieldsOf(text: string): Map<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return new Map(Object.entries(typeof parsed === "object" && parsed !== null ? parsed : {}));
  } catch {
    return new Map();
  }
}

function problem(response: Response, text: string): ZeroCaptchaError {
  const fields = fieldsOf(text);
  const field = (name: string) => {
    const value = fields.get(name);
    return typeof value === "string" ? value : undefined;
  };
  return new ZeroCaptchaError(
    field("detail") ?? field("title") ?? `HTTP ${response.status}`,
    response.status,
    field("code") ?? `http_${response.status}`,
    field("request_id") ?? response.headers.get("x-request-id") ?? undefined,
    retryAfter(response),
  );
}

/** The header each callback carries: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = "ZeroCaptcha-Signature";

export interface VerifyOptions {
  /** How old a call may be, in seconds, against replays; 5 minutes by default. */
  toleranceSeconds?: number;
  /** The time to check against, in milliseconds since the epoch; now by default. */
  now?: number;
}

const encoder = new TextEncoder();

/**
 * Whether a callback is genuine: `header` is its `ZeroCaptcha-Signature`, `body` the raw body as
 * it arrived (before any parsing), and `secret` your callback secret, `zcsig_…`. The signature is
 * the HMAC-SHA256 of `<t>.<body>`; a call older than the tolerance is refused too.
 */
export async function verifySignature(
  secret: string,
  header: string | null | undefined,
  body: string | Uint8Array,
  options: VerifyOptions = {},
): Promise<boolean> {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header?.trim() ?? "");
  if (match === null) return false;
  const [, t = "", v1 = ""] = match;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(t)) > (options.toleranceSeconds ?? 300)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const raw = typeof body === "string" ? encoder.encode(body) : body;
  const signed = new Uint8Array(t.length + 1 + raw.length);
  signed.set(encoder.encode(`${t}.`), 0);
  signed.set(raw, t.length + 1);
  const digest = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    digest[index] = Number.parseInt(v1.slice(index * 2, index * 2 + 2), 16);
  }
  // Web Crypto's verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, digest, signed);
}
