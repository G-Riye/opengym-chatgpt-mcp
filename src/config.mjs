/* Local configuration for the openGym <-> ChatGPT connector.
   Nothing here talks to the network; it only answers "where is the data, which
   profile, which port, is writing on". */
import fs from 'node:fs';
import path from 'node:path';

export const SELF = path.resolve(import.meta.dirname, '..');
export const ROOT = path.resolve(SELF, '..');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

const fileConfig = readJson(path.join(SELF, 'config.json'), {});
const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

export const config = {
  port: Number(env('MCP_PORT', fileConfig.port || 8787)),
  host: env('MCP_HOST', '127.0.0.1'),
  baseUrl: String(env('OPENGYM_BASE_URL', fileConfig.baseUrl || 'http://127.0.0.1:30347')).replace(/\/+$/, ''),
  dataDir: path.resolve(env('OPENGYM_DATA', fileConfig.dataDir || path.join(ROOT, 'data'))),
  writes: env('OPENGYM_ALLOW_WRITES', String(fileConfig.writes ?? true)) !== '0'
    && env('OPENGYM_ALLOW_WRITES', String(fileConfig.writes ?? true)) !== 'false',
  publicUrl: String(env('PUBLIC_URL', fileConfig.publicUrl || '')).replace(/\/+$/, '') || null,
  timezone: env('GYM_TZ', fileConfig.timezone || 'Asia/Shanghai'),
  tokenTtlDays: Number(env('OPENGYM_TOKEN_DAYS', fileConfig.tokenTtlDays || 3650)),
  proposalTtlMs: Number(env('PROPOSAL_TTL_MS', 15 * 60 * 1000)),
  backupKeep: Number(env('OPENGYM_BACKUP_KEEP', 30)),
  secretsDir: path.join(SELF, 'secrets'),
  storeDir: path.join(SELF, 'store'),
  backupsDir: path.join(SELF, 'store', 'backups'),
};

export function ensureDirs() {
  for (const dir of [config.secretsDir, config.storeDir, config.backupsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/* The tunnel script writes the current public base URL here. Reading it on
   every dashboard render means starting the tunnel after the connector still
   shows the right ChatGPT URL. */
export function effectivePublicUrl() {
  try {
    const file = path.join(config.storeDir, 'public-url.txt');
    const value = fs.readFileSync(file, 'utf8').trim().replace(/\/+$/, '');
    if (value) return value;
  } catch {}
  return config.publicUrl;
}

/* The profile this connector answers for. One state file or one user is the
   normal self-hosted case; anything else must be named with OPENGYM_UID. */
export function resolveUid() {
  const explicit = (process.env.OPENGYM_UID || '').trim();
  if (explicit) {
    if (!/^[A-Za-z0-9_-]+$/.test(explicit)) throw new Error('OPENGYM_UID 含有不能用在文件名里的字符');
    return explicit;
  }
  const files = fs.existsSync(config.dataDir)
    ? fs.readdirSync(config.dataDir).filter(f => /^state-[A-Za-z0-9_-]+\.json$/.test(f))
    : [];
  if (files.length === 1) return files[0].replace(/^state-/, '').replace(/\.json$/, '');
  const db = readJson(path.join(config.dataDir, 'db.json'), { users: [] });
  const users = Array.isArray(db.users) ? db.users : [];
  if (files.length === 0 && users.length === 1) return users[0].id;
  if (users.length > 1) throw new Error(`这个 data 目录里有 ${users.length} 个账号，请设置 OPENGYM_UID 指定其中一个`);
  throw new Error('没有找到 openGym 账号数据；请先启动 openGym 并登录一次');
}

export function loadDb() {
  return readJson(path.join(config.dataDir, 'db.json'), { users: [] });
}

export function userRecord(uid) {
  const db = loadDb();
  return (db.users || []).find(u => u.id === uid) || { id: uid, name: 'openGym' };
}

export function stateFile(uid) {
  return path.join(config.dataDir, `state-${uid.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}
