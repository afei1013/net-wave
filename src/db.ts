import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

let db: Database.Database | null = null

/** 会话表结构：私聊（peer_a/peer_b）与房间（room_id）共用一张表，type 区分 */
const CONVERSATIONS_SCHEMA = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'room')),
  peer_a TEXT,
  peer_b TEXT,
  room_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(peer_a, peer_b)
`

/** 打开（并复用）数据中心目录下的 SQLite 数据库，执行轻量迁移 */
export function openDb(dataDir = process.env.DATA_DIR ?? './data'): Database.Database {
  if (db) return db
  mkdirSync(dataDir, { recursive: true })
  db = new Database(join(dataDir, 'net-wave.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      ${CONVERSATIONS_SCHEMA}
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL,
      peer_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, peer_id)
    );
    -- 房间审批申请：建房（room_id 为空、room_name 记申请名）；join 为旧版加入审批的
    -- 历史数据；view 为「房间历史查看权限」申请（端到端加密显示功能）
    CREATE TABLE IF NOT EXISTS room_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'join', 'view')),
      room_id INTEGER,
      room_name TEXT,
      peer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at INTEGER NOT NULL,
      handled_at INTEGER
    );
    -- 房间历史查看授权（端到端加密显示）：管理员授予/审批通过后写入，授权者可免加入查看全部明文
    CREATE TABLE IF NOT EXISTS room_view_grants (
      room_id INTEGER NOT NULL,
      peer_id TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS hidden_conversations (
      conversation_id INTEGER NOT NULL,
      peer_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_access_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
  `)
  // 增量迁移：既有库的 messages 增加 file_id（SQLite 无 ADD COLUMN IF NOT EXISTS）
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!messageColumns.some((c) => c.name === 'file_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN file_id TEXT')
  }
  // 增量迁移：既有库的 rooms 增加 created_by（创建者可删除房间）
  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]
  if (!roomColumns.some((c) => c.name === 'created_by')) {
    db.exec('ALTER TABLE rooms ADD COLUMN created_by TEXT')
  }
  // 增量迁移：既有库的 rooms 增加房间级加密标志（端到端加密显示，默认 1=加密）
  if (!roomColumns.some((c) => c.name === 'encrypted')) {
    db.exec('ALTER TABLE rooms ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1')
  }
  // 增量迁移：既有库的 peers 增加 ip/mac（消息区展示节点网络信息）
  const peerColumns = db.prepare('PRAGMA table_info(peers)').all() as { name: string }[]
  for (const column of ['ip', 'mac']) {
    if (!peerColumns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE peers ADD COLUMN ${column} TEXT`)
    }
  }
  // 增量迁移：既有库的 peers 增加隐私开关（隐藏后本人网络信息不再随消息/presence 下发）
  for (const column of ['hide_ip', 'hide_mac']) {
    if (!peerColumns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE peers ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
    }
  }
  // 增量迁移：既有库的 files 增加访问统计列（统一口径，见 ADR-0005）
  const fileColumns = db.prepare('PRAGMA table_info(files)').all() as { name: string }[]
  if (!fileColumns.some((c) => c.name === 'access_count')) {
    db.exec('ALTER TABLE files ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!fileColumns.some((c) => c.name === 'last_access_at')) {
    db.exec('ALTER TABLE files ADD COLUMN last_access_at INTEGER')
  }
  // 增量迁移：既有库的 files 增加媒体宽高（上传端探测存库，渲染时预留纵横比防布局抖动）
  for (const column of ['width', 'height']) {
    if (!fileColumns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE files ADD COLUMN ${column} INTEGER`)
    }
  }
  // 增量迁移：conversations 增加 type/room_id（旧结构为 peer_a/peer_b NOT NULL，需重建表）
  const convColumns = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
  if (!convColumns.some((c) => c.name === 'type')) {
    db.exec('BEGIN')
    try {
      db.exec(`
        CREATE TABLE conversations_migrated (${CONVERSATIONS_SCHEMA});
        INSERT INTO conversations_migrated (id, type, peer_a, peer_b, created_at)
          SELECT id, 'direct', peer_a, peer_b, created_at FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_migrated RENAME TO conversations;
      `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  // 增量迁移：room_requests 的 kind CHECK 扩展 'view'（历史查看权限申请），旧表约束写死需重建
  const requestsDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'room_requests'").get() as
    | { sql: string }
    | undefined)?.sql
  if (requestsDdl && !requestsDdl.includes("'view'")) {
    db.exec('BEGIN')
    try {
      db.exec(`
        CREATE TABLE room_requests_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('create', 'join', 'view')),
          room_id INTEGER,
          room_name TEXT,
          peer_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
          created_at INTEGER NOT NULL,
          handled_at INTEGER
        );
        INSERT INTO room_requests_migrated SELECT id, kind, room_id, room_name, peer_id, status, created_at, handled_at FROM room_requests;
        DROP TABLE room_requests;
        ALTER TABLE room_requests_migrated RENAME TO room_requests;
      `)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return db
}
