// easy-sign-verify 的离线测试：假 fetch 驱动真脚本，钉住「只发哈希、不发文件」。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  DEFAULT_BASE_URL,
  interpret,
  main,
  normalizeTransactionId,
  PRE_CONNECT_CODES,
  PRE_CONNECT_SYSCALLS,
  preConnectFailureCode,
  verify,
} from '../plugins/easy-sign/skills/easy-sign-verify/scripts/easy-sign-verify.mjs';
import * as send from '../plugins/easy-sign/skills/easy-sign-send/scripts/easy-sign-send.mjs';
import { CONNECTED, PRE_CONNECT } from './network-errors.mjs';

const dir = mkdtempSync(join(tmpdir(), 'easy-sign-verify-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const ID = 'ES-20261025-1A2B3C4D';

function capture(status, body, headers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { impl, calls };
}

describe('normalizeTransactionId', () => {
  test('accepts the printed form in any case and with spaces', () => {
    assert.equal(normalizeTransactionId(` ${ID.toLowerCase()} `), ID);
  });
  test('rejects anything else', () => {
    for (const bad of ['ES-2026102-1A2B3C4D', 'ES-20261025-1A2B3C4', 'ES-20261025-1A2B3C4G', 'XX-20261025-1A2B3C4D', '', null]) {
      assert.equal(normalizeTransactionId(bad), null, String(bad));
    }
  });
});

describe('verify', () => {
  test('sends only the Transaction ID and the SHA-256 of the file', async () => {
    const path = join(dir, 'signed.pdf');
    const bytes = Buffer.from('%PDF-1.4\n% signed copy\n');
    writeFileSync(path, bytes);
    const fake = capture(200, { verified: true, status: 'valid', verificationType: 'full', hashComparison: 'match' });
    const outcome = await verify({ transactionId: ID, filePath: path, env: {}, fetchImpl: fake.impl });
    assert.equal(outcome.ok, true);
    assert.equal(fake.calls[0].url, `${DEFAULT_BASE_URL}/api/verify`);
    assert.equal(fake.calls[0].init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(fake.calls[0].init.body);
    assert.deepEqual(Object.keys(body).sort(), ['pdfHash', 'transactionId']);
    assert.equal(body.pdfHash, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(fake.calls[0].init.body.includes('signed copy'), false, 'file content left the computer');
  });

  test('without a file sends only the Transaction ID', async () => {
    const fake = capture(200, { status: 'valid', verificationType: 'transaction_only', hashComparison: 'not_compared' });
    await verify({ transactionId: ID, env: {}, fetchImpl: fake.impl });
    assert.deepEqual(JSON.parse(fake.calls[0].init.body), { transactionId: ID });
  });

  test('turns 429, 5xx and network errors into a message', async () => {
    const limited = await verify({ transactionId: ID, env: {}, fetchImpl: capture(429, {}, { 'retry-after': '30' }).impl });
    assert.match(limited.message, /wait 30 seconds/);
    const broken = await verify({ transactionId: ID, env: {}, fetchImpl: capture(503, {}).impl });
    assert.match(broken.message, /temporary problem/);
    const offline = await verify({
      transactionId: ID,
      env: {},
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.match(offline.message, /Could not reach Easy Sign/);
  });

  // 不对称的一对：连不上才说「这台电脑 / 沙箱到不了」，连上之后断开的照旧
  test('a failed connection says this computer or sandbox cannot reach Easy Sign', async () => {
    for (const [label, make, code] of PRE_CONNECT) {
      const outcome = await verify({
        transactionId: ID,
        env: {},
        fetchImpl: async () => {
          throw make();
        },
      });
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, new RegExp(`\\(${code}\\)`), label);
      assert.match(outcome.message, /this computer or sandbox cannot reach it/, label);
      assert.match(outcome.message, /Codex/, label);
      assert.match(outcome.message, /run the same command again outside the sandbox after the user approves/, label);
    }
    for (const [label, make] of CONNECTED) {
      const outcome = await verify({
        transactionId: ID,
        env: {},
        fetchImpl: async () => {
          throw make();
        },
      });
      assert.match(outcome.message, /^Could not reach Easy Sign: /, label);
      assert.equal(/sandbox/.test(outcome.message), false, label);
    }
  });

  test('a real check against a closed port on this computer says it cannot reach Easy Sign', async () => {
    const server = createServer();
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    await new Promise((done) => server.close(done));
    const outcome = await verify({ transactionId: ID, env: { EASY_SIGN_BASE_URL: `http://127.0.0.1:${port}` } });
    assert.match(outcome.message, /Could not connect to Easy Sign \(ECONNREFUSED\)/);
    assert.match(outcome.message, /outside the sandbox/);
  });

  test('passes a 404 not_found answer through', async () => {
    const outcome = await verify({ transactionId: ID, env: {}, fetchImpl: capture(404, { status: 'not_found', verificationType: 'transaction_only' }).impl });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.status, 'not_found');
  });
});

// 与 easy-sign-send.mjs 的同名函数同一份判据（两个 skill 各抄一份）：同一组真实形状两边都要答对
describe('preConnectFailureCode', () => {
  test('recognizes every failure before connecting, by its code', () => {
    for (const [label, make, code] of PRE_CONNECT) assert.equal(preConnectFailureCode(make()), code, label);
  });
  test('recognizes nothing that happened after connecting, or that it cannot read', () => {
    for (const [label, make] of CONNECTED) assert.equal(preConnectFailureCode(make()), null, label);
  });
  test('uses exactly the same codes and steps as easy-sign-send', () => {
    assert.deepEqual([...PRE_CONNECT_CODES].sort(), [...send.PRE_CONNECT_CODES].sort());
    assert.deepEqual([...PRE_CONNECT_SYSCALLS].sort(), [...send.PRE_CONNECT_SYSCALLS].sort());
  });
});

describe('interpret', () => {
  test('only a full verification says the file matches', () => {
    assert.match(interpret({ status: 'valid', verificationType: 'full', hashComparison: 'match' }, true), /this exact file matches/);
    for (const r of [
      { status: 'valid', verificationType: 'transaction_only', hashComparison: 'unrecognized' },
      { status: 'valid', verificationType: 'transaction_only', hashComparison: 'not_compared' },
    ]) {
      assert.equal(/exact file matches/.test(interpret(r, true)), false, JSON.stringify(r));
    }
  });
  test('an unrecognized file is never called tampered or forged', () => {
    const text = interpret({ status: 'valid', verificationType: 'transaction_only', hashComparison: 'unrecognized' }, true);
    assert.match(text, /integrity is unknown/);
    assert.match(text, /does not prove tampering/);
  });
  test('covers every status', () => {
    assert.match(interpret({ status: 'not_found' }, false), /no record/);
    assert.match(interpret({ status: 'voided' }, false), /voided/);
    assert.match(interpret({ status: 'pending' }, false), /not everyone has signed/);
    assert.match(interpret({ status: 'valid', verificationType: 'transaction_only', hashComparison: 'not_compared' }, false), /pass the signed PDF/);
    assert.match(interpret({ status: 'odd' }, false), /unexpected/);
    assert.match(interpret(null, false), /cannot read/);
  });
});

describe('command line', () => {
  test('rejects a malformed ID and a missing file before any request', async () => {
    const lines = [];
    assert.equal(await main(['ES-123'], {}, (l) => lines.push(l)), 2);
    assert.equal(await main([ID, join(dir, 'missing.pdf')], {}, (l) => lines.push(l)), 2);
    assert.equal(await main([ID, 'a.pdf', 'extra'], {}, (l) => lines.push(l)), 2);
    assert.equal(await main(['--help'], {}, (l) => lines.push(l)), 0);
  });
});
