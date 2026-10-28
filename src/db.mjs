import fs from 'node:fs';

/* Tiny JSON-file helper with an atomic write. Only the updates cursor and
   pending state use it; the workout data itself lives in openGym. */
let cache = null;

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

export function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

export function remember(key, value) {
  cache = cache || {};
  cache[key] = value;
}

export function recall(key) {
  return cache?.[key];
}

export function closeDb() {
  cache = null;
}
