#!/usr/bin/env node
// Easy Sign 发送脚本：校验发送计划（check）并逐行发出签字请求（send）。
// 零依赖，只用 Node 内置模块（Node 20+ 自带 fetch / AbortSignal.timeout）。
// 用法与计划格式见同一个 skill 的 SKILL.md；服务端契约以 Easy Sign 的
// POST /api/agent/sign-request 为准，这里的校验只是提前拦截，不替代服务端。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
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
// 每一行最多尝试几次（只对「重试安全」的结果重试：同一个 Idempotency-Key 保证不会重复发信）
export const MAX_ATTEMPTS = 6;
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
// 429 的 Retry-After 上限：服务端窗口是 60 秒，超过这个数说明头不可信
const MAX_RETRY_AFTER_SECONDS = 120;

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
    return { kind: 'url', url: url.href, fileName, display: url.href };
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
  const fileName = row.file_name ?? basename(path);
  return {
    kind: 'file',
    path,
    bytes,
    size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fileName,
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
  let senderTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (plan.sender_timezone !== undefined) {
    if (typeof plan.sender_timezone !== 'string' || !isValidTimeZone(plan.sender_timezone)) {
      problems.errors.push(
        'sender_timezone must be an IANA time zone name such as America/Toronto',
      );
    } else {
      senderTimezone = plan.sender_timezone;
    }
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
      problems.warnings.push(`${label}: no signer name; the email will greet them without one`);
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
      const dedupeKey = `${email.toLowerCase()}|${document.sha256 ?? document.url}`;
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
// 去重键与请求体
// ---------------------------------------------------------------------------

/**
 * 一行在本次计划里的 Idempotency-Key：计划 id + 行号 + 这一行全部内容的哈希。
 * 同一份计划重跑（重试）⇒ 键不变 ⇒ 服务端回放、不重复发信；
 * 改了这一行的任何内容或换了计划 id ⇒ 新键 ⇒ 是一次新的发送。
 */
export function rowIdempotencyKey(planId, row, senderTimezone) {
  const content = JSON.stringify({
    email: row.email.toLowerCase(),
    name: row.name,
    locale: row.locale ?? null,
    envelope_name: row.envelopeName ?? null,
    document: row.document.kind === 'file' ? `sha256:${row.document.sha256}` : row.document.url,
    file_name: row.document.fileName,
    fields: row.fields,
    sender_timezone: senderTimezone,
  });
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 24);
  return `es-${planId}-${row.index + 1}-${digest}`;
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
 * - retry：用同一个键再试一次是安全的（限流 / 同键在处理 / 服务端暂时故障 / 网络不通）
 * - fail：请求本身有问题，服务端没有建信封也没有发信，重试不会变好
 */
export function classifyAttempt(attempt, attemptNumber) {
  if (attempt.kind === 'network') {
    return { outcome: 'retry', delaySeconds: backoffSeconds(attemptNumber), reason: attempt.message };
  }
  const code = attempt.json?.error?.code;
  if (attempt.status === 201 && attempt.json?.success === true) return { outcome: 'sent' };
  // 201 却读不出响应体：信封与邮件很可能已经发出；同一个键重试会拿到服务端回放的原结果，
  // 绝不能当成「没发出去」报给用户
  if (attempt.status === 201) {
    return { outcome: 'retry', delaySeconds: backoffSeconds(attemptNumber), reason: 'unreadable response' };
  }
  if (attempt.status === 429) {
    const wait = Number.isFinite(attempt.retryAfter) && attempt.retryAfter > 0
      ? Math.min(attempt.retryAfter, MAX_RETRY_AFTER_SECONDS)
      : 60;
    return { outcome: 'retry', delaySeconds: wait, reason: 'rate limited' };
  }
  // 这个接口的 409 只有一种含义：同一个键的上一次请求还没结束，而它可能已经发出了邮件。
  // 读不出错误码时也按这个处理 —— 当成「请求有误、没发」就是一句可能为假的「没发」
  if (attempt.status === 409) {
    return { outcome: 'retry', delaySeconds: backoffSeconds(attemptNumber), reason: 'the first try is still running' };
  }
  if (attempt.status === 401 && code === 'DATABASE_ERROR') {
    return { outcome: 'retry', delaySeconds: backoffSeconds(attemptNumber), reason: 'temporary server error' };
  }
  if (attempt.status >= 500) {
    return { outcome: 'retry', delaySeconds: backoffSeconds(attemptNumber), reason: `server error ${attempt.status}${code ? ` ${code}` : ''}` };
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
function safeSentRecord(json, replayed) {
  return {
    envelope_id: json.envelope_id,
    recipient_email: json.recipient_email,
    expires_at: json.expires_at,
    sender_timezone: json.sender_timezone,
    replayed,
    ...(Array.isArray(json.warnings) && json.warnings.length > 0 ? { warnings: json.warnings } : {}),
  };
}

export async function sendRow({ row, idempotencyKey, senderTimezone, baseUrl, apiKey, fetchImpl, sleepImpl, log }) {
  const body = buildRequestBody(row, senderTimezone);
  let lastReason = '';
  let lastAttempt = null;
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    const attempt = await postOnce({ baseUrl, apiKey, idempotencyKey, body, fetchImpl });
    const verdict = classifyAttempt(attempt, attemptNumber);
    if (verdict.outcome === 'sent') {
      return { status: 'sent', ...safeSentRecord(attempt.json, attempt.replayed) };
    }
    if (verdict.outcome === 'fail') {
      return { status: 'failed', error_code: verdict.code, error_message: verdict.message };
    }
    lastReason = verdict.reason;
    lastAttempt = attempt;
    if (attemptNumber < MAX_ATTEMPTS) {
      log(`      ${verdict.reason}; retrying the same request in ${verdict.delaySeconds}s (no duplicate email)`);
      await sleepImpl(verdict.delaySeconds * 1000);
    }
  }
  // EMAIL_FAILED 是唯一能断定「没发出去」的 5xx：服务端返回它之前已回滚信封并释放去重行。
  // 其余 5xx / 409 / 网络错误都可能发生在邮件发出之后，只能报「不确定」
  if (lastAttempt?.kind === 'response' && lastAttempt.json?.error?.code === 'EMAIL_FAILED') {
    return {
      status: 'failed',
      error_code: 'EMAIL_FAILED',
      error_message: lastAttempt.json.error.message ?? 'The signature request email could not be sent',
    };
  }
  return { status: 'unknown', error_message: lastReason };
}

// ---------------------------------------------------------------------------
// 结果文件：本地记账，重跑时跳过已发出的行
// ---------------------------------------------------------------------------

export function resultsPathFor(planPath) {
  return planPath.endsWith('.json') ? `${planPath.slice(0, -5)}.sent.json` : `${planPath}.sent.json`;
}

function loadResults(path) {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!isPlainObject(data) || typeof data.plan_id !== 'string' || !Array.isArray(data.rows)) {
    throw new Error(`${path} is not a results file written by this script`);
  }
  return data;
}

function saveResults(path, data) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, path);
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

export function runCheck(planPath, { log }) {
  const plan = readPlanFile(planPath);
  const result = validatePlan(plan, dirname(planPath));
  log(`Plan ${basename(planPath)}: ${result.rows.length} signature request(s), one email each`);
  log(`Dates stamped in time zone: ${result.senderTimezone}`);
  printPlanTable(result.rows, log);
  for (const warning of result.warnings) log(`  ! ${warning}`);
  for (const error of result.errors) log(`  x ${error}`);
  if (result.errors.length > 0) {
    log(`Not ready: fix the ${result.errors.length} problem(s) above. Nothing was sent.`);
    return 1;
  }
  log('Ready to send. Nothing has been sent. Show this plan to the user and send only after they approve it.');
  return 0;
}

export async function runSend(planPath, { yes, env, log, fetchImpl = fetch, sleepImpl = sleep }) {
  if (!yes) {
    log('Refusing to send without --yes. Run "check" first, show the plan to the user, and add --yes only after they approve it.');
    return 2;
  }
  const plan = readPlanFile(planPath);
  const result = validatePlan(plan, dirname(planPath));
  if (result.errors.length > 0) {
    for (const error of result.errors) log(`  x ${error}`);
    log('Not sent: the plan has problems. Run "check" for details.');
    return 1;
  }
  const baseUrl = resolveBaseUrl(env);
  const apiKey = readApiKey(env);

  const resultsPath = resultsPathFor(planPath);
  const previous = loadResults(resultsPath);
  if (previous && previous.base_url !== baseUrl) {
    log(`Not sent: ${basename(resultsPath)} records sends to ${previous.base_url}, not ${baseUrl}. Start a new plan file for a different server.`);
    return 1;
  }
  const results = previous ?? { plan_id: randomUUID().slice(0, 8), base_url: baseUrl, rows: [] };
  // 先落盘 plan_id 再发第一个请求：请求到了服务端而进程在写盘前崩掉时，重跑必须拿回同一个
  // plan_id（⇒ 同一个键 ⇒ 服务端回放），否则换了新键就是第二封信
  if (!previous) saveResults(resultsPath, results);

  // 已发出的行内容又被改过：再发就是第二封信，必须由人决定
  const keys = result.rows.map((row) => rowIdempotencyKey(results.plan_id, row, result.senderTimezone));
  for (const row of result.rows) {
    const earlier = results.rows.find((r) => r.row === row.index + 1 && r.status === 'sent');
    if (earlier && earlier.idempotency_key !== keys[row.index]) {
      log(`Not sent: row ${row.index + 1} was already sent (envelope ${earlier.envelope_id}) and has changed since. To send it again on purpose, start a new plan file with just that row.`);
      return 1;
    }
  }

  const where = baseUrl === DEFAULT_BASE_URL ? '' : ` to ${baseUrl}`;
  log(`Sending ${result.rows.length} signature request(s)${where}. Plan id ${results.plan_id}; results go to ${basename(resultsPath)}.`);
  let exitCode = 0;
  const counts = { sent: 0, replayed: 0, skipped: 0 };
  for (const row of result.rows) {
    const key = keys[row.index];
    const who = row.name ? `${row.name} <${row.email}>` : `<${row.email}>`;
    const label = `  ${row.index + 1}/${result.rows.length} ${who}`;
    const earlier = results.rows.find((r) => r.idempotency_key === key && r.status === 'sent');
    if (earlier) {
      counts.skipped += 1;
      log(`${label}: already sent earlier (envelope ${earlier.envelope_id}); skipped`);
      continue;
    }
    const outcome = await sendRow({ row, idempotencyKey: key, senderTimezone: result.senderTimezone, baseUrl, apiKey, fetchImpl, sleepImpl, log });
    const record = { row: row.index + 1, email: row.email, idempotency_key: key, at: new Date().toISOString(), ...outcome };
    results.rows = results.rows.filter((r) => r.row !== record.row);
    results.rows.push(record);
    results.rows.sort((a, b) => a.row - b.row);
    saveResults(resultsPath, results);

    if (outcome.status === 'sent') {
      if (outcome.replayed) {
        counts.replayed += 1;
        log(`${label}: was already sent by an earlier run (no new email); envelope ${outcome.envelope_id}`);
      } else {
        counts.sent += 1;
        log(`${label}: sent; envelope ${outcome.envelope_id}; link valid until ${outcome.expires_at}`);
      }
      if (outcome.sender_timezone && outcome.sender_timezone !== result.senderTimezone) {
        log(`      note: Easy Sign stamped dates in ${outcome.sender_timezone}, not ${result.senderTimezone}`);
      }
      for (const warning of outcome.warnings ?? []) log(`      note from Easy Sign: ${warning}`);
      continue;
    }
    if (outcome.status === 'failed') {
      log(`${label}: not sent (${outcome.error_code}: ${outcome.error_message}). Nothing was emailed for this row.`);
      log(
        ACCOUNT_ERROR_CODES.includes(outcome.error_code)
          ? 'Stopped. This is about the API key or the Easy Sign account, not this row. Sort that out, then run the same command again; rows already sent will be skipped.'
          : 'Stopped. Fix this row and run the same command again; rows already sent will be skipped.',
      );
      exitCode = 1;
      break;
    }
    log(`${label}: no answer from Easy Sign after ${MAX_ATTEMPTS} tries (${outcome.error_message}). It may or may not have been sent.`);
    log('Stopped. Within 24 hours, running the same command again is safe: the same request will not email anyone twice.');
    exitCode = 3;
    break;
  }
  log(`Done: ${counts.sent} sent now, ${counts.replayed} found already sent, ${counts.skipped} skipped from earlier runs.`);
  return exitCode;
}

const USAGE = `Usage:
  node easy-sign-send.mjs check <plan.json>        validate the plan; sends nothing
  node easy-sign-send.mjs send <plan.json> --yes   send every row (after the user approves)`;

export async function main(argv, env, log = console.log) {
  const [command, planArg, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    log(USAGE);
    return command ? 0 : 2;
  }
  if (!planArg || !['check', 'send'].includes(command)) {
    log(USAGE);
    return 2;
  }
  const unknown = rest.filter((arg) => arg !== '--yes');
  if (unknown.length > 0 || (command === 'check' && rest.length > 0)) {
    log(`Unknown option: ${(unknown[0] ?? rest[0])}`);
    log(USAGE);
    return 2;
  }
  const planPath = resolve(planArg);
  try {
    if (command === 'check') return runCheck(planPath, { log });
    return await runSend(planPath, { yes: rest.includes('--yes'), env, log });
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
