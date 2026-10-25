// easy-sign-send 的离线测试：用注入的假 fetch / 假 sleep 驱动真脚本，不联网。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASE64_MAX_BYTES,
  DEFAULT_BASE_URL,
  MAX_ATTEMPTS,
  buildRequestBody,
  classifyAttempt,
  main,
  readApiKey,
  resolveBaseUrl,
  resultsPathFor,
  rowIdempotencyKey,
  runSend,
  validatePlan,
} from '../plugins/easy-sign/skills/easy-sign-send/scripts/easy-sign-send.mjs';

const SCRIPT = fileURLToPath(
  new URL('../plugins/easy-sign/skills/easy-sign-send/scripts/easy-sign-send.mjs', import.meta.url),
);
const API_KEY = 'es_live_testkey_0123456789';
const SIGNING_URL = 'https://www.easy-sign.ca/sign/env-1?token=SECRET-SIGNER-TOKEN';
const ENV = { EASY_SIGN_API_KEY: API_KEY };

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-sign-send-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pdf(name, extra = '') {
  const path = join(dir, name);
  writeFileSync(path, `%PDF-1.4\n% fixture ${name} ${extra}\n%%EOF\n`);
  return name;
}

function row(overrides = {}) {
  return {
    name: 'Jane Smith',
    email: 'jane@example.com',
    file: pdf('jane.pdf'),
    envelope_name: '2026 Engagement Letter - Jane Smith',
    fields: [{ type: 'signature_date', page: 1, preset: 'signature_bottom_left' }],
    ...overrides,
  };
}

function writePlan(plan, name = 'plan.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(plan, null, 2));
  return path;
}

function response(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sentBody(n = 1) {
  return {
    success: true,
    envelope_id: `env-${n}`,
    signing_url: SIGNING_URL,
    expires_at: '2026-11-01T00:00:00.000Z',
    recipient_email: 'jane@example.com',
    sender_timezone: 'America/Toronto',
  };
}

/** 记账假 fetch：按顺序吐出预设回答（函数可读请求），并记下每次请求。 */
function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    // Response 的 body 只能读一次：重复用同一个预设回答时每次给一份副本
    return typeof answer === 'function' ? answer(calls.at(-1)) : answer.clone();
  };
  return { impl, calls };
}

function collector() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

const noSleep = async () => {};

function send(planPath, fetchImpl, { env = ENV, sleepImpl = noSleep, yes = true } = {}) {
  const out = collector();
  return runSend(planPath, { yes, env, log: out.log, fetchImpl, sleepImpl }).then((code) => ({
    code,
    lines: out.lines,
  }));
}

describe('validatePlan', () => {
  test('accepts a complete plan and normalizes the row', () => {
    const plan = { sender_timezone: 'America/Toronto', rows: [row()] };
    const result = validatePlan(plan, dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.senderTimezone, 'America/Toronto');
    assert.equal(result.rows[0].document.kind, 'file');
    assert.equal(result.rows[0].document.fileName, 'jane.pdf');
  });

  test('defaults the time zone to this computer', () => {
    const result = validatePlan({ rows: [row()] }, dir);
    assert.equal(result.senderTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  const cases = [
    ['bad email', { email: 'jane@example' }, /not a valid email/],
    ['no fields', { fields: [] }, /at least one field/],
    ['unknown field type', { fields: [{ type: 'initials', page: 1, preset: 'signature_footer' }] }, /type must be one of/],
    ['page zero', { fields: [{ type: 'signature', page: 0, preset: 'signature_footer' }] }, /page must be a whole number/],
    ['fractional page', { fields: [{ type: 'signature', page: 1.5, preset: 'signature_footer' }] }, /page must be a whole number/],
    ['both preset and position', { fields: [{ type: 'signature', page: 1, preset: 'signature_footer', position: { x: 1, y: 1, width: 10, height: 5 } }] }, /exactly one of "preset" or "position"/],
    ['neither preset nor position', { fields: [{ type: 'signature', page: 1 }] }, /exactly one of "preset" or "position"/],
    ['unknown preset', { fields: [{ type: 'signature', page: 1, preset: 'top_left' }] }, /preset must be one of/],
    ['x out of range', { fields: [{ type: 'signature', page: 1, position: { x: 101, y: 1, width: 10, height: 5 } }] }, /x and y must be between 0 and 100/],
    ['width too big', { fields: [{ type: 'signature', page: 1, position: { x: 1, y: 1, width: 51, height: 5 } }] }, /width must be 1-50/],
    ['height as text', { fields: [{ type: 'signature', page: 1, position: { x: 1, y: 1, width: 10, height: '5' } }] }, /width must be 1-50/],
    ['required not boolean', { fields: [{ type: 'signature', page: 1, preset: 'signature_footer', required: 'yes' }] }, /required must be true or false/],
    ['bad locale', { locale: 'FR' }, /locale must be one of/],
    ['envelope name too long', { envelope_name: 'x'.repeat(256) }, /longer than 255/],
    ['empty envelope name', { envelope_name: '  ' }, /envelope_name must be non-empty/],
    ['name too long', { name: 'x'.repeat(256) }, /name is longer than 255/],
    ['empty file name', { file_name: '' }, /file_name must be non-empty/],
    ['file name too long', { file_name: `${'x'.repeat(252)}.pdf` }, /file name is longer than 255/],
    ['missing file', { file: 'nope.pdf' }, /file not found/],
    ['file and url', { url: 'https://example.com/a.pdf' }, /exactly one of "file"/],
    ['plain http url', { file: undefined, url: 'http://example.com/a.pdf' }, /must start with https/],
    ['url with credentials', { file: undefined, url: 'https://u:p@example.com/a.pdf' }, /username or password/],
  ];
  for (const [label, overrides, pattern] of cases) {
    test(`rejects: ${label}`, () => {
      const result = validatePlan({ rows: [row(overrides)] }, dir);
      assert.ok(
        result.errors.some((e) => pattern.test(e)),
        `expected an error matching ${pattern}, got ${JSON.stringify(result.errors)}`,
      );
    });
  }

  test('rejects a file that is not a PDF', () => {
    writeFileSync(join(dir, 'notes.pdf'), 'hello');
    const result = validatePlan({ rows: [row({ file: 'notes.pdf' })] }, dir);
    assert.ok(result.errors.some((e) => /is not a PDF file/.test(e)));
  });

  test('rejects a local file over 3 MB and accepts exactly 3 MB', () => {
    const big = Buffer.alloc(BASE64_MAX_BYTES + 1, 0x20);
    big.write('%PDF-', 0, 'latin1');
    writeFileSync(join(dir, 'big.pdf'), big);
    const tooBig = validatePlan({ rows: [row({ file: 'big.pdf' })] }, dir);
    assert.ok(tooBig.errors.some((e) => /at most 3 MB/.test(e)));

    writeFileSync(join(dir, 'edge.pdf'), big.subarray(0, BASE64_MAX_BYTES));
    const edge = validatePlan({ rows: [row({ file: 'edge.pdf' })] }, dir);
    assert.deepEqual(edge.errors, []);
  });

  test('rejects an unknown time zone', () => {
    const result = validatePlan({ sender_timezone: 'America/Toronoto', rows: [row()] }, dir);
    assert.ok(result.errors.some((e) => /IANA time zone/.test(e)));
  });

  test('rejects a plan without rows', () => {
    assert.ok(validatePlan({ rows: [] }, dir).errors.length > 0);
    assert.ok(validatePlan([], dir).errors.length > 0);
  });

  test('warns about duplicates, missing names, boxes off the page and batches over 10', () => {
    const rows = [
      row(),
      row({ email: 'JANE@example.com' }),
      row({ name: undefined, email: 'sam@example.com' }),
      row({ email: 'lee@example.com', fields: [{ type: 'signature', page: 1, position: { x: 90, y: 95, width: 20, height: 10 } }] }),
    ];
    for (let i = 0; i < 8; i += 1) rows.push(row({ email: `p${i}@example.com` }));
    const result = validatePlan({ rows }, dir);
    assert.deepEqual(result.errors, []);
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /same signer and same document as row 1/);
    assert.match(warnings, /no signer name/);
    assert.match(warnings, /right edge/);
    assert.match(warnings, /bottom of the page/);
    assert.match(warnings, /10 a minute/);
  });

  test('url rows keep the url and take the file name from the path', () => {
    const result = validatePlan({ rows: [row({ file: undefined, url: 'https://example.com/docs/letter.pdf' })] }, dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].document.kind, 'url');
    assert.equal(result.rows[0].document.fileName, 'letter.pdf');
  });
});

describe('rowIdempotencyKey', () => {
  const base = () => validatePlan({ rows: [row()] }, dir).rows[0];

  test('is stable for the same plan, row and content', () => {
    assert.equal(rowIdempotencyKey('abcd1234', base(), 'UTC'), rowIdempotencyKey('abcd1234', base(), 'UTC'));
  });

  test('ignores email case', () => {
    const upper = validatePlan({ rows: [row({ email: 'Jane@Example.com' })] }, dir).rows[0];
    assert.equal(rowIdempotencyKey('p', base(), 'UTC'), rowIdempotencyKey('p', upper, 'UTC'));
  });

  test('changes with the plan id, the time zone and every part of the row', () => {
    const key = rowIdempotencyKey('p', base(), 'UTC');
    assert.notEqual(key, rowIdempotencyKey('q', base(), 'UTC'));
    assert.notEqual(key, rowIdempotencyKey('p', base(), 'America/Toronto'));
    const variants = [
      { email: 'other@example.com' },
      { name: 'Jane Q Smith' },
      { locale: 'fr' },
      { envelope_name: 'Another name' },
      { file_name: 'renamed.pdf' },
      { fields: [{ type: 'signature', page: 1, preset: 'signature_bottom_left' }] },
    ];
    for (const overrides of variants) {
      const changed = validatePlan({ rows: [row(overrides)] }, dir).rows[0];
      assert.notEqual(key, rowIdempotencyKey('p', changed, 'UTC'), JSON.stringify(overrides));
    }
    // 同名文件内容变了（换了一份 PDF）也必须是新键。row() 会重写 jane.pdf，所以先取行再改文件
    const sameRow = row();
    writeFileSync(join(dir, 'jane.pdf'), '%PDF-1.4\n% corrected\n');
    const corrected = validatePlan({ rows: [sameRow] }, dir).rows[0];
    assert.notEqual(key, rowIdempotencyKey('p', corrected, 'UTC'));
  });

  test('stays far under the 255-character server limit', () => {
    assert.ok(rowIdempotencyKey('abcd1234', base(), 'America/Argentina/ComodRivadavia').length < 64);
  });
});

describe('buildRequestBody', () => {
  test('sends the file as base64 and every planned value', () => {
    const r = validatePlan({ rows: [row({ locale: 'fr' })] }, dir).rows[0];
    const body = buildRequestBody(r, 'America/Toronto');
    assert.deepEqual(Object.keys(body).sort(), ['document', 'envelope_name', 'fields', 'recipient', 'sender_timezone']);
    assert.deepEqual(body.recipient, { email: 'jane@example.com', name: 'Jane Smith', locale: 'fr' });
    assert.equal(Buffer.from(body.document.base64, 'base64').toString(), readFileSync(join(dir, 'jane.pdf'), 'utf8'));
    assert.equal(body.document.file_name, 'jane.pdf');
    assert.equal(body.sender_timezone, 'America/Toronto');
  });

  test('omits name and locale when the plan has none', () => {
    const r = validatePlan({ rows: [row({ name: undefined, envelope_name: undefined })] }, dir).rows[0];
    const body = buildRequestBody(r, 'UTC');
    assert.deepEqual(body.recipient, { email: 'jane@example.com' });
    assert.equal('envelope_name' in body, false);
  });
});

describe('classifyAttempt', () => {
  const r = (status, json, retryAfter = Number.NaN) => ({ kind: 'response', status, json, retryAfter, replayed: false });
  const table = [
    ['201 success', r(201, { success: true }), 'sent'],
    ['201 unreadable body', r(201, null), 'retry'],
    ['429', r(429, { error: { code: 'RATE_LIMITED' } }, 7), 'retry'],
    ['409 in progress', r(409, { error: { code: 'IDEMPOTENCY_IN_PROGRESS' } }), 'retry'],
    ['401 database error', r(401, { error: { code: 'DATABASE_ERROR' } }), 'retry'],
    ['500', r(500, { error: { code: 'INTERNAL_ERROR' } }), 'retry'],
    ['502 html', r(502, null), 'retry'],
    ['network', { kind: 'network', message: 'ECONNRESET' }, 'retry'],
    ['401 bad key', r(401, { error: { code: 'INVALID_API_KEY' } }), 'fail'],
    ['403 pro', r(403, { error: { code: 'PRO_REQUIRED' } }), 'fail'],
    ['400', r(400, { error: { code: 'INVALID_EMAIL', message: 'bad' } }), 'fail'],
    ['413 from the platform', r(413, null), 'fail'],
    ['409 unreadable', r(409, null), 'retry'],
  ];
  for (const [label, attempt, outcome] of table) {
    test(`${label} -> ${outcome}`, () => {
      assert.equal(classifyAttempt(attempt, 1).outcome, outcome);
    });
  }

  test('429 waits Retry-After, capped, and 60 s without it', () => {
    assert.equal(classifyAttempt(r(429, null, 7), 1).delaySeconds, 7);
    assert.equal(classifyAttempt(r(429, null, 9999), 1).delaySeconds, 120);
    assert.equal(classifyAttempt(r(429, null), 1).delaySeconds, 60);
  });

  test('a failed attempt reports the server code, or the HTTP status', () => {
    assert.equal(classifyAttempt(r(400, { error: { code: 'INVALID_EMAIL' } }), 1).code, 'INVALID_EMAIL');
    assert.equal(classifyAttempt(r(413, null), 1).code, 'HTTP_413');
  });
});

describe('environment', () => {
  test('base URL defaults to Easy Sign and allows https overrides and localhost', () => {
    assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
    assert.equal(resolveBaseUrl({ EASY_SIGN_BASE_URL: 'https://staging.example.com/x' }), 'https://staging.example.com');
    assert.equal(resolveBaseUrl({ EASY_SIGN_BASE_URL: 'http://localhost:3100' }), 'http://localhost:3100');
    assert.throws(() => resolveBaseUrl({ EASY_SIGN_BASE_URL: 'http://example.com' }), /https/);
    assert.throws(() => resolveBaseUrl({ EASY_SIGN_BASE_URL: 'not a url' }), /not a valid URL/);
  });

  test('API key must be present and look like an Easy Sign key', () => {
    assert.throws(() => readApiKey({}), /not set/);
    assert.throws(() => readApiKey({ EASY_SIGN_API_KEY: 'sk-abc' }), /es_live_/);
    assert.equal(readApiKey({ EASY_SIGN_API_KEY: ` ${API_KEY}\n` }), API_KEY);
  });
});

describe('runSend', () => {
  test('refuses without --yes and makes no request', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code } = await send(plan, fake.impl, { yes: false });
    assert.equal(code, 2);
    assert.equal(fake.calls.length, 0);
  });

  test('refuses a plan with problems and makes no request', async () => {
    const plan = writePlan({ rows: [row({ email: 'nope' })] });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
  });

  test('refuses without an API key and makes no request', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(201, sentBody())]);
    await assert.rejects(send(plan, fake.impl, { env: {} }), /not set/);
    assert.equal(fake.calls.length, 0);
  });

  test('sends each row once, with auth, a key per row and the time zone', async () => {
    const plan = writePlan({
      sender_timezone: 'America/Toronto',
      rows: [row(), row({ email: 'sam@example.com', name: 'Sam Lee', file: pdf('sam.pdf') })],
    });
    let n = 0;
    const fake = fakeFetch([() => response(201, sentBody(++n))]);
    const { code, lines } = await send(plan, fake.impl);
    assert.equal(code, 0);
    assert.equal(fake.calls.length, 2);
    for (const call of fake.calls) {
      assert.equal(call.url, `${DEFAULT_BASE_URL}/api/agent/sign-request`);
      assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
      assert.match(call.headers['Idempotency-Key'], /^es-[0-9a-f]{8}-\d+-[0-9a-f]{24}$/);
      assert.equal(call.body.sender_timezone, 'America/Toronto');
    }
    assert.notEqual(fake.calls[0].headers['Idempotency-Key'], fake.calls[1].headers['Idempotency-Key']);
    assert.equal(fake.calls[1].body.recipient.email, 'sam@example.com');

    const saved = readFileSync(resultsPathFor(plan), 'utf8');
    const output = lines.join('\n');
    for (const text of [saved, output]) {
      assert.equal(text.includes('SECRET-SIGNER-TOKEN'), false, 'signing link leaked');
      assert.equal(text.includes('signing_url'), false, 'signing_url key leaked');
      assert.equal(text.includes(API_KEY), false, 'API key leaked');
    }
    const results = JSON.parse(saved);
    assert.deepEqual(results.rows.map((r) => [r.row, r.status, r.envelope_id]), [[1, 'sent', 'env-1'], [2, 'sent', 'env-2']]);
  });

  test('a second run skips rows already sent and makes no request', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl);
    const again = fakeFetch([response(201, sentBody(9))]);
    const { code, lines } = await send(plan, again.impl);
    assert.equal(code, 0);
    assert.equal(again.calls.length, 0);
    assert.match(lines.join('\n'), /already sent earlier \(envelope env-1\); skipped/);
  });

  test('refuses to resend a row that changed after it was sent', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl);
    writePlan({ rows: [row({ envelope_name: 'Edited after sending' })] });
    const again = fakeFetch([response(201, sentBody(2))]);
    const { code, lines } = await send(plan, again.impl);
    assert.equal(code, 1);
    assert.equal(again.calls.length, 0);
    assert.match(lines.join('\n'), /already sent .* has changed since/);
  });

  test('writes the plan id to disk before the first request', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([() => {
      assert.equal(existsSync(resultsPathFor(plan)), true);
      assert.match(JSON.parse(readFileSync(resultsPathFor(plan), 'utf8')).plan_id, /^[0-9a-f]{8}$/);
      return response(201, sentBody());
    }]);
    assert.equal((await send(plan, fake.impl)).code, 0);
  });

  test('waits Retry-After on 429 and retries with the same key', async () => {
    const plan = writePlan({ rows: [row()] });
    const sleeps = [];
    const fake = fakeFetch([response(429, { success: false, error: { code: 'RATE_LIMITED' } }, { 'retry-after': '7' }), response(201, sentBody())]);
    const { code } = await send(plan, fake.impl, { sleepImpl: async (ms) => sleeps.push(ms) });
    assert.equal(code, 0);
    assert.deepEqual(sleeps, [7000]);
    assert.equal(fake.calls[0].headers['Idempotency-Key'], fake.calls[1].headers['Idempotency-Key']);
  });

  test('reports a replay as already sent, not as a new send', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(201, sentBody(), { 'idempotent-replay': 'true' })]);
    const { lines } = await send(plan, fake.impl);
    assert.match(lines.join('\n'), /already sent by an earlier run \(no new email\)/);
    assert.match(lines.join('\n'), /Done: 0 sent now, 1 found already sent/);
  });

  test('stops at the first rejected row and sends nothing after it', async () => {
    const plan = writePlan({
      rows: [row(), row({ email: 'sam@example.com', file: pdf('sam.pdf') }), row({ email: 'lee@example.com', file: pdf('lee.pdf') })],
    });
    const fake = fakeFetch([
      response(201, sentBody(1)),
      response(400, { success: false, error: { code: 'INVALID_FIELD_POSITION', message: 'Field page 2 exceeds document page count (1)' } }),
      response(201, sentBody(3)),
    ]);
    const { code, lines } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 2);
    assert.match(lines.join('\n'), /not sent \(INVALID_FIELD_POSITION: Field page 2 exceeds/);
    const results = JSON.parse(readFileSync(resultsPathFor(plan), 'utf8'));
    assert.deepEqual(results.rows.map((r) => r.status), ['sent', 'failed']);

    // 改好那一行再跑：第 1 行跳过，第 2、3 行发出
    const after = fakeFetch([response(201, sentBody(2))]);
    const second = await send(plan, after.impl);
    assert.equal(second.code, 0);
    assert.deepEqual(after.calls.map((c) => c.body.recipient.email), ['sam@example.com', 'lee@example.com']);
  });

  test('a key or account problem says so instead of blaming the row', async () => {
    const plan = writePlan({ rows: [row()] });
    const keyProblem = await send(plan, fakeFetch([response(401, { success: false, error: { code: 'INVALID_API_KEY', message: 'API key is invalid or expired' } })]).impl);
    assert.equal(keyProblem.code, 1);
    assert.match(keyProblem.lines.join('\n'), /about the API key or the Easy Sign account, not this row/);
    const rowProblem = await send(plan, fakeFetch([response(400, { success: false, error: { code: 'SAME_EMAIL', message: 'Cannot send a signature request to your own account email' } })]).impl);
    assert.match(rowProblem.lines.join('\n'), /Fix this row/);
  });

  test('gives up as "unknown" after repeated network errors, and a rerun reuses the same key', async () => {
    const plan = writePlan({ rows: [row()] });
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    const calls = [];
    const failing = async (url, init) => {
      calls.push(init.headers['Idempotency-Key']);
      return down();
    };
    const { code, lines } = await send(plan, failing);
    assert.equal(code, 3);
    assert.equal(calls.length, MAX_ATTEMPTS);
    assert.match(lines.join('\n'), /may or may not have been sent/);
    assert.equal(JSON.parse(readFileSync(resultsPathFor(plan), 'utf8')).rows[0].status, 'unknown');

    const fake = fakeFetch([response(201, sentBody(), { 'idempotent-replay': 'true' })]);
    assert.equal((await send(plan, fake.impl)).code, 0);
    assert.equal(fake.calls[0].headers['Idempotency-Key'], calls[0]);
  });

  test('a persistent EMAIL_FAILED is reported as not sent', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(500, { success: false, error: { code: 'EMAIL_FAILED', message: 'Failed to send signature request email' } })]);
    const { code, lines } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, MAX_ATTEMPTS);
    assert.match(lines.join('\n'), /not sent \(EMAIL_FAILED/);
  });

  test('a persistent 409 is reported as unknown, never as failed', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(409, { success: false, error: { code: 'IDEMPOTENCY_IN_PROGRESS' } })]);
    const { code } = await send(plan, fake.impl);
    assert.equal(code, 3);
  });

  test('refuses to reuse a results file written for another server', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl, { env: { ...ENV, EASY_SIGN_BASE_URL: 'http://localhost:3100' } });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, lines } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(lines.join('\n'), /records sends to http:\/\/localhost:3100/);
  });

  test('flags a time zone the server did not use', async () => {
    const plan = writePlan({ sender_timezone: 'America/Vancouver', rows: [row()] });
    const { lines } = await send(plan, fakeFetch([response(201, { ...sentBody(), sender_timezone: 'UTC' })]).impl);
    assert.match(lines.join('\n'), /stamped dates in UTC, not America\/Vancouver/);
  });
});

describe('command line', () => {
  test('check validates without a key and sends nothing', async () => {
    const plan = writePlan({ rows: [row()] });
    const out = collector();
    assert.equal(await main(['check', plan], {}, out.log), 0);
    assert.match(out.lines.join('\n'), /Nothing has been sent/);
  });

  test('check fails on a broken plan', async () => {
    const plan = writePlan({ rows: [row({ email: 'x' })] });
    assert.equal(await main(['check', plan], {}, collector().log), 1);
  });

  test('rejects unknown commands and options', async () => {
    const plan = writePlan({ rows: [row()] });
    assert.equal(await main(['send', plan, '--force'], ENV, collector().log), 2);
    assert.equal(await main(['check', plan, '--yes'], ENV, collector().log), 2);
    assert.equal(await main(['upload', plan], ENV, collector().log), 2);
    assert.equal(await main([], ENV, collector().log), 2);
    assert.equal(await main(['--help'], ENV, collector().log), 0);
  });

  test('send without --yes from the command line sends nothing', async () => {
    const plan = writePlan({ rows: [row()] });
    assert.equal(await main(['send', plan], ENV, collector().log), 2);
  });

  test('runs when started through a symlink, as in ~/.agents/skills', () => {
    const link = join(dir, 'linked-send.mjs');
    symlinkSync(SCRIPT, link);
    const output = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.match(output, /Usage:/);
  });

  test('the shipped example plan passes check', async () => {
    const example = fileURLToPath(new URL('../examples/signature-plan.json', import.meta.url));
    const out = collector();
    assert.equal(await main(['check', example], {}, out.log), 0, out.lines.join('\n'));
  });
});

test('the file hash used for duplicate detection is the PDF sha256', () => {
  const r = validatePlan({ rows: [row()] }, dir).rows[0];
  assert.equal(r.document.sha256, createHash('sha256').update(readFileSync(join(dir, 'jane.pdf'))).digest('hex'));
});
