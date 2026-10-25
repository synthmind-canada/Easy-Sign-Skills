// easy-sign-send 的离线测试：用注入的假 fetch / 假 sleep / 假时钟驱动真脚本，不联网。
// 每次 runSend 之后，send() 都会扫一遍输出与结果文件，确认签署链接与 API key 没有漏出去。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  BASE64_MAX_BYTES,
  DEFAULT_BASE_URL,
  MAX_ATTEMPTS,
  UNRESOLVED_RETRY_HOURS,
  apiKeyFingerprint,
  buildRequestBody,
  classifyAttempt,
  main,
  planFingerprint,
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
const OTHER_KEY = 'es_live_otherkey_9876543210';
const SIGNING_URL = 'https://www.easy-sign.ca/sign/env-1?token=SECRET-SIGNER-TOKEN';
const ENV = { EASY_SIGN_API_KEY: API_KEY };
const TZ = 'America/Toronto';
const HOUR = 3600 * 1000;

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

const vp = (rows, extra = {}) => validatePlan({ sender_timezone: TZ, rows, ...extra }, dir);

function writePlan(plan, name = 'plan.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ sender_timezone: TZ, ...plan }, null, 2));
  return path;
}

function fingerprintOf(planPath) {
  const result = validatePlan(JSON.parse(readFileSync(planPath, 'utf8')), dirname(planPath));
  return planFingerprint(result.rows, result.senderTimezone);
}

function readResults(planPath) {
  return JSON.parse(readFileSync(resultsPathFor(planPath), 'utf8'));
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
    sender_timezone: TZ,
  };
}

const failure = (status, code, message = 'rejected') => response(status, { success: false, error: { code, message } });
const networkDown = () => {
  throw new TypeError('fetch failed');
};

/** 记账假 fetch：按顺序吐出预设回答（函数可读请求或抛网络错误），并记下每次请求。 */
function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    // Response 的 body 只能读一次：重复用同一个预设回答时每次给一份副本
    return typeof answer === 'function' ? answer(calls.at(-1)) : answer.clone();
  };
  return { impl, calls, keys: () => calls.map((c) => c.headers['Idempotency-Key']) };
}

function collector() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)) };
}

const noSleep = async () => {};

function assertNoLeak(text, where) {
  assert.equal(text.includes('SECRET-SIGNER-TOKEN'), false, `signing link leaked in ${where}`);
  assert.equal(text.includes('signing_url'), false, `signing_url key leaked in ${where}`);
  for (const key of [API_KEY, OTHER_KEY]) assert.equal(text.includes(key), false, `API key leaked in ${where}`);
}

async function send(planPath, fetchImpl, { env = ENV, sleepImpl = noSleep, approve, now } = {}) {
  const out = collector();
  const options = { approve: approve === undefined ? fingerprintOf(planPath) : approve, env, log: out.log, fetchImpl, sleepImpl };
  if (now) options.now = now;
  try {
    const code = await runSend(planPath, options);
    return { code, lines: out.lines, text: out.lines.join('\n') };
  } finally {
    assertNoLeak(out.lines.join('\n'), 'the output');
    if (existsSync(resultsPathFor(planPath))) assertNoLeak(readFileSync(resultsPathFor(planPath), 'utf8'), 'the results file');
  }
}

describe('validatePlan', () => {
  test('accepts a complete plan and normalizes the row', () => {
    const result = vp([row()]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.senderTimezone, TZ);
    assert.equal(result.rows[0].document.kind, 'file');
    assert.equal(result.rows[0].document.fileName, 'jane.pdf');
  });

  test('requires a time zone and suggests this computer\'s', () => {
    const result = validatePlan({ rows: [row()] }, dir);
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.ok(result.errors.some((e) => e.includes('sender_timezone is missing') && e.includes(here)));
    assert.equal(result.senderTimezone, null);
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
      const result = vp([row(overrides)]);
      assert.ok(
        result.errors.some((e) => pattern.test(e)),
        `expected an error matching ${pattern}, got ${JSON.stringify(result.errors)}`,
      );
    });
  }

  test('rejects a file that is not a PDF', () => {
    writeFileSync(join(dir, 'notes.pdf'), 'hello');
    assert.ok(vp([row({ file: 'notes.pdf' })]).errors.some((e) => /is not a PDF file/.test(e)));
  });

  test('rejects a local file over 3 MB and accepts exactly 3 MB', () => {
    const big = Buffer.alloc(BASE64_MAX_BYTES + 1, 0x20);
    big.write('%PDF-', 0, 'latin1');
    writeFileSync(join(dir, 'big.pdf'), big);
    assert.ok(vp([row({ file: 'big.pdf' })]).errors.some((e) => /at most 3 MB/.test(e)));

    writeFileSync(join(dir, 'edge.pdf'), big.subarray(0, BASE64_MAX_BYTES));
    assert.deepEqual(vp([row({ file: 'edge.pdf' })]).errors, []);
  });

  test('rejects an unknown time zone', () => {
    const result = vp([row()], { sender_timezone: 'America/Toronoto' });
    assert.ok(result.errors.some((e) => /IANA time zone/.test(e)));
  });

  test('rejects a plan without rows', () => {
    assert.ok(vp([]).errors.length > 0);
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
    const result = vp(rows);
    assert.deepEqual(result.errors, []);
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /same signer and same document as row 1/);
    assert.match(warnings, /no signer name; Easy Sign will use the part of the email before the @/);
    assert.match(warnings, /right edge/);
    assert.match(warnings, /bottom of the page/);
    assert.match(warnings, /10 a minute/);
  });

  test('url rows keep the url and take the file name from the path', () => {
    const result = vp([row({ file: undefined, url: 'https://example.com/docs/letter.pdf' })]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].document.kind, 'url');
    assert.equal(result.rows[0].document.fileName, 'letter.pdf');
  });
});

describe('rowIdempotencyKey', () => {
  const base = () => vp([row()]).rows[0];

  test('is stable for the same plan, row and content', () => {
    assert.equal(rowIdempotencyKey('abcd1234', base(), 'UTC'), rowIdempotencyKey('abcd1234', base(), 'UTC'));
  });

  // 钉死一个字面值：键里混进任何「每次运行都不同」的值（进程号、随机数、时间），这里就红。
  // 只比较两个键是否相等的测试都在同一个进程里，看不见这种破坏
  test('is exactly the documented value for a fixed row', () => {
    writeFileSync(join(dir, 'fixed.pdf'), '%PDF-1.4\n% fixed fixture\n%%EOF\n');
    const fixed = vp([{ name: 'Jane Smith', email: 'Jane@Example.com', file: 'fixed.pdf', envelope_name: 'Letter', fields: [{ type: 'signature_date', page: 1, preset: 'signature_bottom_left' }] }]);
    assert.equal(rowIdempotencyKey('abcd1234', fixed.rows[0], fixed.senderTimezone), 'es-abcd1234-1-1724e58f7d2dcfa527c5d99b');
    assert.equal(planFingerprint(fixed.rows, fixed.senderTimezone), '260c8eca79a3');
  });

  test('ignores email case', () => {
    const upper = vp([row({ email: 'Jane@Example.com' })]).rows[0];
    assert.equal(rowIdempotencyKey('p', base(), 'UTC'), rowIdempotencyKey('p', upper, 'UTC'));
  });

  test('changes with the plan id, the time zone and every part of the row', () => {
    const key = rowIdempotencyKey('p', base(), 'UTC');
    assert.notEqual(key, rowIdempotencyKey('q', base(), 'UTC'));
    assert.notEqual(key, rowIdempotencyKey('p', base(), TZ));
    const variants = [
      { email: 'other@example.com' },
      { name: 'Jane Q Smith' },
      { locale: 'fr' },
      { envelope_name: 'Another name' },
      { file_name: 'renamed.pdf' },
      { fields: [{ type: 'signature', page: 1, preset: 'signature_bottom_left' }] },
    ];
    for (const overrides of variants) {
      assert.notEqual(key, rowIdempotencyKey('p', vp([row(overrides)]).rows[0], 'UTC'), JSON.stringify(overrides));
    }
    // 同名文件内容变了（换了一份 PDF）也必须是新键。row() 会重写 jane.pdf，所以先取行再改文件
    const sameRow = row();
    writeFileSync(join(dir, 'jane.pdf'), '%PDF-1.4\n% corrected\n');
    assert.notEqual(key, rowIdempotencyKey('p', vp([sameRow]).rows[0], 'UTC'));
  });

  test('stays far under the 255-character server limit', () => {
    assert.ok(rowIdempotencyKey('abcd1234', base(), 'America/Argentina/ComodRivadavia').length < 64);
  });
});

describe('planFingerprint', () => {
  test('is the same for the same plan and changes with any part of it', () => {
    const fp = (rows, tz = TZ) => planFingerprint(vp(rows).rows, tz);
    const original = fp([row()]);
    assert.equal(original, fp([row()]));
    assert.match(original, /^[0-9a-f]{12}$/);
    assert.notEqual(original, fp([row()], 'UTC'));
    assert.notEqual(original, fp([row({ email: 'Jane@example.com' })]), 'email case is part of what is sent');
    assert.notEqual(original, fp([row(), row({ email: 'sam@example.com' })]));
    assert.notEqual(original, fp([row({ fields: [{ type: 'signature', page: 1, preset: 'signature_bottom_left' }] })]));
    const sameRow = row();
    writeFileSync(join(dir, 'jane.pdf'), '%PDF-1.4\n% replaced after approval\n');
    assert.notEqual(original, fp([sameRow]));
  });
});

describe('buildRequestBody', () => {
  test('sends the file as base64 and every planned value', () => {
    const r = vp([row({ locale: 'fr' })]).rows[0];
    const body = buildRequestBody(r, TZ);
    assert.deepEqual(Object.keys(body).sort(), ['document', 'envelope_name', 'fields', 'recipient', 'sender_timezone']);
    assert.deepEqual(body.recipient, { email: 'jane@example.com', name: 'Jane Smith', locale: 'fr' });
    assert.equal(Buffer.from(body.document.base64, 'base64').toString(), readFileSync(join(dir, 'jane.pdf'), 'utf8'));
    assert.equal(body.document.file_name, 'jane.pdf');
    assert.equal(body.sender_timezone, TZ);
  });

  test('omits name and locale when the plan has none', () => {
    const body = buildRequestBody(vp([row({ name: undefined, envelope_name: undefined })]).rows[0], 'UTC');
    assert.deepEqual(body.recipient, { email: 'jane@example.com' });
    assert.equal('envelope_name' in body, false);
  });
});

describe('classifyAttempt', () => {
  const r = (status, json, retryAfter = Number.NaN) => ({ kind: 'response', status, json, retryAfter, replayed: false });
  // [标签, 尝试, 结果, 是否可能已发信]
  const table = [
    ['201 success', r(201, { success: true }), 'sent'],
    ['201 unreadable body', r(201, null), 'retry', true],
    ['429', r(429, { error: { code: 'RATE_LIMITED' } }, 7), 'retry', false],
    ['409 in progress', r(409, { error: { code: 'IDEMPOTENCY_IN_PROGRESS' } }), 'retry', true],
    ['409 unreadable', r(409, null), 'retry', true],
    ['401 database error', r(401, { error: { code: 'DATABASE_ERROR' } }), 'retry', false],
    ['500', r(500, { error: { code: 'INTERNAL_ERROR' } }), 'retry', true],
    ['502 html', r(502, null), 'retry', true],
    ['network', { kind: 'network', message: 'ECONNRESET' }, 'retry', true],
    ['500 EMAIL_FAILED', r(500, { error: { code: 'EMAIL_FAILED' } }), 'fail'],
    ['401 bad key', r(401, { error: { code: 'INVALID_API_KEY' } }), 'fail'],
    ['403 pro', r(403, { error: { code: 'PRO_REQUIRED' } }), 'fail'],
    ['400', r(400, { error: { code: 'INVALID_EMAIL', message: 'bad' } }), 'fail'],
    ['413 from the platform', r(413, null), 'fail'],
  ];
  for (const [label, attempt, outcome, uncertain] of table) {
    test(`${label} -> ${outcome}${uncertain === undefined ? '' : uncertain ? ' (may have sent)' : ' (before anything happened)'}`, () => {
      const verdict = classifyAttempt(attempt, 1);
      assert.equal(verdict.outcome, outcome);
      if (uncertain !== undefined) assert.equal(verdict.uncertain, uncertain);
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

  test('the key fingerprint tells keys apart without containing the key', () => {
    assert.match(apiKeyFingerprint(API_KEY), /^[0-9a-f]{12}$/);
    assert.notEqual(apiKeyFingerprint(API_KEY), apiKeyFingerprint(OTHER_KEY));
    assert.equal(API_KEY.includes(apiKeyFingerprint(API_KEY)), false);
  });
});

describe('runSend: approval', () => {
  test('refuses without --approve and makes no request', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code } = await send(plan, fake.impl, { approve: null });
    assert.equal(code, 2);
    assert.equal(fake.calls.length, 0);
  });

  test('refuses when the plan changed after it was approved', async () => {
    const plan = writePlan({ rows: [row()] });
    const approved = fingerprintOf(plan);
    writePlan({ rows: [row({ email: 'someone.else@example.com' })] });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, text } = await send(plan, fake.impl, { approve: approved });
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /changed since it was approved/);
  });

  test('refuses when a PDF was replaced after it was approved', async () => {
    const plan = writePlan({ rows: [row()] });
    const approved = fingerprintOf(plan);
    writeFileSync(join(dir, 'jane.pdf'), '%PDF-1.4\n% another client\'s letter\n');
    const fake = fakeFetch([response(201, sentBody())]);
    assert.equal((await send(plan, fake.impl, { approve: approved })).code, 1);
    assert.equal(fake.calls.length, 0);
  });

  test('refuses a plan with problems and makes no request', async () => {
    const plan = writePlan({ rows: [row({ email: 'nope' })] });
    const fake = fakeFetch([response(201, sentBody())]);
    // 用这份计划自己的指纹：负例只许被「计划有问题」这一道闸拦下，不许被指纹闸顺手拦掉
    assert.equal((await send(plan, fake.impl)).code, 1);
    assert.equal(fake.calls.length, 0);
  });

  test('refuses without an API key and makes no request', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(201, sentBody())]);
    await assert.rejects(send(plan, fake.impl, { env: {} }), /not set/);
    assert.equal(fake.calls.length, 0);
  });
});

describe('runSend: sending', () => {
  test('sends each row once, with auth, a key per row and the time zone', async () => {
    const plan = writePlan({ rows: [row(), row({ email: 'sam@example.com', name: 'Sam Lee', file: pdf('sam.pdf') })] });
    let n = 0;
    const fake = fakeFetch([() => response(201, sentBody(++n))]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 0);
    assert.equal(fake.calls.length, 2);
    for (const call of fake.calls) {
      assert.equal(call.url, `${DEFAULT_BASE_URL}/api/agent/sign-request`);
      assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
      assert.match(call.headers['Idempotency-Key'], /^es-[0-9a-f]{8}-\d+-[0-9a-f]{24}$/);
      assert.equal(call.body.sender_timezone, TZ);
    }
    assert.notEqual(fake.keys()[0], fake.keys()[1]);
    assert.equal(fake.calls[1].body.recipient.email, 'sam@example.com');
    assert.deepEqual(readResults(plan).rows.map((r) => [r.row, r.status, r.envelope_id]), [[1, 'sent', 'env-1'], [2, 'sent', 'env-2']]);
    assert.match(text, /Summary: 2 sent now, 0 already sent before, 0 not sent, 0 may have been sent, 0 not tried yet/);
  });

  test('writes the plan id and a pending record before each request', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([(call) => {
      const results = readResults(plan);
      assert.match(results.plan_id, /^[0-9a-f]{8}$/);
      const record = results.rows[0];
      assert.equal(record.status, 'pending');
      assert.equal(record.idempotency_key, call.headers['Idempotency-Key']);
      assert.equal(record.api_key_fp, apiKeyFingerprint(API_KEY));
      assert.ok(Date.parse(record.first_attempt_at) > 0);
      return response(201, sentBody());
    }]);
    assert.equal((await send(plan, fake.impl)).code, 0);
    assert.equal(fake.calls.length, 1);
    assert.equal(readResults(plan).rows[0].status, 'sent');
  });

  test('a second run skips rows already sent and makes no request', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl);
    const again = fakeFetch([response(201, sentBody(9))]);
    const { code, text } = await send(plan, again.impl);
    assert.equal(code, 0);
    assert.equal(again.calls.length, 0);
    assert.match(text, /already sent \(envelope env-1\); skipped/);
  });

  test('refuses to resend a row that changed after it was sent, even with the new plan approved', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl);
    writePlan({ rows: [row({ envelope_name: 'Edited after sending' })] });
    const again = fakeFetch([response(201, sentBody(2))]);
    const { code, text } = await send(plan, again.impl);
    assert.equal(code, 1);
    assert.equal(again.calls.length, 0);
    assert.match(text, /already sent .* has changed since/);
  });

  test('waits Retry-After on 429 and retries with the same key', async () => {
    const plan = writePlan({ rows: [row()] });
    const sleeps = [];
    const fake = fakeFetch([response(429, { success: false, error: { code: 'RATE_LIMITED' } }, { 'retry-after': '7' }), response(201, sentBody())]);
    assert.equal((await send(plan, fake.impl, { sleepImpl: async (ms) => sleeps.push(ms) })).code, 0);
    assert.deepEqual(sleeps, [7000]);
    assert.equal(fake.keys()[0], fake.keys()[1]);
  });

  test('a replay on the first try is reported as sent by an earlier run', async () => {
    const plan = writePlan({ rows: [row()] });
    const { text } = await send(plan, fakeFetch([response(201, sentBody(), { 'idempotent-replay': 'true' })]).impl);
    assert.match(text, /already sent by an earlier run \(no new email\)/);
    assert.match(text, /Summary: 0 sent now, 1 already sent before/);
  });

  test('a replay after an unclear try in the same run is this run\'s send', async () => {
    const plan = writePlan({ rows: [row()] });
    const { code, text } = await send(plan, fakeFetch([networkDown, response(201, sentBody(), { 'idempotent-replay': 'true' })]).impl);
    assert.equal(code, 0);
    assert.match(text, /: sent; envelope env-1/);
    assert.match(text, /Summary: 1 sent now, 0 already sent before/);
  });

  test('stops at the first rejected row, says what was not tried, and resumes', async () => {
    const plan = writePlan({
      rows: [row(), row({ email: 'sam@example.com', file: pdf('sam.pdf') }), row({ email: 'lee@example.com', file: pdf('lee.pdf') })],
    });
    const fake = fakeFetch([
      response(201, sentBody(1)),
      failure(400, 'INVALID_FIELD_POSITION', 'Field page 2 exceeds document page count (1)'),
      response(201, sentBody(3)),
    ]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 2);
    assert.match(text, /not sent \(INVALID_FIELD_POSITION: Field page 2 exceeds/);
    assert.match(text, /Nothing was sent for this row/);
    assert.match(text, /Summary: 1 sent now, 0 already sent before, 1 not sent, 0 may have been sent, 1 not tried yet/);
    assert.deepEqual(readResults(plan).rows.map((r) => r.status), ['sent', 'failed']);

    const after = fakeFetch([response(201, sentBody(2))]);
    assert.equal((await send(plan, after.impl)).code, 0);
    assert.deepEqual(after.calls.map((c) => c.body.recipient.email), ['sam@example.com', 'lee@example.com']);
  });

  test('a key or account problem says so instead of blaming the row', async () => {
    const plan = writePlan({ rows: [row()] });
    const keyProblem = await send(plan, fakeFetch([failure(401, 'INVALID_API_KEY', 'API key is invalid or expired')]).impl);
    assert.equal(keyProblem.code, 1);
    assert.match(keyProblem.text, /about the API key or the Easy Sign account, not this row/);
    const rowProblem = await send(plan, fakeFetch([failure(400, 'SAME_EMAIL', 'Cannot send to your own account email')]).impl);
    assert.match(rowProblem.text, /Fix this row/);
  });

  test('EMAIL_FAILED is not retried and is reported as not sent', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([failure(500, 'EMAIL_FAILED', 'Failed to send signature request email')]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 1);
    assert.match(text, /not sent \(EMAIL_FAILED/);
    assert.match(text, /removed the envelope/);
  });

  test('being rate-limited on every try is reported as not sent, not as maybe sent', async () => {
    const plan = writePlan({ rows: [row()] });
    const fake = fakeFetch([response(429, { success: false, error: { code: 'RATE_LIMITED' } }, { 'retry-after': '1' })]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, MAX_ATTEMPTS);
    assert.match(text, /not sent \(RATE_LIMITED/);
    assert.match(text, /Easy Sign was busy/);
  });

  test('flags a time zone the server did not use', async () => {
    const plan = writePlan({ sender_timezone: 'America/Vancouver', rows: [row()] });
    const { text } = await send(plan, fakeFetch([response(201, { ...sentBody(), sender_timezone: 'UTC' })]).impl);
    assert.match(text, /stamped dates in UTC, not America\/Vancouver/);
  });

  test('refuses to reuse a results file written for another server', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl, { env: { ...ENV, EASY_SIGN_BASE_URL: 'http://localhost:3100' } });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /records sends to http:\/\/localhost:3100/);
  });
});

describe('runSend: rows that may have been sent', () => {
  test('gives up as "may have been sent" after repeated network errors, and a rerun reuses the same key', async () => {
    const plan = writePlan({ rows: [row()] });
    const first = fakeFetch([networkDown]);
    const { code, text } = await send(plan, first.impl);
    assert.equal(code, 3);
    assert.equal(first.calls.length, MAX_ATTEMPTS);
    assert.match(text, /It may have been sent/);
    assert.match(text, /Summary: 0 sent now, 0 already sent before, 0 not sent, 1 may have been sent/);
    assert.equal(readResults(plan).rows[0].status, 'unknown');

    const second = fakeFetch([response(201, sentBody(), { 'idempotent-replay': 'true' })]);
    assert.equal((await send(plan, second.impl)).code, 0);
    assert.equal(second.keys()[0], first.keys()[0]);
  });

  test('a persistent 409 ends as "may have been sent", never as not sent', async () => {
    const plan = writePlan({ rows: [row()] });
    assert.equal((await send(plan, fakeFetch([failure(409, 'IDEMPOTENCY_IN_PROGRESS')]).impl)).code, 3);
    assert.equal(readResults(plan).rows[0].status, 'unknown');
  });

  test('a rejection after an unclear try in the same run stays "may have been sent"', async () => {
    const plan = writePlan({ rows: [row()] });
    const { code, text } = await send(plan, fakeFetch([networkDown, failure(401, 'INVALID_API_KEY', 'API key is invalid')]).impl);
    assert.equal(code, 3);
    assert.equal(text.includes('Nothing was sent'), false);
    const record = readResults(plan).rows[0];
    assert.equal(record.status, 'unknown');
    assert.equal(record.error_code, 'INVALID_API_KEY');
  });

  test('being rate-limited after an unclear try stays "may have been sent", in the same run and the next', async () => {
    const busy = response(429, { success: false, error: { code: 'RATE_LIMITED' } }, { 'retry-after': '1' });
    const plan = writePlan({ rows: [row()] });
    const sameRun = await send(plan, fakeFetch([networkDown, busy]).impl);
    assert.equal(sameRun.code, 3);
    assert.equal(sameRun.text.includes('Nothing was sent'), false);
    assert.equal(readResults(plan).rows[0].status, 'unknown');

    const nextRun = await send(plan, fakeFetch([failure(401, 'DATABASE_ERROR', 'Database error')]).impl);
    assert.equal(nextRun.code, 3);
    assert.equal(readResults(plan).rows[0].status, 'unknown');
  });

  test('a rejection in a later run of a row that may have been sent stays "may have been sent"', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([networkDown]).impl);
    const { code } = await send(plan, fakeFetch([failure(401, 'KEY_REVOKED', 'This API key has been revoked')]).impl);
    assert.equal(code, 3);
    assert.equal(readResults(plan).rows[0].status, 'unknown');
  });

  test('a run killed mid-request leaves a pending record, and the rerun repeats the same request', async () => {
    const plan = writePlan({ rows: [row()] });
    const first = fakeFetch([failure(500, 'INTERNAL_ERROR')]);
    await assert.rejects(
      send(plan, first.impl, { sleepImpl: async () => { throw new Error('killed'); } }),
      /killed/,
    );
    assert.equal(readResults(plan).rows[0].status, 'pending');
    const second = fakeFetch([response(201, sentBody(), { 'idempotent-replay': 'true' })]);
    assert.equal((await send(plan, second.impl)).code, 0);
    assert.equal(second.keys()[0], first.keys()[0]);
  });

  test('refuses a row that may have been sent once it has changed', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([networkDown]).impl);
    writePlan({ rows: [row({ envelope_name: 'Fixed the name' })] });
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /row 1 may already have been sent .* has changed since/);
    assert.match(text, /resolve/);
  });

  test('refuses a row that may have been sent when the API key is different', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([networkDown]).impl);
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, text } = await send(plan, fake.impl, { env: { EASY_SIGN_API_KEY: OTHER_KEY } });
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /different API key/);
  });

  test(`retries a row that may have been sent only within ${UNRESOLVED_RETRY_HOURS} hours of the first try`, async () => {
    const start = Date.parse('2026-10-25T12:00:00.000Z');
    const at = (hours) => () => new Date(start + hours * HOUR);
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([networkDown]).impl, { now: at(0) });

    const late = fakeFetch([response(201, sentBody())]);
    const refused = await send(plan, late.impl, { now: at(UNRESOLVED_RETRY_HOURS + 0.1) });
    assert.equal(refused.code, 1);
    assert.equal(late.calls.length, 0);
    assert.match(refused.text, /more than 23 hours ago/);

    // 第二次「没有定论」不许把起点挪后：起点仍是第一次尝试
    await send(plan, fakeFetch([networkDown]).impl, { now: at(UNRESOLVED_RETRY_HOURS - 1) });
    assert.equal(readResults(plan).rows[0].first_attempt_at, new Date(start).toISOString());

    const inTime = fakeFetch([response(201, sentBody(), { 'idempotent-replay': 'true' })]);
    assert.equal((await send(plan, inTime.impl, { now: at(UNRESOLVED_RETRY_HOURS - 0.5) })).code, 0);
    assert.equal(inTime.calls.length, 1);
  });
});

describe('resolve', () => {
  async function uncertainPlan() {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([networkDown]).impl);
    return plan;
  }

  test('--sent records an uncertain row as sent, and send then skips it', async () => {
    const plan = await uncertainPlan();
    const out = collector();
    assert.equal(await main(['resolve', plan, '--row', '1', '--sent'], ENV, out.log), 0);
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 0);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /confirmed by the user/);
  });

  test('--not-sent lets the next send send the row, even after the 23-hour limit', async () => {
    const plan = await uncertainPlan();
    assert.equal(await main(['resolve', plan, '--row', '1', '--not-sent'], ENV, collector().log), 0);
    const fake = fakeFetch([response(201, sentBody())]);
    const later = () => new Date(Date.now() + 48 * HOUR);
    assert.equal((await send(plan, fake.impl, { now: later })).code, 0);
    assert.equal(fake.calls.length, 1);
  });

  test('refuses rows that are not uncertain', async () => {
    const plan = writePlan({ rows: [row()] });
    await send(plan, fakeFetch([response(201, sentBody())]).impl);
    const out = collector();
    assert.equal(await main(['resolve', plan, '--row', '1', '--not-sent'], ENV, out.log), 1);
    assert.match(out.lines.join('\n'), /recorded as sent, not as uncertain/);
    assert.equal(await main(['resolve', plan, '--row', '2', '--sent'], ENV, collector().log), 1);
    assert.equal(readResults(plan).rows[0].status, 'sent');
  });
});

describe('other plans in the same folder', () => {
  test('refuses to send someone the same document a second time from a new plan', async () => {
    const first = writePlan({ rows: [row()] }, 'first.json');
    await send(first, fakeFetch([response(201, sentBody())]).impl);
    const second = writePlan({ rows: [row({ email: 'JANE@example.com' })] }, 'second.json');

    const check = collector();
    assert.equal(await main(['check', second], {}, check.log), 1);
    assert.match(check.lines.join('\n'), /already sent this same document by first\.sent\.json/);

    // 指纹是真的：拦下它的只能是「同目录别的计划已经发过」这一道闸
    const fake = fakeFetch([response(201, sentBody(2))]);
    const { code, text } = await send(second, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /another plan in this folder already sent, or may have sent/);
  });

  test('refuses a document that another plan may have sent, whether its run ended or was killed', async () => {
    const killed = writePlan({ rows: [row({ email: 'sam@example.com', file: pdf('sam.pdf') })] }, 'killed.json');
    await assert.rejects(send(killed, fakeFetch([failure(500, 'INTERNAL_ERROR')]).impl, { sleepImpl: async () => { throw new Error('killed'); } }), /killed/);
    assert.equal(readResults(killed).rows[0].status, 'pending');
    const retry = writePlan({ rows: [row({ email: 'sam@example.com', file: pdf('sam.pdf') })] }, 'retry.json');
    const killedCheck = collector();
    assert.equal(await main(['check', retry], {}, killedCheck.log), 1);
    assert.match(killedCheck.lines.join('\n'), /killed\.sent\.json may already have sent sam@example\.com this same document/);

    const first = writePlan({ rows: [row()] }, 'first.json');
    await send(first, fakeFetch([networkDown]).impl);
    const second = writePlan({ rows: [row()] }, 'second.json');
    const check = collector();
    assert.equal(await main(['check', second], {}, check.log), 1);
    assert.match(check.lines.join('\n'), /first\.sent\.json may already have sent jane@example\.com this same document/);
  });

  test('refuses a corrected document while another plan may have sent the first one', async () => {
    const first = writePlan({ rows: [row()] }, 'first.json');
    await send(first, fakeFetch([networkDown]).impl);
    const corrected = writePlan({ rows: [row({ file: pdf('jane-corrected.pdf') })] }, 'corrected.json');
    const check = collector();
    assert.equal(await main(['check', corrected], {}, check.log), 1);
    assert.match(check.lines.join('\n'), /first\.sent\.json may already have sent jane@example\.com a document/);
    const fake = fakeFetch([response(201, sentBody(2))]);
    assert.equal((await send(corrected, fake.impl)).code, 1);
    assert.equal(fake.calls.length, 0);
  });

  test('a corrected document is a warning, and is sent after approval', async () => {
    const first = writePlan({ rows: [row()] }, 'first.json');
    await send(first, fakeFetch([response(201, sentBody())]).impl);
    const corrected = writePlan({ rows: [row({ file: pdf('jane-corrected.pdf') })] }, 'corrected.json');
    const check = collector();
    assert.equal(await main(['check', corrected], {}, check.log), 0);
    assert.match(check.lines.join('\n'), /already sent a different document by first\.sent\.json/);
    const fake = fakeFetch([response(201, sentBody(2))]);
    assert.equal((await send(corrected, fake.impl)).code, 0);
    assert.equal(fake.calls.length, 1);
  });

  test('ignores sends to another server and refuses an unreadable results file', async () => {
    const first = writePlan({ rows: [row()] }, 'first.json');
    await send(first, fakeFetch([response(201, sentBody())]).impl, { env: { ...ENV, EASY_SIGN_BASE_URL: 'http://localhost:3100' } });
    const second = writePlan({ rows: [row()] }, 'second.json');
    assert.equal(await main(['check', second], {}, collector().log), 0);

    writeFileSync(join(dir, 'broken.sent.json'), '{"plan_id": ');
    const check = collector();
    assert.equal(await main(['check', second], {}, check.log), 1);
    assert.match(check.lines.join('\n'), /broken\.sent\.json cannot be read/);
  });
});

describe('one run per plan at a time', () => {
  const lockOf = (plan) => `${resultsPathFor(plan)}.lock`;
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

  test('refuses to start while another run of the same plan holds the lock', async () => {
    const plan = writePlan({ rows: [row()] });
    writeFileSync(lockOf(plan), JSON.stringify({ pid: process.pid, host: hostname() }));
    const fake = fakeFetch([response(201, sentBody())]);
    const { code, text } = await send(plan, fake.impl);
    assert.equal(code, 1);
    assert.equal(fake.calls.length, 0);
    assert.match(text, /another send or resolve of this plan holds/);
    assert.match(text, new RegExp(`process ${process.pid} on`));
    const out = collector();
    assert.equal(await main(['resolve', plan, '--row', '1', '--sent'], ENV, out.log), 1);
    assert.match(out.lines.join('\n'), /another send or resolve/);
    assert.equal(existsSync(lockOf(plan)), true, 'the other run\'s lock must be left alone');
  });

  test('takes over the lock of a run that was killed, and releases it when done', async () => {
    const plan = writePlan({ rows: [row()] });
    writeFileSync(lockOf(plan), JSON.stringify({ pid: deadPid(), host: hostname() }));
    const fake = fakeFetch([response(201, sentBody())]);
    assert.equal((await send(plan, fake.impl)).code, 0);
    assert.equal(fake.calls.length, 1);
    assert.equal(existsSync(lockOf(plan)), false);
  });

  test('holds the lock for the whole send, network requests included', async () => {
    const plan = writePlan({ rows: [row()] });
    // 请求途中另一个 resolve 必须被锁挡下：此刻这一行正是 pending，锁不在的话它会被改成「没发」。
    // 先让出一轮事件循环：从 runSend 到第一个请求全是同步的，不让出就看不见「锁在等待网络时被提前释放」
    const fake = fakeFetch([async () => {
      await new Promise((done) => setImmediate(done));
      assert.equal(existsSync(lockOf(plan)), true, 'lock released before the request finished');
      assert.equal(await main(['resolve', plan, '--row', '1', '--not-sent'], ENV, collector().log), 1);
      return response(201, sentBody());
    }]);
    assert.equal((await send(plan, fake.impl)).code, 0);
    assert.equal(fake.calls.length, 1);
  });

  test('releases the lock even when the run fails', async () => {
    const plan = writePlan({ rows: [row()] });
    await assert.rejects(send(plan, fakeFetch([failure(500, 'INTERNAL_ERROR')]).impl, { sleepImpl: async () => { throw new Error('killed'); } }), /killed/);
    assert.equal(existsSync(lockOf(plan)), false);
  });
});

describe('command line', () => {
  test('check validates without a key, prints the fingerprint and sends nothing', async () => {
    const plan = writePlan({ rows: [row()] });
    const out = collector();
    assert.equal(await main(['check', plan], {}, out.log), 0);
    const text = out.lines.join('\n');
    assert.match(text, /Nothing has been sent/);
    assert.ok(text.includes(`Plan fingerprint: ${fingerprintOf(plan)}`));
  });

  test('check fails on a broken plan and prints no fingerprint', async () => {
    const plan = writePlan({ rows: [row({ email: 'x' })] });
    const out = collector();
    assert.equal(await main(['check', plan], {}, out.log), 1);
    assert.equal(out.lines.join('\n').includes('fingerprint'), false);
  });

  test('rejects unknown commands and options', async () => {
    const plan = writePlan({ rows: [row()] });
    const code = async (args) => main(args, ENV, collector().log);
    assert.equal(await code(['send', plan, '--force']), 2);
    assert.equal(await code(['send', plan, '--yes']), 2);
    assert.equal(await code(['send', plan, '--approve']), 2);
    assert.equal(await code(['check', plan, '--approve', 'x']), 2);
    assert.equal(await code(['resolve', plan, '--row', '1']), 2);
    assert.equal(await code(['resolve', plan, '--row', '1', '--sent', '--not-sent']), 2);
    assert.equal(await code(['resolve', plan, '--row', 'one', '--sent']), 2);
    assert.equal(await code(['upload', plan]), 2);
    assert.equal(await code([]), 2);
    assert.equal(await code(['--help']), 0);
  });

  test('send without --approve from the command line sends nothing', async () => {
    const plan = writePlan({ rows: [row()] });
    assert.equal(await main(['send', plan], ENV, collector().log), 2);
    assert.equal(existsSync(resultsPathFor(plan)), false);
  });

  test('runs when started through a symlink, as in ~/.agents/skills', async () => {
    const link = join(dir, 'linked-send.mjs');
    symlinkSync(SCRIPT, link);
    const { stdout } = await promisify(execFile)(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.match(stdout, /Usage:/);
  });

  test('the shipped example plan passes check', async () => {
    const example = fileURLToPath(new URL('../examples/signature-plan.json', import.meta.url));
    const out = collector();
    assert.equal(await main(['check', example], {}, out.log), 0, out.lines.join('\n'));
  });

  // 两个独立的进程对一台本机假服务器各发一次：去重键与计划指纹必须只由计划内容决定。
  // 同一个进程里的测试看不见「键里混进了进程号 / 随机数」这类破坏
  test('separate runs of the real script send the same key and accept the same fingerprint', async () => {
    const seen = [];
    const answers = [
      { status: 400, body: { success: false, error: { code: 'INVALID_FIELD_POSITION', message: 'Field page 2 exceeds document page count (1)' } } },
      { status: 201, body: sentBody() },
    ];
    const server = createServer((req, res) => {
      seen.push(req.headers['idempotency-key']);
      req.resume();
      req.on('end', () => {
        const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const env = { ...process.env, EASY_SIGN_API_KEY: API_KEY, EASY_SIGN_BASE_URL: `http://127.0.0.1:${server.address().port}` };
      const plan = writePlan({ rows: [row()] });
      const run = (args) => promisify(execFile)(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' }).catch((e) => e);
      const checked = await run(['check', plan]);
      const fingerprint = checked.stdout.match(/Plan fingerprint: ([0-9a-f]{12})/)?.[1];
      assert.ok(fingerprint, checked.stdout);
      const first = await run(['send', plan, '--approve', fingerprint]);
      const second = await run(['send', plan, '--approve', fingerprint]);
      assert.equal(first.code, 1, first.stdout);
      assert.equal(second.code ?? 0, 0, second.stdout);
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1]);
      for (const output of [checked.stdout, first.stdout, second.stdout, readFileSync(resultsPathFor(plan), 'utf8')]) {
        assertNoLeak(output, 'a separate run');
      }
    } finally {
      server.close();
    }
  });
});

test('the file hash used for duplicate detection is the PDF sha256', () => {
  const r = vp([row()]).rows[0];
  assert.equal(r.document.sha256, createHash('sha256').update(readFileSync(join(dir, 'jane.pdf'))).digest('hex'));
});
