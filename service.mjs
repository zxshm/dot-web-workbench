import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {collectReplyFiles} from './assets.mjs';
import {Questions} from './questions.mjs';
import {notificationSettings} from './preferences.mjs';

export function models() {
  const home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  try {
    const cache=JSON.parse(fs.readFileSync(path.join(home,'models_cache.json'),'utf8'));
    return (cache.models||[]).filter(m=>m.visibility==='list'&&Array.isArray(m.supported_reasoning_levels)).map(m=>({id:m.slug,name:m.display_name,efforts:m.supported_reasoning_levels.map(e=>e.effort),defaultEffort:m.default_reasoning_level}));
  } catch {return [];}
}
export function marker(id) { return '[工作台请求 ' + id + ']'; }
export function matchingTurn(turns, request) {
  return turns.find(t=>t.id === request.turn_id || t.items?.some(i=>(i.type==='userMessage'||(i.type==='functionCallOutput'&&['create_thread','send_message_to_thread'].includes(i.name))) && JSON.stringify(i).includes(marker(request.id))));
}
export class ChatService {
  constructor(store, native, config) { this.store=store; this.native=native; this.config=config; this.questions=new Questions(store); this.busy=new Set(); this.connection={ok:false,error:'正在连接客户端'}; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async()=>{
      try {
        if(this.config.projectId){
          const projects=await this.native.call('list_projects',{});
          if(!projects.projects.some(p=>p.projectId===this.config.projectId))throw new Error('客户端中未找到配置的项目。');
        }
        const validRemoteIds=new Map();
        const createdHere=new Set(this.store.conversations().filter(c=>c.created_here&&c.remote_id).map(c=>c.remote_id));
        for (const archived of [false,true]) {
          let cursor; const seen=new Set();
          do {
            const page=await this.native.call('list_threads',{mode:'history',source:'codex',hostId:'local',archived,limit:50,...(cursor?{cursor}:{})});
            for (const t of page.threads || []) {
              const scope=this.config.projectId&&t.projectId===this.config.projectId?'workbench-project':!t.projectId&&createdHere.has(t.id)?'projectless':null;
              if(scope){this.store.syncConversation(t,archived,scope);if(!archived)validRemoteIds.set(t.id,scope);}
            }
            cursor=page.nextCursor; if(cursor && seen.has(cursor)) throw new Error('客户端对话分页异常。'); seen.add(cursor);
          } while(cursor);
        }
        this.validRemoteIds=validRemoteIds;
        this.connection={ok:true,checkedAt:new Date().toISOString()};
      } catch(e) { this.connection={ok:false,error:e.message}; throw e; }
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  submit(body) {
    const {id,conversationId,text='',model,effort,email='',attachmentIds=[]}=body;
    const settings=notificationSettings(this.store,this.config);
    const notify=body.notify===true&&settings.enabled;
    if(notify&&(!settings.email||email!==settings.email))throw new Error('通知邮箱已更新，请刷新页面后发送。');
    if(typeof text!=='string'||text.length>100000||(!text.trim()&&!attachmentIds.length)) throw new Error('请输入消息或添加附件，文字上限为 10 万字符。');
    const selected=models().find(m=>m.id===model);
    if(!selected?.efforts.includes(effort)) throw new Error('模型不支持所选推理强度。');
    if(typeof email!=='string'||(email&&!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(email))||email.length>254) throw new Error('通知邮箱格式不正确。');
    if(!Array.isArray(attachmentIds)||attachmentIds.length>12||new Set(attachmentIds).size!==attachmentIds.length) throw new Error('最多上传 12 个不同附件。');
    const files=attachmentIds.map(id=>this.store.file(id)); if(files.some(f=>!f)) throw new Error('附件不存在，请重新上传。');
    const result=this.store.submit(id,conversationId,{text,model,effort,email:notify?settings.email:'',notify,files});
    if(email) {const emails=this.store.setting('emails')||[];this.store.setting('emails',[...new Set([...emails,email])].slice(-30));}
    return result;
  }
  async approve(id, summary='') {
    const r=this.store.request(id); if(!r) throw new Error('请求不存在。');
    if(r.status!=='pending') return r;
    this.store.update(id,{status:'approved',summary:summary.slice(0,12000)});
    await this.dispatch(id); return this.store.request(id);
  }
  prompt(r) {
    const p=r.payload;
    const helper=path.join(import.meta.dirname,'ask_web.py');
    return `${marker(r.id)}\n此请求由用户在Dot 网页工作台点击发送，经 Dot 转交。请处理以下原文，附件属于本次请求。\n\n${p.text}\n\n附件清单：\n${p.files.map(f=>`${f.name}\n本机路径：${f.path}\nSHA-256：${f.sha256}`).join('\n')||'无'}\n\n${r.summary?'Dot 整理说明（用户原文优先）：\n'+r.summary+'\n':''}请在当前对话正常回复，所有完成通知、提问提醒和邮件由外部程序统一负责，不要另行发送邮件或在客户端另建提醒，尤其不要绕过用户未勾选通知的选择。若需要用户澄清或选项决定，必须优先使用网页提问通道：通过 exec_command 执行 python "${helper}" --request ${r.id} --port ${this.config.port}，把 JSON 数组通过标准输入传给它（在 PowerShell 可用单引号 here-string 管道）；每项格式为 {"id":"唯一英文编号","question":"问题正文","options":["选项一","选项二"]}，无选项可省略 options，每组 1 至 3 题。该程序会等待网页用户回答并输出答案；exec_command 返回进程编号时继续 write_stdin 等待原进程，不要自动选择、不要重复发问、不要因等待而结束本轮。网页通道用于普通澄清，不代替执行权限审批。如需交付文件，请保存在当前聊天工作目录中，并在最终回复使用 Markdown 链接给出文件的绝对路径；图片使用 Markdown 图片语法。网页将独立保存这些明确交付的文件，单个上限 50 MB。`;
  }
  async dispatch(id) {
    if(this.busy.has(id)) return; this.busy.add(id);
    let attempted=false;
    try {
      const r=this.store.request(id); if(r?.status!=='approved') return;
      await this.refresh();
      const c=this.store.conversation(r.conversation_id);
      if(c.archived) throw new Error('目标对话已归档。');
      if(c.remote_id&&this.validRemoteIds.get(c.remote_id)!==c.scope)throw new Error('目标对话当前不属于所选范围，已停止转交。');
      for(const file of r.payload.files){const bytes=fs.readFileSync(file.path);if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('附件已改变，停止转交：'+file.name);}
      if(c.remote_id) {
        const snapshot=await this.native.call('read_thread',{threadId:c.remote_id,hostId:'local',turnLimit:1});
        if(!['idle','notLoaded'].includes(snapshot.thread?.status?.type||snapshot.thread?.status)) return;
      }
      const prompt=this.prompt(r);
      this.store.update(id,{status:'sending',error:''}); attempted=true;
      let response;
      if(c.remote_id) response=await this.native.call('send_message_to_thread',{hostId:'local',threadId:c.remote_id,prompt,model:r.payload.model,thinking:r.payload.effort});
      else {
        const target=c.scope==='projectless'?{type:'projectless'}:{type:'project',projectId:this.config.projectId,environment:{type:'local'}};
        response=await this.native.call('create_thread',{target,title:c.title,prompt,model:r.payload.model,thinking:r.payload.effort});
        const remote=response.threadId||response.thread?.id;
        if(!remote) throw new Error('新对话创建结果未返回明确编号，请核对客户端。');
        this.store.link(c.id,remote);
      }
      this.store.update(id,{status:'sent'});
    } catch(e) {this.store.update(id,{status:attempted?'uncertain':'approved',error:e.message});}
    finally {this.busy.delete(id);}
  }
  async reconcile(id) {
    const r=this.store.request(id), c=this.store.conversation(r.conversation_id);
    if(!c.remote_id) return;
    let cursor,match,cwd; const seen=new Set();
    do {
      const page=await this.native.call('read_thread',{hostId:'local',threadId:c.remote_id,turnLimit:10,includeOutputs:true,maxOutputCharsPerItem:20000,...(cursor?{cursor}:{})});
      cwd=page.thread?.cwd;
      match=matchingTurn(page.turns||[],r); if(match) break;
      const oldest=(page.turns||[]).at(-1)?.startedAt;
      if(oldest && oldest*1000 < Date.parse(r.created)-10000) break;
      cursor=page.page?.nextCursor; if(cursor&&seen.has(cursor)) break;seen.add(cursor);
    } while(cursor);
    if(!match) return;
    const nativeQuestions=match.items.filter(i=>i.type==='userInputResponse').map(i=>({id:i.id,questions:i.questions,answers:i.answers,completed:i.completed,threadId:c.remote_id}));
    const messages=match.items.filter(i=>i.type==='agentMessage');
    const final=messages.filter(i=>i.phase==='final_answer');
    const reply=(final.length?final:messages).map(i=>i.text||'').join('\n\n');
    let status=['completed','failed','interrupted'].includes(match.status)?match.status:'sent';
    if(messages.some(i=>i.truncated||i.textTruncated)) status='uncertain';
    if(nativeQuestions.some(q=>!q.completed))status='sent';
    if(['completed','failed','interrupted'].includes(status))this.questions.expire(id);
    const assets=collectReplyFiles(this.store,r,reply,cwd);
    this.store.update(id,{status,turn_id:match.id,reply,native_questions:JSON.stringify(nativeQuestions),assets:JSON.stringify(assets),error:status==='uncertain'?'客户端返回的回复被截断，请在 Codex 查看完整内容；当前仅保存已读到的部分。':match.error?JSON.stringify(match.error):''});
    if(['completed','failed','interrupted'].includes(status)) await this.notify(id);
  }
  async notify(id) {
    const r=this.store.request(id); if(!r||!['completed','failed','interrupted'].includes(r.status)||r.mail_status!=='none')return;
    if(r.payload.notify===false||!r.payload.email||!notificationSettings(this.store,this.config).enabled){this.store.update(id,{mail_status:'skipped'});return;}
    this.store.update(id,{mail_status:'sending'});
    const title=this.store.conversation(r.conversation_id).title;
    const payload={recipient:r.payload.email,title,body:`对话：${title}\n请求：${id}\n状态：${r.status}\n模型：${r.payload.model} / ${r.payload.effort}\n\n${r.reply||r.error}\n\n打开本机界面：http://127.0.0.1:${this.config.port}\n本邮件只说明该轮处理状态，不代表实机验收。`};
    const result=await this.deliverMail(payload);
    this.store.update(id,{mail_status:result?'accepted':'unknown'});
  }
  async deliverMail(payload){
    return new Promise(resolve=>{
      const p=spawn('python',[path.join(import.meta.dirname,'mail.py')],{windowsHide:true,stdio:['pipe','pipe','ignore']});
      const timeout=setTimeout(()=>{p.kill();resolve(false);},60000);
      p.on('error',()=>{clearTimeout(timeout);resolve(false);});p.stdin.on('error',()=>{});
      p.on('close',code=>{clearTimeout(timeout);resolve(code===0);});p.stdin.end(JSON.stringify(payload));
    });
  }
  async tick() {
    if(this.ticking) return;this.ticking=true;
    try {
      for(const r of this.store.active()) {
        if(r.status==='approved') await this.dispatch(r.id);
        else if(['sent','uncertain'].includes(r.status)) try{await this.reconcile(r.id);}catch(e){this.store.update(r.id,{error:e.message});}
      }
      for(const r of this.store.db.prepare("SELECT id FROM requests WHERE status IN ('completed','failed','interrupted') AND mail_status='none'").all()) await this.notify(r.id);
    } finally {this.ticking=false;}
  }
}
