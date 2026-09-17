'use strict';

/**
 * シンプルな JSON ファイル永続化ストア。
 * - ネイティブビルド不要でポータブル
 * - 書き込みはアトミック（一時ファイル + rename）
 * - 読み書きは直列化して競合を防止
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY_DB = { events: [], participants: [], meta: { nextEventId: 1, nextParticipantId: 1 } };

let cache = null;
let writeChain = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    cache = JSON.parse(JSON.stringify(EMPTY_DB));
    return cache;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = normalize(parsed);
  } catch (err) {
    // 破損時はバックアップして初期化
    const backup = DB_FILE + '.corrupt-' + Date.now();
    try { fs.renameSync(DB_FILE, backup); } catch (_) { /* ignore */ }
    console.error('[store] db.json が破損していたため初期化しました。バックアップ:', backup, err.message);
    cache = JSON.parse(JSON.stringify(EMPTY_DB));
  }
  return cache;
}

function normalize(db) {
  const out = {
    events: Array.isArray(db.events) ? db.events : [],
    participants: Array.isArray(db.participants) ? db.participants : [],
    meta: db.meta && typeof db.meta === 'object' ? db.meta : { nextEventId: 1, nextParticipantId: 1 },
  };
  if (!Number.isInteger(out.meta.nextEventId)) {
    out.meta.nextEventId = out.events.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
  }
  if (!Number.isInteger(out.meta.nextParticipantId)) {
    out.meta.nextParticipantId = out.participants.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
  }
  return out;
}

/** アトミックかつ直列化された保存 */
function persist() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        ensureDir();
        const tmp = DB_FILE + '.tmp-' + process.pid + '-' + Date.now();
        fs.writeFile(tmp, snapshot, 'utf8', (err) => {
          if (err) return reject(err);
          fs.rename(tmp, DB_FILE, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  return writeChain;
}

function nextId(kind) {
  const db = load();
  const key = kind === 'event' ? 'nextEventId' : 'nextParticipantId';
  const id = db.meta[key] || 1;
  db.meta[key] = id + 1;
  return id;
}

/** 読み取り専用で DB を取得（直接変更しないこと） */
function read() {
  return load();
}

/** 変更 + 保存をまとめて実行 */
async function mutate(fn) {
  const db = load();
  const result = fn(db);
  await persist();
  return result;
}

module.exports = { read, mutate, nextId, persist, DB_FILE, DATA_DIR };
