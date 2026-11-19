import {createHash} from 'node:crypto';

const active=['sending','sent','uncertain'];
export class Questions {
  constructor(store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),content TEXT NOT NULL,answers TEXT,status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL,updated TEXT NOT NULL);`);
  }
  list(requestId){return this.store.db.prepare('SELECT * FROM questions WHERE request_id=? ORDER BY created').all(requestId).map(q=>({...q,content:JSON.parse(q.content),answers:q.answers?JSON.parse(q.answers):null}));}
  get(id){const q=this.store.db.prepare('SELECT * FROM questions WHERE id=?').get(id);return q?{...q,content:JSON.parse(q.content),answers:q.answers?JSON.parse(q.answers):null}:null;}
  create(requestId,content){
    const r=this.store.request(requestId);
    if(!r||!active.includes(r.status))throw new Error('该请求当前不能发起提问。');
    if(!Array.isArray(content)||content.length<1||content.length>3)throw new Error('每组需要 1 至 3 个问题。');
    const ids=new Set();
    for(const q of content){
      if(!q||typeof q.id!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(q.id)||ids.has(q.id))throw new Error('问题编号无效或重复。');
      ids.add(q.id);
      if(typeof q.question!=='string'||!q.question.trim()||q.question.length>8000)throw new Error('请提供有效的问题正文。');
      if(q.options!==undefined&&(!Array.isArray(q.options)||q.options.length>8||q.options.some(o=>typeof o!=='string'||!o.trim()||o.length>1000)||new Set(q.options).size!==q.options.length))throw new Error('问题选项无效。');
    }
    const normalized=content.map(q=>({id:q.id,question:q.question,options:q.options||[]}));
    const text=JSON.stringify(normalized),id=createHash('sha256').update(requestId+'\n'+text).digest('hex');
    const old=this.get(id);if(old)return old;
    if(this.list(requestId).some(q=>q.status==='pending'))throw new Error('请等待上一组问题答复后继续提问。');
    const now=new Date().toISOString();this.store.db.prepare('INSERT INTO questions(id,request_id,content,created,updated) VALUES (?,?,?,?,?)').run(id,requestId,text,now,now);
    return this.get(id);
  }
  answer(requestId,id,answers){
    const q=this.get(id),r=this.store.request(requestId);
    if(!q||q.request_id!==requestId)throw new Error('问题与当前请求不匹配。');
    if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).length!==q.content.length)throw new Error('请回答每个问题。');
    const clean=Object.fromEntries(q.content.map(item=>{
      const value=answers[item.id];if(typeof value!=='string'||!value.trim()||value.length>12000)throw new Error('请回答每个问题，单项最多 12000 字。');
      return [item.id,value.trim()];
    }));
    if(q.status==='answered'){if(JSON.stringify(q.answers)!==JSON.stringify(clean))throw new Error('该问题已经在某一端回答，不能覆盖。');return q;}
    if(q.status!=='pending'||!active.includes(r?.status))throw new Error('问题已经结束，请刷新查看最新状态。');
    this.store.db.prepare("UPDATE questions SET answers=?,status='answered',updated=? WHERE id=? AND status='pending'").run(JSON.stringify(clean),new Date().toISOString(),id);
    return this.get(id);
  }
  expire(requestId){this.store.db.prepare("UPDATE questions SET status='expired',updated=? WHERE request_id=? AND status='pending'").run(new Date().toISOString(),requestId);}
}
