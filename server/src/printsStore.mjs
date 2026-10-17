import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadPrints, savePrints } from './speakers.mjs';

/**
 * 登记过的声纹。一个人一行，库在服务器磁盘上。
 * 整天的转写仍是 COS 上按天的文字文件，不进这个库。
 * 空表不能覆盖已经有人的库，免得重启把刚录的「我」冲掉。
 */
export function openPrintStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS voiceprint (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    vector TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM voiceprint');
  const readStmt = db.prepare('SELECT id, name, vector FROM voiceprint ORDER BY updated_at, id');
  const delStmt = db.prepare('DELETE FROM voiceprint');
  const insStmt = db.prepare('INSERT INTO voiceprint (id, name, vector, updated_at) VALUES (?, ?, ?, ?)');

  function count() {
    return countStmt.get().n;
  }

  function read() {
    const obj = {};
    for (const row of readStmt.all()) {
      let vector = [];
      try { vector = JSON.parse(row.vector); } catch { /* 坏行跳过 */ }
      obj[row.id] = { v: vector, name: row.name };
    }
    return loadPrints(obj);
  }

  function writeAll(prints, { allowEmpty = false } = {}) {
    const saved = savePrints(prints);
    const keys = Object.keys(saved);
    if (!keys.length && count() > 0 && !allowEmpty) {
      throw new Error('拒绝用空声纹覆盖已有的人');
    }
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      delStmt.run();
      for (const [id, p] of Object.entries(saved)) insStmt.run(id, p.name || '', JSON.stringify(p.v), now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { read, writeAll, count };
}
