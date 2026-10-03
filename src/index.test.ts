import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_BASE_URL,
  TaskFailedError,
  verifySignature,
  WaitTimeoutError,
  ZeroCaptcha,
  ZeroCaptchaError,
  type Task,
} from "./index";

const KEY = "zc_live_StandInKeyForTheSdkTests0123456789a";

/** A request the stand-in saw. */
interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

/**
 * A stand-in for the API on this machine: it answers as the REST API does, from a script of
 * statuses per task, and records every request.
 */
class StandIn {
  readonly seen: Seen[] = [];
  /** Statuses each read of a task returns, in turn; the last repeats. */
  readonly script = new Map<string, Task["status"][]>();
  readonly tasks = new Map<string, Task>();
  readonly byKey = new Map<string, string>();
  /** Answers to give before the real one, such as a 429. */
  readonly refusals: { status: number; code: string; retryAfter?: string }[] = [];
  /** How long each read of a task takes to answer, in milliseconds. */
  readDelayMs = 0;
  /** How many task creations, made in full, to answer with a body cut short. */
  cutBodies = 0;
  #server: Server | undefined;
  #next = 0;

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");
    return `http://127.0.0.1:${address.port}/`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const text = await new Promise<string>((resolve) => {
      let received = "";
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        received += part;
      });
      request.on("end", () => {
        resolve(received);
      });
    });
    const path = request.url ?? "/";
    this.seen.push({
      method: request.method ?? "GET",
      path,
      headers: request.headers,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, {
        "content-type": status >= 400 ? "application/problem+json" : "application/json",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    const refuse = (status: number, code: string, headers: Record<string, string> = {}) => {
      send(
        status,
        {
          type: "about:blank",
          title: code,
          status,
          code,
          detail: `Refused: ${code}.`,
          request_id: "req-1",
        },
        headers,
      );
    };
    if (request.headers.authorization !== `Bearer ${KEY}`) {
      refuse(401, "unauthorized");
      return;
    }
    const refusal = this.refusals.shift();
    if (refusal !== undefined) {
      refuse(
        refusal.status,
        refusal.code,
        refusal.retryAfter === undefined ? {} : { "retry-after": refusal.retryAfter },
      );
      return;
    }
    if (request.method === "POST" && path === "/v1/tasks") {
      const key = request.headers["idempotency-key"];
      const known = typeof key === "string" ? this.byKey.get(key) : undefined;
      if (known !== undefined) {
        send(201, this.tasks.get(known));
        return;
      }
      const parsed: unknown = JSON.parse(text);
      const body = new Map(
        Object.entries(typeof parsed === "object" && parsed !== null ? parsed : {}),
      );
      this.#next += 1;
      const id = `0192f3a4-7b1c-7d2e-9f10-00000000000${this.#next}`;
      const task: Task = {
        id,
        type: String(body.get("type")),
        status: "queued",
        websiteURL: String(body.get("websiteURL")),
        websiteKey: body.has("websiteKey") ? String(body.get("websiteKey")) : null,
        price: "0.000800",
        held: "0.000800",
        cost: "0.000000",
        createdAt: "2026-09-30T10:00:00Z",
      };
      this.tasks.set(id, task);
      if (typeof key === "string") this.byKey.set(key, id);
      if (this.cutBodies > 0) {
        // The task is made; its answer stops halfway, and the connection drops.
        this.cutBodies -= 1;
        const whole = JSON.stringify(task);
        response.writeHead(201, {
          "content-type": "application/json",
          "content-length": String(whole.length),
        });
        response.write(whole.slice(0, 20));
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      send(201, task, { location: `/v1/tasks/${id}` });
      return;
    }
    const read = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (request.method === "GET" && read !== null) {
      if (this.readDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
      }
      const task = this.tasks.get(read[1] ?? "");
      if (task === undefined) {
        refuse(404, "not_found");
        return;
      }
      const script = this.script.get(task.id) ?? ["succeeded"];
      const status = script.length > 1 ? (script.shift() ?? "queued") : (script[0] ?? "queued");
      const challenge = task.type === "CloudflareChallengeTask";
      const ended: Partial<Task> =
        status === "succeeded" && challenge
          ? {
              cost: "0.001200",
              held: "0.000000",
              tokenExpiresAt: "2026-09-30T10:30:00Z",
              solution: {
                token: "stand-in-clearance",
                userAgent: "Mozilla/5.0 (stand-in)",
                cookie: { name: "cf_clearance", value: "stand-in-clearance", expiresAt: null },
              },
            }
          : status === "succeeded"
            ? { cost: "0.000800", held: "0.000000", solution: { token: "0.stand-in-token" } }
            : status === "failed"
              ? {
                  held: "0.000000",
                  errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
                  errorDescription: "The task could not be solved. Nothing was charged.",
                }
              : {};
      send(200, { ...task, status, ...ended });
      return;
    }
    if (request.method === "GET" && path === "/v1/balance") {
      send(200, { available: "14.100000", held: "0.000800", currency: "USD" });
      return;
    }
    refuse(404, "not_found");
  }
}

let api: StandIn;
let client: ZeroCaptcha;

beforeEach(async () => {
  api = new StandIn();
  client = new ZeroCaptcha({ apiKey: KEY, baseUrl: await api.start() });
});

afterEach(async () => {
  await api.stop();
});

const task = {
  websiteURL: "https://shop.example.com/login",
  websiteKey: "0x4AAAAAAAB1cD2eF3gH4iJ5",
};

describe("challenge pages", () => {
  const page = {
    websiteURL: "https://shop.example.com/",
    proxy: "http://user:pass@proxy.example.net:8080",
  };

  test("solveChallenge creates a challenge task through the proxy and returns its clearance", async () => {
    api.script.set("0192f3a4-7b1c-7d2e-9f10-000000000001", ["running", "succeeded"]);
    const clearance = await client.solveChallenge(page, { intervalMs: 5 });
    expect(clearance).toEqual({
      cfClearance: "stand-in-clearance",
      userAgent: "Mozilla/5.0 (stand-in)",
      tokenExpiresAt: "2026-09-30T10:30:00Z",
    });
    const [create] = api.seen;
    expect(create?.body).toEqual({ ...page, type: "CloudflareChallengeTask" });
    expect(create?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a challenge that fails is TaskFailedError with its code", async () => {
    api.script.set("0192f3a4-7b1c-7d2e-9f10-000000000001", ["failed"]);
    await expect(client.solveChallenge(page, { intervalMs: 5 })).rejects.toMatchObject({
      name: "TaskFailedError",
      code: "ERROR_CAPTCHA_UNSOLVABLE",
    });
  });
});

describe("tasks", () => {
  test("solve creates a proxyless task, polls it and returns its token", async () => {
    api.script.set("0192f3a4-7b1c-7d2e-9f10-000000000001", ["queued", "running", "succeeded"]);
    const token = await client.solve(task, { intervalMs: 5 });
    expect(token).toBe("0.stand-in-token");
    const [create, ...reads] = api.seen;
    expect(create?.method).toBe("POST");
    expect(create?.path).toBe("/v1/tasks");
    expect(create?.body).toEqual({ ...task, type: "TurnstileTaskProxyless" });
    expect(create?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(create?.headers["content-type"]).toBe("application/json");
    expect(reads.map((seen) => seen.path)).toEqual([
      "/v1/tasks/0192f3a4-7b1c-7d2e-9f10-000000000001",
      "/v1/tasks/0192f3a4-7b1c-7d2e-9f10-000000000001",
      "/v1/tasks/0192f3a4-7b1c-7d2e-9f10-000000000001",
    ]);
  });

  test("a proxy makes it a proxy task, and a callback URL is sent as given", async () => {
    await client.createTask(
      {
        ...task,
        proxy: "http://user:pass@proxy.example.net:8080",
        callbackUrl: "https://hooks.example.com/zc",
      },
      { idempotencyKey: "order-1234" },
    );
    expect(api.seen[0]?.body).toMatchObject({
      type: "TurnstileTask",
      proxy: "http://user:pass@proxy.example.net:8080",
      callbackUrl: "https://hooks.example.com/zc",
    });
    expect(api.seen[0]?.headers["idempotency-key"]).toBe("order-1234");
  });

  test("a task that fails throws TaskFailedError with its code", async () => {
    api.script.set("0192f3a4-7b1c-7d2e-9f10-000000000001", ["running", "failed"]);
    const failure = await client.solve(task, { intervalMs: 5 }).catch((error: unknown) => error);
    if (!(failure instanceof TaskFailedError))
      throw new Error(`not a TaskFailedError: ${String(failure)}`);
    expect(failure.code).toBe("ERROR_CAPTCHA_UNSOLVABLE");
    expect(failure.task.cost).toBe("0.000000");
  });

  test("a wait that runs out throws WaitTimeoutError with the task as it stood", async () => {
    const created = await client.createTask(task);
    api.script.set(created.id, ["running"]);
    const failure = await client
      .waitForResult(created.id, { timeoutMs: 30, intervalMs: 5 })
      .catch((error: unknown) => error);
    if (!(failure instanceof WaitTimeoutError))
      throw new Error(`not a WaitTimeoutError: ${String(failure)}`);
    expect(failure.task?.status).toBe("running");
  });

  test("a slow read does not carry the wait past its deadline", async () => {
    // Regression: the deadline was checked only after a read finished.
    const created = await client.createTask(task);
    api.readDelayMs = 2_000;
    const started = Date.now();
    const failure = await client
      .waitForResult(created.id, { timeoutMs: 100, intervalMs: 5 })
      .catch((error: unknown) => error);
    expect(Date.now() - started).toBeLessThan(1_000);
    if (!(failure instanceof WaitTimeoutError))
      throw new Error(`not a WaitTimeoutError: ${String(failure)}`);
    expect(failure.task).toBeUndefined();
    expect(failure.taskId).toBe(created.id);
  });

  test("a Retry-After longer than the time left ends the wait at once", async () => {
    const created = await client.createTask(task);
    api.script.set(created.id, ["running"]);
    api.refusals.push({ status: 429, code: "rate_limited", retryAfter: "5" });
    const started = Date.now();
    const failure = await client
      .waitForResult(created.id, { timeoutMs: 200, intervalMs: 5 })
      .catch((error: unknown) => error);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(failure).toBeInstanceOf(WaitTimeoutError);
  });
});

describe("the transport", () => {
  test("a 429 is retried after Retry-After, with the same idempotency key", async () => {
    api.refusals.push({ status: 429, code: "rate_limited", retryAfter: "0" });
    const created = await client.createTask(task);
    expect(created.status).toBe("queued");
    expect(api.seen).toHaveLength(2);
    expect(api.seen[1]?.headers["idempotency-key"]).toBe(api.seen[0]?.headers["idempotency-key"]);
  });

  test("an answer cut short is retried with the same key, and makes one task", async () => {
    // Regression: the body was read outside the retry, so a task the API made
    // surfaced as a raw error, and calling again made a second, paid task.
    api.cutBodies = 1;
    const created = await client.createTask(task);
    expect(created.status).toBe("queued");
    expect(api.seen).toHaveLength(2);
    expect(api.seen[1]?.headers["idempotency-key"]).toBe(api.seen[0]?.headers["idempotency-key"]);
    expect(api.tasks.size).toBe(1);
  });

  test("a refusal throws ZeroCaptchaError with the API's code and request ID", async () => {
    api.refusals.push({ status: 402, code: "insufficient_funds" });
    const failure = await client.createTask(task).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ZeroCaptchaError);
    expect(failure).toMatchObject({
      status: 402,
      code: "insufficient_funds",
      requestId: "req-1",
      message: "Refused: insufficient_funds.",
    });
    expect(api.seen).toHaveLength(1);
  });

  test("the balance is read with the key as a bearer token", async () => {
    await expect(client.getBalance()).resolves.toEqual({
      available: "14.100000",
      held: "0.000800",
      currency: "USD",
    });
    expect(api.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("a key or address that cannot be right is refused before any request", () => {
    expect(
      () => new ZeroCaptcha({ apiKey: "sk_test", baseUrl: "https://api.example.com" }),
    ).toThrow(TypeError);
    expect(() => new ZeroCaptcha({ apiKey: KEY, baseUrl: "api.example.com" })).toThrow(TypeError);
  });

  test("without a baseUrl, or with an empty one, it calls https://api.zerocaptcha.io", async () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.zerocaptcha.io");
    const urls: string[] = [];
    const fake: typeof fetch = async (input) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      return Response.json({ available: "1.000000", held: "0.000000", currency: "USD" });
    };
    await Promise.all(
      [undefined, ""].map((baseUrl) =>
        new ZeroCaptcha({ apiKey: KEY, baseUrl, fetch: fake }).getBalance(),
      ),
    );
    expect(urls).toEqual(Array(2).fill("https://api.zerocaptcha.io/v1/balance"));
  });
});

describe("callback signatures", () => {
  const secret = "zcsig_ExampleCallbackSecretShownToOwnersOnly0Z";
  const body = '{"id":"0192f3a4","status":"succeeded"}';
  const now = 1_790_000_000_000;
  const t = String(now / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

  test("a genuine call verifies, as text or as bytes", async () => {
    await expect(verifySignature(secret, `t=${t},v1=${v1}`, body, { now })).resolves.toBe(true);
    await expect(
      verifySignature(secret, `t=${t},v1=${v1}`, new TextEncoder().encode(body), { now }),
    ).resolves.toBe(true);
  });

  test("another body, secret or time, an old call or a malformed header does not", async () => {
    await expect(verifySignature(secret, `t=${t},v1=${v1}`, `${body} `, { now })).resolves.toBe(
      false,
    );
    await expect(verifySignature(`${secret}x`, `t=${t},v1=${v1}`, body, { now })).resolves.toBe(
      false,
    );
    await expect(
      verifySignature(secret, `t=${Number(t) + 1},v1=${v1}`, body, { now }),
    ).resolves.toBe(false);
    await expect(
      verifySignature(secret, `t=${t},v1=${v1}`, body, { now: now + 301_000 }),
    ).resolves.toBe(false);
    await expect(verifySignature(secret, "v1=abc", body, { now })).resolves.toBe(false);
    await expect(verifySignature(secret, undefined, body, { now })).resolves.toBe(false);
  });
});
