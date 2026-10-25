#!/usr/bin/env node
// Easy Sign 验真脚本：按交易号向公开接口 POST /api/verify 查询；给了 PDF 时只在本机算
// SHA-256、只发哈希，文件本身不离开这台电脑。零依赖（Node 20+），不需要 API key。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://www.easy-sign.ca';
// 与服务端 parseTransactionId 同形：ES-<8 位日期>-<8 位十六进制>
const TRANSACTION_ID_REGEX = /^ES-\d{8}-[0-9A-F]{8}$/;
const REQUEST_TIMEOUT_MS = 60_000;

export function normalizeTransactionId(raw) {
  const id = String(raw ?? '').trim().toUpperCase();
  return TRANSACTION_ID_REGEX.test(id) ? id : null;
}

export function resolveBaseUrl(env) {
  const raw = (env.EASY_SIGN_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`EASY_SIGN_BASE_URL is not a valid URL: ${raw}`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('EASY_SIGN_BASE_URL must use https:// (http:// is allowed only for localhost)');
  }
  return url.origin;
}

export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 把接口的回答翻成一句话。只有 verificationType = full 才是「这份文件就是签好的那份」；
 * 对不上哈希只说明「不是我们存过哈希的那份」，既不证明真也不证明被改过。
 */
export function interpret(result, fileGiven) {
  if (!result || typeof result !== 'object') return 'Easy Sign returned an answer this script cannot read.';
  switch (result.status) {
    case 'not_found':
      return 'Easy Sign has no record of this Transaction ID.';
    case 'voided':
      return 'The sender voided this document. It is no longer valid.';
    case 'pending':
      return 'The document exists, but not everyone has signed it yet.';
    case 'valid':
      if (result.verificationType === 'full') {
        return 'Signed and complete, and this exact file matches the signed copy on record.';
      }
      if (result.hashComparison === 'unrecognized') {
        return 'Signed and complete. This file is not one of the copies on record, so its integrity is unknown. That is normal for the audit certificate or a re-saved, printed or scanned copy, and it does not prove tampering.';
      }
      return fileGiven
        ? 'Signed and complete. There is no file hash on record to compare this file with.'
        : 'Signed and complete. No file was compared; pass the signed PDF to also check the file.';
    default:
      return 'Easy Sign returned an unexpected status.';
  }
}

export async function verify({ transactionId, filePath, env, fetchImpl = fetch }) {
  const baseUrl = resolveBaseUrl(env);
  const body = { transactionId };
  if (filePath) body.pdfHash = hashFile(filePath);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, message: `Could not reach Easy Sign: ${error?.message ?? error}` };
  }
  const json = await response.json().catch(() => null);
  if (response.status === 429) {
    return { ok: false, message: `Too many checks; wait ${response.headers.get('retry-after') ?? 60} seconds and try again.` };
  }
  if (response.status >= 500) {
    return { ok: false, message: `Easy Sign had a temporary problem (HTTP ${response.status}); try again in a minute.` };
  }
  return { ok: true, http_status: response.status, result: json };
}

const USAGE = `Usage:
  node easy-sign-verify.mjs <Transaction ID> [signed.pdf]
  The Transaction ID looks like ES-20261025-1A2B3C4D. It is printed on the audit certificate
  and stored in the signed PDF's properties (pdfinfo shows it as the Subject).
  With a PDF, only its SHA-256 hash is sent; the file stays on this computer.`;

export async function main(argv, env, log = console.log) {
  const [rawId, filePath, ...rest] = argv;
  if (!rawId || rawId === '--help' || rawId === '-h' || rest.length > 0) {
    log(USAGE);
    return rawId === '--help' || rawId === '-h' ? 0 : 2;
  }
  const transactionId = normalizeTransactionId(rawId);
  if (!transactionId) {
    log(`"${rawId}" is not a Transaction ID. It looks like ES-20261025-1A2B3C4D.`);
    return 2;
  }
  if (filePath && (!existsSync(filePath) || !statSync(filePath).isFile())) {
    log(`File not found: ${filePath}`);
    return 2;
  }
  try {
    const outcome = await verify({ transactionId, filePath, env });
    if (!outcome.ok) {
      log(outcome.message);
      return 1;
    }
    const r = outcome.result ?? {};
    log(JSON.stringify({
      transaction_id: r.transactionId ?? transactionId,
      status: r.status,
      verified: r.verified,
      verification_type: r.verificationType,
      hash_comparison: r.hashComparison,
      details: r.details,
    }, null, 2));
    log(interpret(r, Boolean(filePath)));
    return 0;
  } catch (error) {
    log(`Error: ${error.message}`);
    return 1;
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
