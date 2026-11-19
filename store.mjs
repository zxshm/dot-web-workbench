import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

export class Store {
  constructor(root) {
    this.root = root; fs.mkdirSync(path.join(root, 'uploads'), {recursive:true});
    this.db = new DatabaseSync(path.join(root, 'history.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,remote_id TEXT UNIQUE,title TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),fingerprint TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,turn_id TEXT,summary TEXT NOT NULL DEFAULT '',reply TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',mail_status TEXT NOT NULL DEFAULT 'none',event_status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    const columns=this.db.prepare('PRAGMA table_info(requests)').all().map(c=>c.name);
    if(!columns.includes('event_attempts'))this.db.exec('ALTER TABLE requests ADD COLUMN event_attempts INTEGER NOT NULL DEFAULT 0');
    if(!columns.includes('event_next'))this.db.exec('ALTER TABLE requests ADD COLUMN event_next INTEGER NOT NULL DEFAULT 0');
    if(!columns.includes('native_questions'))this.db.exec("ALTER TABLE requests ADD COLUMN native_questions TEXT NOT NULL DEFAULT '[]'");
    if(!columns.includes('assets'))this.db.exec("ALTER TABLE requests ADD COLUMN assets TEXT NOT NULL DEFAULT '{}'");
    if(!this.db.prepare('PRAGMA table_info(conversations)').all().some(c=>c.name==='scope'))this.db.exec("ALTER TABLE conversations ADD COLUMN scope TEXT NOT NULL DEFAULT 'workbench-project'");
    if(!this.db.prepare('PRAGMA table_info(conversations)').all().some(c=>c.name==='created_here')){
      this.db.exec('ALTER TABLE conversations ADD COLUMN created_here INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE conversations SET created_here=1 WHERE id LIKE 'local-%'");
    }
    this.db.prepare("UPDATE requests SET status='uncertain',error='程序在发送期间退出，需核对客户端；不会自动重发。' WHERE status='sending'").run();
    this.db.prepare("UPDATE requests SET mail_status='unknown' WHERE mail_status='sending'").run();
    this.db.prepare("UPDATE requests SET event_status='unknown' WHERE event_status='sending'").run();
  }
  setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || 'null');
  }
  conversation(id) { return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id); }
  conversations() { return this.db.prepare("SELECT conversations.*,EXISTS(SELECT 1 FROM requests WHERE conversation_id=conversations.id) AS has_records FROM conversations WHERE scope='workbench-project' OR created_here=1 ORDER BY updated DESC").all(); }
  newConversation(title, scope='workbench-project') {
    if(!['workbench-project','projectless'].includes(scope))throw new Error('请选择选定项目或无项目。');
    const id = 'local-' + randomUUID();
    this.db.prepare('INSERT INTO conversations(id,title,updated,scope,created_here) VALUES (?,?,?,?,1)').run(id,title,new Date().toISOString(),scope);
    return this.conversation(id);
  }
  syncConversation(t, archived, scope='workbench-project') {
    const id = this.db.prepare('SELECT id FROM conversations WHERE remote_id=?').get(t.id)?.id || t.id;
    const updated = new Date(t.updatedAt > 1e12 ? t.updatedAt : t.updatedAt * 1000).toISOString();
    this.db.prepare('INSERT INTO conversations(id,remote_id,title,archived,updated,scope) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,archived=excluded.archived,scope=excluded.scope,updated=MAX(conversations.updated,excluded.updated)').run(id,t.id,t.title || '未命名对话',archived?1:0,updated,scope);
  }
  link(id, remoteId) { this.db.prepare('UPDATE conversations SET remote_id=? WHERE id=?').run(remoteId,id); }
  upload(name, bytes) {
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('每个附件需要在 1 字节至 50 MB 之间。');
    const id = randomUUID(), safe = path.basename(name.replaceAll('\\','/')).replace(/[<>:"|?*\x00-\x1f]/g,'_').slice(0,150);
    if (!safe || safe === '.' || safe === '..') throw new Error('附件名称无效。');
    const dest = path.join(this.root,'uploads',id + '-' + safe);
    fs.writeFileSync(dest, bytes, {flag:'wx'});
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?)').run(id,safe,bytes.length,sha,dest);
    return this.file(id);
  }
  file(id) { return this.db.prepare('SELECT * FROM uploads WHERE id=?').get(id); }
  request(id) {
    const r = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    return r ? {...r,payload:JSON.parse(r.payload),assets:JSON.parse(r.assets||'{}'),native_questions:JSON.parse(r.native_questions||'[]')} : null;
  }
  history(id) { return this.db.prepare('SELECT id FROM requests WHERE conversation_id=? ORDER BY created').all(id).map(r=>this.request(r.id)); }
  active() { return this.db.prepare("SELECT id FROM requests WHERE status IN ('pending','approved','sent','uncertain') ORDER BY created").all().map(r=>this.request(r.id)); }
  submit(id, conversationId, payload) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效请求编号。');
    const fingerprint = createHash('sha256').update(JSON.stringify({conversationId,payload})).digest('hex');
    const old = this.request(id);
    if (old) { if (old.fingerprint !== fingerprint) throw new Error('同一请求编号不能用于不同内容。'); return old; }
    const c = this.conversation(conversationId); if (!c || c.archived) throw new Error('请选择一个未归档的对话。');
    if (this.history(conversationId).some(r=>['pending','approved','sending','sent','uncertain'].includes(r.status))) throw new Error('此对话仍有未完成请求，请处理完成后继续发送。');
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO requests(id,conversation_id,fingerprint,payload,status,created,updated) VALUES (?,?,?,?,?,?,?)').run(id,conversationId,fingerprint,JSON.stringify(payload),'pending',now,now);
    this.db.prepare('UPDATE conversations SET updated=? WHERE id=?').run(now,conversationId);
    return this.request(id);
  }
  update(id, fields) {
    const allowed = ['status','turn_id','summary','reply','error','mail_status','event_status','event_attempts','event_next','assets','native_questions'];
    if (Object.keys(fields).some(k=>!allowed.includes(k))) throw new Error('无效状态字段。');
    fields.updated = new Date().toISOString(); const keys = Object.keys(fields);
    this.db.prepare(`UPDATE requests SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`).run(...keys.map(k=>fields[k]),id);
    return this.request(id);
  }
  close() { this.db.close(); }
}
