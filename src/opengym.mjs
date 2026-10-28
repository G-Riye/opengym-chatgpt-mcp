/* openGym API client.
   Reads come straight from ./data (atomic files, always current); writes go
   through PUT /api/data so the server keeps _rev/_wid/_ts and the web app's
   merge logic intact.

   Auth: a signed session token derived exactly the way api/server.js's
   makeSession() does it, from the instance's own ./data/secret. This is the
   same credential a paired phone uses (Authorization: Bearer). It is written
   to chatgpt/secrets/opengym-token.json and never printed. "Sign out
   everywhere" in openGym bumps the account's session version and revokes it. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs, loadDb, resolveUid, userRecord } from './config.mjs';

let cachedUid = null;

export function uid() {
  if (!cachedUid) cachedUid = resolveUid();
  return cachedUid;
}

function secret() {
  const file = path.join(config.dataDir, 'secret');
  if (!fs.existsSync(file)) throw new Error('找不到 openGym 的 data/secret；请先启动一次 openGym');
  return fs.readFileSync(file, 'utf8').trim();
}

function sign(payload) {
  return payload + '.' + crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function tokenFile() {
  return path.join(config.secretsDir, 'opengym-token.json');
}

function writeJson600(file, value) {
  ensureDirs();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
}

/* A long-lived token, minted once. The server's HMAC covers uid:expiry:version,
   so this is a normal session credential, not a bypass. */
export function ensureToken({ force = false } = {}) {
  const id = uid();
  const user = userRecord(id);
  const version = Number(user.sv || 0);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(tokenFile(), 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const now = Date.now();
  if (!force && saved && saved.uid === id && saved.version === version
      && typeof saved.token === 'string' && Number(saved.exp) > now + 30 * 86400000) {
    return saved.token;
  }
  const exp = now + Math.max(1, config.tokenTtlDays) * 86400000;
  const token = sign(`${id}:${exp}:${version}`);
  writeJson600(tokenFile(), { uid: id, version, exp, token, createdAt: new Date().toISOString() });
  return token;
}

async function api(method, endpoint, body, { timeoutMs = 20000 } = {}) {
  const token = ensureToken();
  let response;
  try {
    response = await fetch(config.baseUrl + endpoint, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new Error(`连不上 openGym（${config.baseUrl}${endpoint}）：${e.name === 'TimeoutError' ? '超时' : e.message}`);
  }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const detail = data && (data.error || data.code) ? `：${data.error || data.code}` : '';
    const err = new Error(`openGym 返回 HTTP ${response.status}${detail}`);
    err.status = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function me() {
  return api('GET', '/api/me');
}

export async function health() {
  return api('GET', '/api/health');
}

const USER_SELECT = 'id,name,created';

export async function putState(state, { baseRev, baseWid }) {
  // The server owns _rev; sending the read one back is harmless and lets its
  // sync-stamps layer know this writer read the document first (overRead).
  const body = { state, ...(Number.isInteger(baseRev) ? { baseRev } : {}), ...(baseWid ? { baseWid } : {}) };
  return api('PUT', '/api/data', body);
}

export async function verifyAuth() {
  try {
    await me();
    return true;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      ensureToken({ force: true });
      await me();
      return true;
    }
    throw e;
  }
}

export function userInfo() {
  const u = userRecord(uid());
  return { id: u.id, name: u.name || 'openGym', admin: !!u.admin, userSelect: USER_SELECT };
}

export function dataPaths() {
  return { dataDir: config.dataDir, uid: uid(), tokenFile: tokenFile(), baseUrl: config.baseUrl };
}
