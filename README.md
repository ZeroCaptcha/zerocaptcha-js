<!-- zc:header (generated from the registry; edit repos/registry.json) -->
# ZeroCaptcha SDK for JavaScript and TypeScript

[![CI](https://github.com/ZeroCaptcha/zerocaptcha-js/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeroCaptcha/zerocaptcha-js/actions/workflows/ci.yml)

The official ZeroCaptcha client for JavaScript and TypeScript: solve Cloudflare Turnstile and Cloudflare challenge pages, wait for results, read the balance and verify callback signatures. No dependencies; Node.js 20+, Deno, Bun and browsers.

[Website](https://zerocaptcha.io/docs/sdks/node) · [Docs](https://zerocaptcha.io/docs) · [Quickstart](https://zerocaptcha.io/docs/quickstart) · [API reference](https://zerocaptcha.io/docs/reference/api) · [Pricing](https://zerocaptcha.io/pricing)
<!-- /zc:header -->

## What it does

`@zerocaptcha/sdk` is the official ZeroCaptcha client for JavaScript and TypeScript. It creates a Cloudflare Turnstile task or a Cloudflare challenge page's task, waits for the result, reads your balance, and checks a task callback's signature. It has no dependencies and runs in Node.js 20 and later, Deno, Bun and browsers (keep your API key on a server, though).

Every task is real and paid from your prepaid balance, and only a task that succeeds is charged.

## Install

```sh
npm install @zerocaptcha/sdk
```

<!-- zc:include packages/sdk-js/README.md sections="Use|Cloudflare challenge pages|Callbacks" -->
## Use

Give the client your API key (`zc_live_…`, from the dashboard's API keys page) and the API's
address, `https://api.zerocaptcha.io`, which is also its default when the address is empty. Keep
both in your environment rather than in your code.

```ts
import { TaskFailedError, ZeroCaptcha } from "@zerocaptcha/sdk";

const client = new ZeroCaptcha({
  apiKey: process.env.ZEROCAPTCHA_KEY!,
  baseUrl: process.env.ZEROCAPTCHA_API!,
});

// Create a task and wait for its token: one call.
try {
  const token = await client.solve({
    websiteURL: "https://shop.example.com/login", // the page with the widget
    websiteKey: "0x4AAAAAAAB1cD2eF3gH4iJ5", // its data-sitekey
    // The widget's data-action and data-cdata, or the action and cData options of
    // turnstile.render(). Leave out any the widget does not set.
    action: "login",
    cdata: "session-7f3a9c2e",
    // proxy: "http://user:pass@proxy.example.net:8080", // to solve through your own proxy
    // callbackUrl: "https://hooks.example.com/zerocaptcha", // to be called when it ends
  });
  console.log(token);
} catch (error) {
  if (error instanceof TaskFailedError) console.log(error.code); // such as ERROR_CAPTCHA_UNSOLVABLE
  else throw error;
}

// Or step by step.
const task = await client.createTask(
  {
    websiteURL: "https://shop.example.com/login",
    websiteKey: "0x4AAAAAAAB1cD2eF3gH4iJ5",
    action: "login", // the widget's data-action, if it sets one
    cdata: "session-7f3a9c2e", // the widget's data-cdata, if it sets one
  },
  // Your ID for this task, sent as the Idempotency-Key; one is made for you when you give none.
  { idempotencyKey: "login-2026-10-01-0001" },
);
const done = await client.waitForResult(task.id, { timeoutMs: 120_000 });
console.log(done.solution?.token, done.cost);

// Your balance, in US dollars.
const { available } = await client.getBalance();
```

- A task with `proxy` (such as `http://user:pass@proxy.example.net:8080`) is solved through your
  proxy.
- `createTask` sends an `Idempotency-Key` with every call, one of its own unless you give yours, so
  retrying it never makes a second task.
- A request the API asks you to slow down (429) or cannot serve for a moment (502, 503, 504) is
  tried again after the wait it asks for, three times in all, as is one that got no answer or an
  answer cut short, with the same `Idempotency-Key`. Any other refusal throws a
  `ZeroCaptchaError` with the API's `code`, such as `insufficient_funds`, and its `requestId`.
- `waitForResult` asks every 2 seconds for up to 3 minutes, and never runs past `timeoutMs`: a
  slow read is cut off, and a retry that would wait longer than the time left is not made. A task
  that fails or expires throws `TaskFailedError`, and nothing is charged; a wait that runs out
  throws `WaitTimeoutError`, with the task as last read (`task`, undefined if no read finished in
  time), and you can wait again.

## Cloudflare challenge pages

A challenge page ("Just a moment…") is passed through your proxy, and gives the `cf_clearance`
cookie with the user agent it is bound to. Send both, through the same proxy:

```ts
const { cfClearance, userAgent } = await client.solveChallenge({
  websiteURL: "https://shop.example.com/",
  proxy: process.env.PROXY_URL!, // such as http://user:pass@proxy.example.net:8080
});
```

`createChallengeTask` creates the task alone, for `waitForResult`. A challenge task always needs a
proxy: a clearance works only from the address that earned it.

## Callbacks

A task that names `callbackUrl` is POSTed to it once it ends, with the task as JSON. Each call
carries `ZeroCaptcha-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of `<t>.<body>` under
your callback secret (`zcsig_…`, on the dashboard's API keys page, for owners). Check it against
the raw body, before you parse it:

```ts
import { verifySignature } from "@zerocaptcha/sdk";

const genuine = await verifySignature(
  process.env.ZEROCAPTCHA_CALLBACK_SECRET!,
  request.headers.get("zerocaptcha-signature"),
  rawBody,
);
if (!genuine) return new Response(null, { status: 401 });
```

A call older than five minutes does not verify, so a recorded call cannot be replayed. Answer 2xx
once you have it; any other answer is retried with backoff, eight attempts in all over
roughly 65 to 95 minutes, with the same `ZeroCaptcha-Delivery` ID on every attempt.
<!-- /zc:include -->

## FAQ

**Which API does it call?**
ZeroCaptcha's REST API: `POST /v1/tasks`, `GET /v1/tasks/{id}` and `GET /v1/balance`. The [API reference](https://zerocaptcha.io/docs/reference/api) documents every field and error.

**Does it retry, and can a retry cost twice?**
It retries what a retry can fix (429, 502, 503, 504, and requests that got no answer), with the same `Idempotency-Key`, so a retried create returns the first task instead of making a second.

**Where are examples?**
The [Node.js and TypeScript example](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-nodejs) and the [Playwright](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-playwright) and [Puppeteer](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-puppeteer) examples, and the [SDK's page](https://zerocaptcha.io/docs/sdks/node) in the docs.

**What does a solve cost?**
The [pricing page](https://zerocaptcha.io/pricing) lists the price per 1,000 solved tasks. Only a task that succeeds is charged.

## Develop

```sh
npm install
npm run typecheck
npm test        # against a stand-in API on your machine
npm run build   # dist/, as published
```

This repository is a mirror of the SDK as it is developed in ZeroCaptcha's main repository, copied here on every release. Issues and pull requests are welcome here; an accepted change is made upstream and comes back with the next release.

<!-- zc:footer (generated from the registry) -->
## More from ZeroCaptcha

- The website: [ZeroCaptcha](https://zerocaptcha.io), the [docs](https://zerocaptcha.io/docs), the [guides](https://zerocaptcha.io/guides), the [blog](https://zerocaptcha.io/blog) and the [status page](https://zerocaptcha.io/status)
- Start here: [zerocaptcha](https://github.com/ZeroCaptcha/zerocaptcha), [cloudflare-turnstile-solver](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver), [cloudflare-challenge-solver](https://github.com/ZeroCaptcha/cloudflare-challenge-solver)
- Examples by language: [cloudflare-turnstile-solver-python](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-python), [cloudflare-turnstile-solver-nodejs](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-nodejs), [cloudflare-turnstile-solver-go](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-go), [cloudflare-turnstile-solver-php](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-php), [cloudflare-turnstile-solver-java](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-java), [cloudflare-turnstile-solver-csharp](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-csharp), [cloudflare-turnstile-solver-rust](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-rust)
- Browser automation: [cloudflare-turnstile-solver-playwright](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-playwright), [cloudflare-turnstile-solver-puppeteer](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-puppeteer), [cloudflare-turnstile-solver-selenium](https://github.com/ZeroCaptcha/cloudflare-turnstile-solver-selenium)
- SDKs, MCP server and migration: **zerocaptcha-js**, [zerocaptcha-python](https://github.com/ZeroCaptcha/zerocaptcha-python), [zerocaptcha-go](https://github.com/ZeroCaptcha/zerocaptcha-go), [zerocaptcha-mcp](https://github.com/ZeroCaptcha/zerocaptcha-mcp), [createtask-api-migration](https://github.com/ZeroCaptcha/createtask-api-migration)
- Lists: [awesome-cloudflare-turnstile](https://github.com/ZeroCaptcha/awesome-cloudflare-turnstile)

## Licence

MIT: see [LICENSE](LICENSE).

## Disclaimer

ZeroCaptcha is an independent service, not affiliated with or endorsed by Cloudflare. Cloudflare and Turnstile are trademarks of Cloudflare, Inc. Use ZeroCaptcha only on sites you own or are allowed to automate, as the [Acceptable Use Policy](https://zerocaptcha.io/legal/acceptable-use) says; any site owner can [opt out](https://zerocaptcha.io/opt-out).
<!-- /zc:footer -->
