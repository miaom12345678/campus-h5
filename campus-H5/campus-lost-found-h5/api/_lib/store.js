/**
 * 数据存储层（零依赖）
 * ------------------------------------------------
 * 三种模式自动切换：
 *   1. Vercel 部署 + 配置了 Vercel KV / Upstash Redis 环境变量
 *      （KV_REST_API_URL + KV_REST_API_TOKEN，或 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN）
 *      → 数据存云端 Redis，多实例共享、持久化。
 *   2. 本地开发（npm run dev，环境变量 LOCAL_STORE=1）
 *      → 数据存本地 JSON 文件（.data/db.json），重启不丢。
 *   3. 兜底（都不满足）
 *      → 内存存储，实例重启会丢，仅保证功能可跑通。
 *
 * 整个库是一个 JSON 文档 { posts, messages, users, claims, coupons }，
 * 读改写模型，对演示/课程项目足够；并发要求高时可换成真正的数据库。
 */

const KEY = 'lostfound:db';

function emptyDB() {
  return { posts: [], messages: [], users: [], claims: [], coupons: [] };
}

// ---------- Upstash / Vercel KV REST ----------
function restUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  ).replace(/\/$/, '');
}
function restToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ''
  );
}
function hasKV() {
  return !!(restUrl() && restToken());
}

async function kvGet() {
  const res = await fetch(restUrl() + '/get/' + KEY, {
    headers: { Authorization: 'Bearer ' + restToken() }
  });
  const j = await res.json();
  if (!j.result) return null;
  try {
    return JSON.parse(j.result);
  } catch (e) {
    return null;
  }
}

async function kvSet(db) {
  const body = new URLSearchParams();
  body.set('key', KEY);
  body.set('value', JSON.stringify(db));
  const res = await fetch(restUrl() + '/set', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + restToken(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!res.ok) throw new Error('KV 写入失败：' + res.status);
}

// ---------- 本地文件（仅 npm run dev） ----------
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(process.cwd(), '.data', 'db.json');

function fileGet() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}
function fileSet(db) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (e) {
    /* 忽略写入失败 */
  }
}

// ---------- 内存兜底 ----------
let memDB = null;

/** 读库 */
async function loadDB() {
  if (hasKV()) {
    try {
      const db = await kvGet();
      return db || emptyDB();
    } catch (e) {
      return emptyDB();
    }
  }
  if (process.env.LOCAL_STORE) return fileGet() || emptyDB();
  return memDB || emptyDB();
}

/** 写库 */
async function saveDB(db) {
  if (hasKV()) return kvSet(db);
  if (process.env.LOCAL_STORE) return fileSet(db);
  memDB = db;
}

/** 生成 id */
function genId(prefix) {
  return (
    (prefix || 'id') +
    '_' +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

module.exports = { loadDB, saveDB, genId, emptyDB, hasKV };
