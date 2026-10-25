#!/usr/bin/env node
// Easy Sign 发送脚本：校验发送计划（check）、逐行发出签字请求（send）、记下用户核对过的结果（resolve）。
// 零依赖，只用 Node 内置模块（Node 20+ 自带 fetch / AbortSignal.timeout）。
// 用法与计划格式见同一个 skill 的 SKILL.md；服务端契约以 Easy Sign 的
// POST /api/agent/sign-request 为准，这里的校验只是提前拦截，不替代服务端。

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://www.easy-sign.ca';
const ENDPOINT = '/api/agent/sign-request';

// 与服务端对齐的取值集合与上限（服务端改了这里要跟着改；不一致时以服务端为准）
export const FIELD_TYPES = ['signature', 'signature_date', 'date', 'signed_datetime'];
export const PRESETS = [
  'signature_bottom_right',
  'signature_bottom_left',
  'signature_bottom_center',
  'signature_footer',
  'date_after_signature',
];
export const LOCALES = ['en', 'fr', 'zh-hans'];
export const BASE64_MAX_BYTES = 3 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 255;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REQUEST_TIMEOUT_MS = 120_000;
// 每一行最多尝试几次（只对「重试安全」的结果重试：同一个 Idempotency-Key 在 24 小时内由服务端去重）
export const MAX_ATTEMPTS = 6;
// 服务端去重行 24 小时后被清理；留一小时余量，超过就不再用同一个键盲试
export const UNRESOLVED_RETRY_HOURS = 23;
// 与这一行内容无关、出在密钥或账号上的拒绝：提示用户去处理账号，而不是去改计划
export const ACCOUNT_ERROR_CODES = [
  'INVALID_API_KEY',
  'INVALID_FORMAT',
  'KEY_REVOKED',
  'KEY_EXPIRED',
  'PRO_REQUIRED',
  'QUOTA_EXCEEDED',
  'STORAGE_EXCEEDED',
];
// 服务端在任何副作用之前就拒掉的暂时性故障：重试用完仍是它们 = 确定没发出去
const BUSY_ERROR_CODES = ['RATE_LIMITED', 'DATABASE_ERROR'];
// 结果文件里「可能已经发出去、还没有定论」的两种状态
const UNRESOLVED = ['pending', 'unknown'];
// 429 的 Retry-After 上限：服务端窗口是 60 秒，超过这个数说明头不可信
const MAX_RETRY_AFTER_SECONDS = 120;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// 计划校验（check 与 send 共用）
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function inRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateField(field, label, problems) {
  if (!isPlainObject(field)) {
    problems.errors.push(`${label}: must be an object`);
    return null;
  }
  if (!FIELD_TYPES.includes(field.type)) {
    problems.errors.push(`${label}: type must be one of ${FIELD_TYPES.join(', ')}`);
  }
  if (!Number.isInteger(field.page) || field.page < 1) {
    problems.errors.push(`${label}: page must be a whole number starting at 1`);
  }
  const hasPreset = field.preset !== undefined;
  const hasPosition = field.position !== undefined;
  // 服务端在两者都给时静默取 position；这里要求二选一，免得计划读起来有歧义
  if (hasPreset === hasPosition) {
    problems.errors.push(`${label}: give exactly one of "preset" or "position"`);
  } else if (hasPreset && !PRESETS.includes(field.preset)) {
    problems.errors.push(`${label}: preset must be one of ${PRESETS.join(', ')}`);
  } else if (hasPosition) {
    const p = field.position;
    if (!isPlainObject(p)) {
      problems.errors.push(`${label}: position must be { x, y, width, height }`);
    } else {
      if (!inRange(p.x, 0, 100) || !inRange(p.y, 0, 100)) {
        problems.errors.push(`${label}: position x and y must be between 0 and 100 (percent)`);
      }
      if (!inRange(p.width, 1, 50) || !inRange(p.height, 1, 20)) {
        problems.errors.push(`${label}: position width must be 1-50 and height 1-20 (percent)`);
      }
      if (inRange(p.x, 0, 100) && inRange(p.width, 1, 50) && p.x + p.width > 100) {
        problems.warnings.push(`${label}: the box runs past the right edge of the page`);
      }
      if (inRange(p.y, 0, 100) && inRange(p.height, 1, 20) && p.y + p.height > 100) {
        problems.warnings.push(`${label}: the box runs past the bottom of the page`);
      }
    }
  }
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    problems.errors.push(`${label}: required must be true or false`);
  }
  const normalized = { type: field.type, page: field.page };
  if (hasPreset) normalized.preset = field.preset;
  if (hasPosition && isPlainObject(field.position)) {
    const { x, y, width, height } = field.position;
    normalized.position = { x, y, width, height };
  }
  if (field.required !== undefined) normalized.required = field.required;
  return normalized;
}

function validateDocument(row, label, planDir, problems) {
  if (row.file_name !== undefined && (typeof row.file_name !== 'string' || row.file_name.trim() === '')) {
    problems.errors.push(`${label}: file_name must be non-empty text`);
    return null;
  }
  const hasFile = row.file !== undefined;
  const hasUrl = row.url !== undefined;
  if (hasFile === hasUrl) {
    problems.errors.push(`${label}: give exactly one of "file" (a local PDF) or "url"`);
    return null;
  }
  if (hasUrl) {
    let url;
    try {
      url = new URL(String(row.url));
    } catch {
      problems.errors.push(`${label}: url is not a valid URL`);
      return null;
    }
    if (url.protocol !== 'https:') {
      problems.errors.push(`${label}: url must start with https://`);
      return null;
    }
    if (url.username || url.password) {
      problems.errors.push(`${label}: url must not contain a username or password`);
      return null;
    }
    // 服务端不跟随重定向、要求 Content-Type 带 pdf、10 秒超时；离线查不了，只提醒
    const fileName = row.file_name ?? (basename(url.pathname) || 'document.pdf');
    return { kind: 'url', url: url.href, id: url.href, fileName, display: url.href };
  }
  if (typeof row.file !== 'string' || row.file.trim() === '') {
    problems.errors.push(`${label}: file must be a path to a PDF`);
    return null;
  }
  const path = isAbsolute(row.file) ? row.file : resolve(planDir, row.file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    problems.errors.push(`${label}: file not found: ${row.file}`);
    return null;
  }
  const size = statSync(path).size;
  if (size > BASE64_MAX_BYTES) {
    problems.errors.push(
      `${label}: ${row.file} is ${(size / 1024 / 1024).toFixed(1)} MB; local files can be at most 3 MB (host larger PDFs at an https URL, up to 20 MB)`,
    );
    return null;
  }
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    problems.errors.push(`${label}: ${row.file} is not a PDF file`);
    return null;
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    kind: 'file',
    path,
    bytes,
    size,
    sha256: digest,
    id: `sha256:${digest}`,
    fileName: row.file_name ?? basename(path),
    display: row.file,
  };
}

/**
 * 校验整份计划，返回规范化后的行与问题清单。纯读文件、不联网。
 * errors 非空 ⇒ 不许发送；warnings 只提示。
 */
export function validatePlan(plan, planDir) {
  const problems = { errors: [], warnings: [] };
  if (!isPlainObject(plan)) {
    problems.errors.push('The plan must be a JSON object with a "rows" array');
    return { ...problems, rows: [], senderTimezone: null };
  }
  // 时区必须写进计划：它进去重键，取「这台电脑的时区」会让同一份计划在另一个环境里换键（= 第二封信）
  let senderTimezone = null;
  if (plan.sender_timezone === undefined) {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    problems.errors.push(
      `sender_timezone is missing: add the user's time zone, for example "sender_timezone": "${here}" (this computer's zone), and confirm it with the user`,
    );
  } else if (typeof plan.sender_timezone !== 'string' || !isValidTimeZone(plan.sender_timezone)) {
    problems.errors.push('sender_timezone must be an IANA time zone name such as America/Toronto');
  } else {
    senderTimezone = plan.sender_timezone;
  }
  if (!Array.isArray(plan.rows) || plan.rows.length === 0) {
    problems.errors.push('The plan needs a non-empty "rows" array, one row per signer');
    return { ...problems, rows: [], senderTimezone };
  }

  const rows = [];
  const seen = new Map();
  plan.rows.forEach((row, index) => {
    const label = `Row ${index + 1}`;
    if (!isPlainObject(row)) {
      problems.errors.push(`${label}: must be an object`);
      return;
    }
    const email = typeof row.email === 'string' ? row.email.trim() : '';
    if (!EMAIL_REGEX.test(email)) {
      problems.errors.push(`${label}: "${row.email ?? ''}" is not a valid email address`);
    }
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (row.name !== undefined && typeof row.name !== 'string') {
      problems.errors.push(`${label}: name must be text`);
    } else if (name === '') {
      problems.warnings.push(`${label}: no signer name; Easy Sign will use the part of the email before the @ as their name`);
    } else if (name.length > MAX_TEXT_LENGTH) {
      problems.errors.push(`${label}: name is longer than ${MAX_TEXT_LENGTH} characters`);
    }
    if (row.locale !== undefined && !LOCALES.includes(row.locale)) {
      problems.errors.push(`${label}: locale must be one of ${LOCALES.join(', ')}`);
    }
    if (row.envelope_name !== undefined) {
      if (typeof row.envelope_name !== 'string' || row.envelope_name.trim() === '') {
        problems.errors.push(`${label}: envelope_name must be non-empty text`);
      } else if (row.envelope_name.length > MAX_TEXT_LENGTH) {
        problems.errors.push(`${label}: envelope_name is longer than ${MAX_TEXT_LENGTH} characters`);
      }
    }
    const document = validateDocument(row, label, planDir, problems);
    if (document && document.fileName.length > MAX_TEXT_LENGTH) {
      problems.errors.push(`${label}: file name is longer than ${MAX_TEXT_LENGTH} characters`);
    }
    if (!Array.isArray(row.fields) || row.fields.length === 0) {
      problems.errors.push(`${label}: fields must list at least one field`);
    }
    const fields = Array.isArray(row.fields)
      ? row.fields.map((field, i) => validateField(field, `${label}, field ${i + 1}`, problems))
      : [];

    if (document) {
      const dedupeKey = `${email.toLowerCase()}|${document.id}`;
      if (seen.has(dedupeKey)) {
        problems.warnings.push(
          `${label}: same signer and same document as row ${seen.get(dedupeKey)}; they would get two requests`,
        );
      } else {
        seen.set(dedupeKey, index + 1);
      }
    }

    rows.push({
      index,
      email,
      name,
      locale: row.locale,
      envelopeName: row.envelope_name?.trim(),
      document,
      fields,
    });
  });

  if (rows.length > 10) {
    problems.warnings.push(
      `${rows.length} requests: the API takes 10 a minute, so sending will pause between batches`,
    );
  }
  return { ...problems, rows, senderTimezone };
}

// ---------------------------------------------------------------------------
// 去重键、计划指纹与请求体
// ---------------------------------------------------------------------------

/** 一行里会进请求体的全部内容（去重键与计划指纹共用这一份，免得两边各漏一个字段）。 */
function rowContent(row) {
  return {
    email: row.email,
    name: row.name,
    locale: row.locale ?? null,
    envelope_name: row.envelopeName ?? null,
    document: row.document.id,
    file_name: row.document.fileName,
    fields: row.fields,
  };
}

/**
 * 一行在本次计划里的 Idempotency-Key：计划 id + 行号 + 这一行全部内容的哈希。
 * 同一份计划重跑（重试）⇒ 键不变 ⇒ 服务端在 24 小时内回放、不重复发信；
 * 改了这一行的任何内容或换了计划 id ⇒ 新键 ⇒ 是一次新的发送。只由计划内容决定，
 * 不许混进任何「每次运行都不同」的值（进程号、随机数、当前时间）。
 */
export function rowIdempotencyKey(planId, row, senderTimezone) {
  const content = JSON.stringify({
    ...rowContent(row),
    email: row.email.toLowerCase(),
    sender_timezone: senderTimezone,
  });
  return `es-${planId}-${row.index + 1}-${sha256(content).slice(0, 24)}`;
}

/**
 * 计划指纹：check 打印、用户批准、send 必须原样带回。计划或任何一份本地 PDF 改了一个字节，
 * 指纹就变，send 拒绝。url 行只覆盖链接文字：链接背后的文件换了，指纹看不见。
 */
export function planFingerprint(rows, senderTimezone) {
  return sha256(JSON.stringify({ sender_timezone: senderTimezone, rows: rows.map(rowContent) })).slice(0, 12);
}

export function buildRequestBody(row, senderTimezone) {
  const recipient = { email: row.email };
  if (row.name) recipient.name = row.name;
  if (row.locale) recipient.locale = row.locale;
  const document =
    row.document.kind === 'file'
      ? { base64: row.document.bytes.toString('base64'), file_name: row.document.fileName }
      : { url: row.document.url, file_name: row.document.fileName };
  const body = { recipient, document, fields: row.fields, sender_timezone: senderTimezone };
  if (row.envelopeName) body.envelope_name = row.envelopeName;
  return body;
}

// ---------------------------------------------------------------------------
// 环境：服务地址与 API key
// ---------------------------------------------------------------------------

export function resolveBaseUrl(env) {
  const raw = (env.EASY_SIGN_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`EASY_SIGN_BASE_URL is not a valid URL: ${raw}`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  // API key 走 Authorization 头：只许 https，本机调试例外，免得一个手误把 key 明文发出去
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('EASY_SIGN_BASE_URL must use https:// (http:// is allowed only for localhost)');
  }
  return url.origin;
}

export function readApiKey(env) {
  const key = (env.EASY_SIGN_API_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'EASY_SIGN_API_KEY is not set. Create a key in Easy Sign under Settings > API Keys (Pro plan), then export it in the terminal you start the agent from.',
    );
  }
  if (!/^es_live_\S+$/.test(key)) {
    throw new Error('EASY_SIGN_API_KEY does not look like an Easy Sign key (it starts with es_live_)');
  }
  return key;
}

/** 服务端按「API key + Idempotency-Key」去重：换了 key 就不认得先前的请求。只存哈希前缀，不存 key。 */
export function apiKeyFingerprint(apiKey) {
  return sha256(apiKey).slice(0, 12);
}

// ---------------------------------------------------------------------------
// 发送：单次请求 + 结果分类
// ---------------------------------------------------------------------------

async function postOnce({ baseUrl, apiKey, idempotencyKey, body, fetchImpl }) {
  try {
    const response = await fetchImpl(`${baseUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await response.json().catch(() => null);
    return {
      kind: 'response',
      status: response.status,
      retryAfter: Number(response.headers.get('retry-after')),
      replayed: response.headers.get('idempotent-replay') === 'true',
      json,
    };
  } catch (error) {
    return { kind: 'network', message: error?.name === 'TimeoutError' ? 'timed out' : String(error?.message ?? error) };
  }
}

/**
 * 把一次尝试的结果分成三类。
 * - sent：201，信封已建、邮件已发（或回放了先前那次）
 * - retry：用同一个键再试一次是安全的。uncertain = 这一次可能已经在服务端发出了邮件
 *   （网络错误 / 读不出的 201 / 409 / 5xx）；429 与 401 DATABASE_ERROR 出在任何副作用之前，不算
 * - fail：服务端在建信封、发信之前拒绝了这个请求（EMAIL_FAILED 例外：它在回滚之后返回）
 */
export function classifyAttempt(attempt, attemptNumber) {
  if (attempt.kind === 'network') {
    return { outcome: 'retry', uncertain: true, delaySeconds: backoffSeconds(attemptNumber), reason: attempt.message };
  }
  const code = attempt.json?.error?.code;
  if (attempt.status === 201 && attempt.json?.success === true) return { outcome: 'sent' };
  // 201 却读不出响应体：信封与邮件很可能已经发出；同一个键重试会拿到服务端回放的原结果，
  // 绝不能当成「没发出去」报给用户
  if (attempt.status === 201) {
    return { outcome: 'retry', uncertain: true, delaySeconds: backoffSeconds(attemptNumber), reason: 'unreadable response' };
  }
  if (attempt.status === 429) {
    const wait = Number.isFinite(attempt.retryAfter) && attempt.retryAfter > 0
      ? Math.min(attempt.retryAfter, MAX_RETRY_AFTER_SECONDS)
      : 60;
    return { outcome: 'retry', uncertain: false, code: 'RATE_LIMITED', delaySeconds: wait, reason: 'rate limited' };
  }
  // 这个接口的 409 只有一种含义：同一个键的上一次请求还没结束，而它可能已经发出了邮件。
  // 读不出错误码时也按这个处理 —— 当成「请求有误、没发」就是一句可能为假的「没发」
  if (attempt.status === 409) {
    return { outcome: 'retry', uncertain: true, delaySeconds: backoffSeconds(attemptNumber), reason: 'the first try is still running' };
  }
  if (attempt.status === 401 && code === 'DATABASE_ERROR') {
    return { outcome: 'retry', uncertain: false, code, delaySeconds: backoffSeconds(attemptNumber), reason: 'temporary server error' };
  }
  // EMAIL_FAILED：服务端发信失败后已回滚信封、释放了去重键。再试就是一次全新的发送，
  // 而它多半是地址被拒 —— 停下交给人，不自动重试
  if (code === 'EMAIL_FAILED') {
    return { outcome: 'fail', code, message: attempt.json?.error?.message ?? 'The signature request email could not be sent' };
  }
  if (attempt.status >= 500) {
    return { outcome: 'retry', uncertain: true, delaySeconds: backoffSeconds(attemptNumber), reason: `server error ${attempt.status}${code ? ` ${code}` : ''}` };
  }
  return {
    outcome: 'fail',
    code: code ?? `HTTP_${attempt.status}`,
    message: attempt.json?.error?.message ?? 'The request was rejected',
  };
}

function backoffSeconds(attemptNumber) {
  return Math.min(5 * 2 ** (attemptNumber - 1), 60);
}

/** 只挑能安全留存的字段：signing_url 是签署人的凭证，永远不进输出与结果文件。 */
function safeSentRecord(json) {
  return {
    envelope_id: json.envelope_id,
    recipient_email: json.recipient_email,
    expires_at: json.expires_at,
    sender_timezone: json.sender_timezone,
    ...(Array.isArray(json.warnings) && json.warnings.length > 0 ? { warnings: json.warnings } : {}),
  };
}

/**
 * 发一行，最多 MAX_ATTEMPTS 次。uncertain 由调用方带入（这一行先前的运行没有定论），
 * 本次运行里出现过可能已发信的尝试也会置位；置位之后，任何「拒绝」都只能报 unknown ——
 * 先前那次可能已经发出，后面这次被拒（例如 key 刚被吊销）证明不了「没发」。
 */
export async function sendRow({ row, idempotencyKey, senderTimezone, baseUrl, apiKey, fetchImpl, sleepImpl, log, uncertain = false }) {
  const body = buildRequestBody(row, senderTimezone);
  let maybeSent = uncertain;
  let lastVerdict = null;
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    const attempt = await postOnce({ baseUrl, apiKey, idempotencyKey, body, fetchImpl });
    const verdict = classifyAttempt(attempt, attemptNumber);
    if (verdict.outcome === 'sent') {
      // 第一次就拿到回放 = 先前的运行发出的；本次后续尝试拿到的回放 = 本次前面那次发出的
      return { status: 'sent', sent_before: attempt.replayed && attemptNumber === 1, ...safeSentRecord(attempt.json) };
    }
    if (verdict.outcome === 'fail') {
      return maybeSent
        ? { status: 'unknown', error_code: verdict.code, error_message: `${verdict.message} (an earlier try got no clear answer)` }
        : { status: 'failed', error_code: verdict.code, error_message: verdict.message };
    }
    maybeSent ||= verdict.uncertain;
    lastVerdict = verdict;
    if (attemptNumber < MAX_ATTEMPTS) {
      log(`      ${verdict.reason}; repeating the same request in ${verdict.delaySeconds}s`);
      await sleepImpl(verdict.delaySeconds * 1000);
    }
  }
  if (!maybeSent) {
    // 每一次都在副作用之前被挡（限流 / 暂时故障）：确定没发出去
    return { status: 'failed', error_code: lastVerdict.code, error_message: `Easy Sign was busy (${lastVerdict.reason})` };
  }
  return { status: 'unknown', error_message: lastVerdict.reason };
}

// ---------------------------------------------------------------------------
// 结果文件：本地记账，重跑时跳过已发出的行
// ---------------------------------------------------------------------------

export function resultsPathFor(planPath) {
  return planPath.endsWith('.json') ? `${planPath.slice(0, -5)}.sent.json` : `${planPath}.sent.json`;
}

function loadResults(path) {
  if (!existsSync(path)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${path} cannot be read (${error.message}). Do not delete it: it records what was already sent. Ask the user to look at it.`,
    );
  }
  if (!isPlainObject(data) || typeof data.plan_id !== 'string' || !Array.isArray(data.rows)) {
    throw new Error(`${path} is not a results file written by this script`);
  }
  return data;
}

// 先写临时文件、fsync、再改名：断电或被杀时留下的要么是旧文件要么是新文件，不会是半个
function saveResults(path, data) {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * 结果文件的锁：同一份计划同时跑两个 send，会各自拿着旧的内存副本互相覆盖记录（丢掉的
 * 「已发出」过了 24 小时就会再发一封），两个同时开始的首跑甚至会拿到两个 plan_id。
 * 锁里记 pid 与主机名：同一台机器上持有者已经不在了（进程被杀）就接手，否则拒绝。
 * 返回释放函数；拿不到锁返回 null。
 */
function acquireLock(resultsPath) {
  const lockPath = `${resultsPath}.lock`;
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {}
      if (holder?.host !== hostname() || !Number.isInteger(holder.pid) || isAlive(holder.pid)) return null;
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
  return null;
}

function lockRefusal(resultsPath) {
  let holder = '';
  try {
    const { pid, host, at } = JSON.parse(readFileSync(`${resultsPath}.lock`, 'utf8'));
    holder = ` (process ${pid} on ${host}, started ${at})`;
  } catch {}
  return `Not started: another send or resolve of this plan holds ${basename(resultsPath)}.lock${holder}. Wait for it to finish. Do not delete the lock unless the user confirms that no send of this plan is running anywhere.`;
}

function upsertRecord(results, record) {
  results.rows = results.rows.filter((r) => r.row !== record.row);
  results.rows.push(record);
  results.rows.sort((a, b) => a.row - b.row);
}

const dayOf = (iso) => String(iso ?? '').slice(0, 10) || 'an earlier day';

/**
 * 同一文件夹里别的计划的结果文件：同一个人 + 同一份文档已经发出（或可能已发出）⇒ errors；
 * 同一个人收过另一份文档 ⇒ warnings。只看同一个服务地址的记录。
 */
export function findEarlierSends(planPath, rows, baseUrl) {
  const found = { errors: [], warnings: [] };
  const own = resultsPathFor(planPath);
  const folder = dirname(planPath);
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith('.sent.json')) continue;
    const path = join(folder, name);
    if (path === own) continue;
    let data;
    try {
      data = loadResults(path);
    } catch (error) {
      found.errors.push(`${error.message.replace(/\.?$/, '.')} It may record earlier sends, so nothing can be sent from this folder until it is fixed.`);
      continue;
    }
    if (data.base_url !== baseUrl) continue;
    for (const record of data.rows) {
      const live = record.status === 'sent' || UNRESOLVED.includes(record.status);
      if (!live || typeof record.email !== 'string') continue;
      for (const row of rows) {
        if (!row.document || record.email.toLowerCase() !== row.email.toLowerCase()) continue;
        const label = `Row ${row.index + 1}`;
        if (record.document !== row.document.id) {
          // 另一份计划里这个人「可能已经收到」一份文档：哪怕这次是改过的新文档，也得先查清那一封
          if (record.status === 'sent') {
            found.warnings.push(`${label}: ${row.email} was already sent a different document by ${name} on ${dayOf(record.at)}; make sure the user means to send another request`);
          } else {
            found.errors.push(`${label}: ${name} may already have sent ${row.email} a document (no clear answer on ${dayOf(record.first_attempt_at)}). Settle that first: run send again on that plan, or check the dashboard and use "resolve" there`);
          }
          continue;
        }
        found.errors.push(
          record.status === 'sent'
            ? `${label}: ${row.email} was already sent this same document by ${name} on ${dayOf(record.at)}. Sending it again emails them a second time: remove the row, or use Resend on that envelope in the Easy Sign dashboard to remind them`
            : `${label}: ${name} may already have sent ${row.email} this same document (no clear answer on ${dayOf(record.first_attempt_at)}). Run send again on that plan instead, or check the dashboard and use "resolve" there`,
        );
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

function describeField(field) {
  const where = field.preset
    ? field.preset.replace(/^signature_|^date_/, '').replaceAll('_', ' ')
    : `x ${field.position?.x} y ${field.position?.y}`;
  return `${field.type} p${field.page} (${where})`;
}

function printPlanTable(rows, log) {
  rows.forEach((row) => {
    const who = row.name ? `${row.name} <${row.email}>` : `<${row.email}>`;
    const size = row.document?.kind === 'file' ? ` (${Math.ceil(row.document.size / 1024)} KB)` : '';
    log(`  ${row.index + 1}. ${who}`);
    log(`     document: ${row.document?.display ?? '?'}${size}`);
    if (row.envelopeName) log(`     envelope: ${row.envelopeName}`);
    if (row.locale) log(`     language: ${row.locale}`);
    log(`     fields:   ${row.fields.filter(Boolean).map(describeField).join('; ')}`);
  });
}

function readPlanFile(planPath) {
  let text;
  try {
    text = readFileSync(planPath, 'utf8');
  } catch {
    throw new Error(`Cannot read the plan file: ${planPath}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The plan file is not valid JSON: ${error.message}`);
  }
}

export function runCheck(planPath, { env, log }) {
  const plan = readPlanFile(planPath);
  const result = validatePlan(plan, dirname(planPath));
  const earlier = findEarlierSends(planPath, result.rows, resolveBaseUrl(env));
  const errors = [...result.errors, ...earlier.errors];
  log(`Plan ${basename(planPath)}: ${result.rows.length} signature request(s), one email and one copy to sign per person`);
  if (result.senderTimezone) log(`Signing dates and times are stamped in: ${result.senderTimezone}`);
  printPlanTable(result.rows, log);
  for (const warning of [...result.warnings, ...earlier.warnings]) log(`  ! ${warning}`);
  for (const error of errors) log(`  x ${error}`);
  if (errors.length > 0) {
    log(`Not ready: fix the ${errors.length} problem(s) above. Nothing was sent.`);
    return 1;
  }
  log(`Plan fingerprint: ${planFingerprint(result.rows, result.senderTimezone)}`);
  log('Nothing has been sent. Show this plan to the user. Only after they approve it, send it with --approve and this fingerprint.');
  return 0;
}

export async function runSend(planPath, { approve, env, log, fetchImpl = fetch, sleepImpl = sleep, now = () => new Date() }) {
  if (!approve) {
    log('Refusing to send without --approve. Run "check", show the plan to the user, and after they approve it, send with --approve and the fingerprint check printed.');
    return 2;
  }
  const plan = readPlanFile(planPath);
  const result = validatePlan(plan, dirname(planPath));
  if (result.errors.length > 0) {
    for (const error of result.errors) log(`  x ${error}`);
    log('Not sent: the plan has problems. Run "check" for details.');
    return 1;
  }
  const fingerprint = planFingerprint(result.rows, result.senderTimezone);
  if (approve !== fingerprint) {
    log(`Not sent: this plan's fingerprint is now ${fingerprint}, not ${approve}. The plan or one of its PDFs changed since it was approved. Run "check" again and ask the user to approve the plan as it is now.`);
    return 1;
  }
  const baseUrl = resolveBaseUrl(env);
  const apiKey = readApiKey(env);
  const keyFingerprint = apiKeyFingerprint(apiKey);

  const earlierSends = findEarlierSends(planPath, result.rows, baseUrl);
  if (earlierSends.errors.length > 0) {
    for (const error of earlierSends.errors) log(`  x ${error}`);
    log('Not sent: another plan in this folder already sent, or may have sent, some of these rows.');
    return 1;
  }

  const resultsPath = resultsPathFor(planPath);
  const release = acquireLock(resultsPath);
  if (!release) {
    log(lockRefusal(resultsPath));
    return 1;
  }
  try {
    return await sendRows({ planPath, result, resultsPath, baseUrl, apiKey, keyFingerprint, earlierSends, log, fetchImpl, sleepImpl, now });
  } finally {
    release();
  }
}

async function sendRows({ planPath, result, resultsPath, baseUrl, apiKey, keyFingerprint, earlierSends, log, fetchImpl, sleepImpl, now }) {
  const previous = loadResults(resultsPath);
  if (previous && previous.base_url !== baseUrl) {
    log(`Not sent: ${basename(resultsPath)} records sends to ${previous.base_url}, not ${baseUrl}. Start a new plan file for a different server.`);
    return 1;
  }
  const results = previous ?? { plan_id: randomUUID().slice(0, 8), base_url: baseUrl, rows: [] };

  // 发任何请求之前先把整份计划过一遍：要拒就整份拒，不发一半再停
  const keys = result.rows.map((row) => rowIdempotencyKey(results.plan_id, row, result.senderTimezone));
  const cutoff = now().getTime() - UNRESOLVED_RETRY_HOURS * 3600 * 1000;
  for (const row of result.rows) {
    const n = row.index + 1;
    const earlier = results.rows.find((r) => r.row === n);
    if (!earlier) continue;
    const changed = earlier.idempotency_key !== keys[row.index];
    if (earlier.status === 'sent' && changed) {
      log(`Not sent: row ${n} was already sent${earlier.envelope_id ? ` (envelope ${earlier.envelope_id})` : ''} and has changed since. Put it back as it was. To send a corrected version on purpose, write a new plan file with just that row.`);
      return 1;
    }
    if (!UNRESOLVED.includes(earlier.status)) continue;
    const ask = `Ask the user to look in the Easy Sign dashboard for an envelope to ${earlier.email}, then run "resolve" for row ${n}.`;
    if (changed) {
      log(`Not sent: row ${n} may already have been sent (no clear answer on ${dayOf(earlier.first_attempt_at)}) and has changed since, so Easy Sign would not recognize it as the same request. ${ask}`);
      return 1;
    }
    if (earlier.api_key_fp !== keyFingerprint) {
      log(`Not sent: row ${n} may already have been sent with a different API key, and Easy Sign recognizes a repeated request only from the same key. Use the original key, or: ${ask}`);
      return 1;
    }
    if (Date.parse(earlier.first_attempt_at) < cutoff) {
      log(`Not sent: row ${n} was first tried more than ${UNRESOLVED_RETRY_HOURS} hours ago with no clear answer. Easy Sign recognizes a repeated request for 24 hours only, so trying again could email the signer twice. ${ask}`);
      return 1;
    }
  }
  // 先落盘 plan_id 再发第一个请求：请求到了服务端而进程在写盘前崩掉时，重跑必须拿回同一个
  // plan_id（⇒ 同一个键 ⇒ 服务端回放），否则换了新键就是第二封信
  if (!previous) saveResults(resultsPath, results);

  const where = baseUrl === DEFAULT_BASE_URL ? '' : ` to ${baseUrl}`;
  log(`Sending ${result.rows.length} signature request(s)${where}. Results go to ${basename(resultsPath)}.`);
  for (const warning of earlierSends.warnings) log(`  note: ${warning}`);
  let exitCode = 0;
  let stoppedAt = null;
  const counts = { sentNow: 0, sentBefore: 0, notSent: 0, maybeSent: 0 };
  for (const row of result.rows) {
    const n = row.index + 1;
    const key = keys[row.index];
    const who = row.name ? `${row.name} <${row.email}>` : `<${row.email}>`;
    const label = `  ${n}/${result.rows.length} ${who}`;
    const earlier = results.rows.find((r) => r.row === n);
    if (earlier?.status === 'sent') {
      counts.sentBefore += 1;
      log(`${label}: already sent${earlier.envelope_id ? ` (envelope ${earlier.envelope_id})` : ' (confirmed by the user)'}; skipped`);
      continue;
    }
    const wasUncertain = UNRESOLVED.includes(earlier?.status);
    // 发请求之前先记下「这一行正在发」：进程在请求途中被杀，重跑时也认得这是同一个请求
    const pending = {
      row: n,
      email: row.email,
      document: row.document.id,
      idempotency_key: key,
      api_key_fp: keyFingerprint,
      first_attempt_at: wasUncertain ? earlier.first_attempt_at : now().toISOString(),
      at: now().toISOString(),
      status: 'pending',
    };
    upsertRecord(results, pending);
    saveResults(resultsPath, results);

    const outcome = await sendRow({ row, idempotencyKey: key, senderTimezone: result.senderTimezone, baseUrl, apiKey, fetchImpl, sleepImpl, log, uncertain: wasUncertain });
    // 先报告再落盘：落盘失败时用户至少看到了信封号，而 pending 记录让重跑拿回同一个键
    if (outcome.status === 'sent') {
      if (outcome.sent_before) {
        counts.sentBefore += 1;
        log(`${label}: already sent by an earlier run (no new email); envelope ${outcome.envelope_id}`);
      } else {
        counts.sentNow += 1;
        log(`${label}: sent; envelope ${outcome.envelope_id}; link valid until ${outcome.expires_at}`);
      }
      if (outcome.sender_timezone && outcome.sender_timezone !== result.senderTimezone) {
        log(`      note: Easy Sign stamped dates in ${outcome.sender_timezone}, not ${result.senderTimezone}`);
      }
      for (const warning of outcome.warnings ?? []) log(`      note from Easy Sign: ${warning}`);
    } else if (outcome.status === 'failed') {
      counts.notSent += 1;
      log(`${label}: not sent (${outcome.error_code}: ${outcome.error_message}).`);
      if (outcome.error_code === 'EMAIL_FAILED') {
        log('      Easy Sign could not email this address and removed the envelope.');
        log('Stopped. Check the address with the user, fix it in the same plan file, run check again and get their approval; rows already sent will be skipped.');
      } else if (BUSY_ERROR_CODES.includes(outcome.error_code)) {
        log('      Nothing was sent for this row.');
        log('Stopped. Easy Sign was busy. Run the same command again in a few minutes; rows already sent will be skipped.');
      } else if (ACCOUNT_ERROR_CODES.includes(outcome.error_code)) {
        log('      Nothing was sent for this row.');
        log('Stopped. This is about the API key or the Easy Sign account, not this row. Sort that out, then run the same command again; rows already sent will be skipped.');
      } else {
        log('      Nothing was sent for this row.');
        log('Stopped. Fix this row in the same plan file, run check again and get the user\'s approval; rows already sent will be skipped.');
      }
      exitCode = 1;
    } else {
      counts.maybeSent += 1;
      log(`${label}: no clear answer from Easy Sign (${outcome.error_code ? `${outcome.error_code}: ` : ''}${outcome.error_message}). It may have been sent.`);
      log('Stopped. Do not send this row any other way. Run the same command again later: it repeats this exact request, which Easy Sign recognizes for 24 hours after the first try, so it will not email them twice. If it keeps ending like this, ask the user to check the Easy Sign dashboard and use "resolve".');
      exitCode = 3;
    }
    upsertRecord(results, { ...pending, at: now().toISOString(), ...outcome });
    saveResults(resultsPath, results);
    if (exitCode !== 0) {
      stoppedAt = row.index;
      break;
    }
  }
  const notTried = stoppedAt === null
    ? 0
    : result.rows.filter((r) => r.index > stoppedAt && results.rows.find((x) => x.row === r.index + 1)?.status !== 'sent').length;
  log(`Summary: ${counts.sentNow} sent now, ${counts.sentBefore} already sent before, ${counts.notSent} not sent, ${counts.maybeSent} may have been sent, ${notTried} not tried yet.`);
  return exitCode;
}

/** 用户在后台核对过之后，把一行「没有定论」的记录定下来。只改结果文件，不联网。 */
export function runResolve(planPath, { row, verdict, log, now = () => new Date() }) {
  const resultsPath = resultsPathFor(planPath);
  const release = acquireLock(resultsPath);
  if (!release) {
    log(lockRefusal(resultsPath));
    return 1;
  }
  try {
    return resolveRow({ resultsPath, row, verdict, log, now });
  } finally {
    release();
  }
}

function resolveRow({ resultsPath, row, verdict, log, now }) {
  const results = loadResults(resultsPath);
  const record = results?.rows.find((r) => r.row === row);
  if (!record) {
    log(`Nothing to resolve: ${basename(resultsPath)} has no record for row ${row}.`);
    return 1;
  }
  if (!UNRESOLVED.includes(record.status)) {
    log(`Nothing to resolve: row ${row} is recorded as ${record.status}, not as uncertain.`);
    return 1;
  }
  const resolved = { ...record, status: verdict === 'sent' ? 'sent' : 'cleared', resolved_by_user_at: now().toISOString() };
  upsertRecord(results, resolved);
  saveResults(resultsPath, results);
  log(
    verdict === 'sent'
      ? `Row ${row} is now recorded as sent; send will skip it.`
      : `Row ${row} is now recorded as not sent; the next send will send it as a new request.`,
  );
  return 0;
}

const USAGE = `Usage:
  node easy-sign-send.mjs check <plan.json>
      validate the plan and print its fingerprint; sends nothing
  node easy-sign-send.mjs send <plan.json> --approve <fingerprint>
      send every row, only after the user approved this exact plan
  node easy-sign-send.mjs resolve <plan.json> --row <n> --sent|--not-sent
      record what the user found in the Easy Sign dashboard for an uncertain row`;

function parseOptions(rest, allowed) {
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const spec = allowed[arg];
    if (spec === undefined || arg in options) return { error: `Unknown or repeated option: ${arg}` };
    if (spec === 'flag') {
      options[arg] = true;
    } else {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      options[arg] = value;
      i += 1;
    }
  }
  return { options };
}

export async function main(argv, env, log = console.log) {
  const [command, planArg, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    log(USAGE);
    return command ? 0 : 2;
  }
  const allowed = { check: {}, send: { '--approve': 'value' }, resolve: { '--row': 'value', '--sent': 'flag', '--not-sent': 'flag' } };
  if (!planArg || !(command in allowed)) {
    log(USAGE);
    return 2;
  }
  const { options, error } = parseOptions(rest, allowed[command]);
  if (error) {
    log(error);
    log(USAGE);
    return 2;
  }
  const planPath = resolve(planArg);
  try {
    if (command === 'check') return runCheck(planPath, { env, log });
    if (command === 'send') return await runSend(planPath, { approve: options['--approve'], env, log });
    const row = Number(options['--row']);
    if (!Number.isInteger(row) || row < 1 || Boolean(options['--sent']) === Boolean(options['--not-sent'])) {
      log('resolve needs --row <n> and exactly one of --sent or --not-sent');
      return 2;
    }
    return runResolve(planPath, { row, verdict: options['--sent'] ? 'sent' : 'not-sent', log });
  } catch (error) {
    log(`Error: ${error.message}`);
    return 1;
  }
}

// 只在被直接执行时跑 main。两边都取 realpath：skill 常被软链进 ~/.agents/skills，
// 而 Node 默认把主模块解析到真实路径，直接比字符串会在软链下静默什么都不做
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), process.env);
  process.exitCode = code;
}
