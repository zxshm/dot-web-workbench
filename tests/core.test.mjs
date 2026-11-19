import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../store.mjs';
import {ChatService,matchingTurn,marker,models} from '../service.mjs';
import {Events,EVENT,isPublic,callbackUrl,secretValid} from '../webhook.mjs';
import {makeMcp} from '../mcp.mjs';

function fixture(t) {
  const parent=path.resolve(import.meta.dirname,'../runtime/tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'case-'));
  const store=new Store(root);t.after(()=>{store.close();if(path.dirname(root)!==parent)throw new Error('测试目录边界错误');fs.rmSync(root,{recursive:true,force:true});});
  const c=store.newConversation('联调测试'),id=randomUUID(),payload={text:'测试原文',model:models()[0].id,effort:models()[0].efforts[0],email:'',files:[]};
  return {store,c,id,payload,root};
}
test('重复提交保持原请求；不同内容不能复用编号',t=>{const f=fixture(t);const a=f.store.submit(f.id,f.c.id,f.payload);const b=f.store.submit(f.id,f.c.id,f.payload);assert.equal(a.id,b.id);assert.equal(f.store.history(f.c.id).length,1);assert.throws(()=>f.store.submit(f.id,f.c.id,{...f.payload,text:'不同内容'}));});
test('同一对话未完成时不能插入第二个请求',t=>{const f=fixture(t);f.store.submit(f.id,f.c.id,f.payload);assert.throws(()=>f.store.submit(randomUUID(),f.c.id,f.payload));f.store.update(f.id,{status:'completed'});assert.doesNotThrow(()=>f.store.submit(randomUUID(),f.c.id,f.payload));});
test('重启保留记录，发送中状态变为不确定，不自动重发',t=>{const f=fixture(t);f.store.submit(f.id,f.c.id,f.payload);f.store.update(f.id,{status:'sending',mail_status:'sending'});f.store.close();const again=new Store(f.root);assert.equal(again.request(f.id).status,'uncertain');assert.equal(again.request(f.id).mail_status,'unknown');f.store.db=again.db;});
test('附件名称不能越过上传目录且校验值与原文一致',t=>{const f=fixture(t);const upload=f.store.upload('../../外部.txt',Buffer.from('附件内容'));assert.equal(path.dirname(upload.path),path.join(f.root,'uploads'));assert.equal(fs.readFileSync(upload.path,'utf8'),'附件内容');assert.equal(upload.sha256.length,64);});
test('只关联本程序请求轮次，忽略其他消息及工具中的编号',()=>{const r={id:randomUUID()};const turns=[{id:'other',items:[{type:'agentMessage',text:marker(r.id)}]},{id:'bad',items:[{type:'functionCallOutput',name:'exec_command',output:marker(r.id)}]},{id:'match',items:[{type:'functionCallOutput',name:'send_message_to_thread',output:{text:marker(r.id)}}]}];assert.equal(matchingTurn(turns,r).id,'match');});
test('客户端异常后的重复 Dot 接收不会再调用发送',async t=>{const f=fixture(t);f.store.submit(f.id,f.c.id,f.payload);let sends=0;const native={call:async(name)=>{if(name==='list_projects')return {projects:[{projectId:'p',label:'示例项目'}]};if(name==='list_threads')return {threads:[]};if(name==='create_thread'){sends++;throw new Error('响应丢失');}}};const svc=new ChatService(f.store,native,{projectId:'p',projectName:'示例项目'});await svc.approve(f.id,'整理说明');await svc.approve(f.id,'重复事件');await svc.tick();assert.equal(sends,1);assert.equal(f.store.request(f.id).status,'uncertain');});
test('新建请求严格使用界面选择的模型和原始内容',async t=>{const f=fixture(t);f.store.submit(f.id,f.c.id,f.payload);let sent;const native={call:async(name,args)=>{if(name==='list_projects')return {projects:[{projectId:'p',label:'示例项目'}]};if(name==='list_threads')return {threads:[]};if(name==='create_thread'){sent=args;return {threadId:'remote'};}}};const svc=new ChatService(f.store,native,{projectId:'p',projectName:'示例项目'});await svc.approve(f.id,'整理说明');assert.equal(sent.model,f.payload.model);assert.equal(sent.thinking,f.payload.effort);assert.ok(sent.prompt.includes(f.payload.text));assert.ok(sent.prompt.includes(marker(f.id)));assert.equal(f.store.conversation(f.c.id).remote_id,'remote');assert.equal(f.store.request(f.id).status,'sent');});
test('目标移出项目后停止转交',async t=>{const f=fixture(t);f.store.link(f.c.id,'other-project');f.store.submit(f.id,f.c.id,f.payload);let sent=false;const svc=new ChatService(f.store,{call:async(name)=>{if(name==='list_projects')return {projects:[{projectId:'p',label:'示例项目'}]};if(name==='list_threads')return {threads:[]};sent=true;}},{projectId:'p',projectName:'示例项目'});await svc.approve(f.id);assert.equal(sent,false);assert.match(f.store.request(f.id).error,/不属于/);});
test('只持久保存匹配轮次的回复',async t=>{const f=fixture(t);f.store.link(f.c.id,'remote');f.store.submit(f.id,f.c.id,f.payload);f.store.update(f.id,{status:'sent'});const native={call:async()=>({turns:[{id:'unrelated',status:'completed',items:[{type:'agentMessage',text:'不要导入我'}]},{id:'ours',status:'completed',items:[{type:'userMessage',content:marker(f.id)},{type:'agentMessage',phase:'commentary',text:'过程'},{type:'agentMessage',phase:'final_answer',text:'本次结果'}]}]})};const svc=new ChatService(f.store,native,{});await svc.reconcile(f.id);assert.equal(f.store.request(f.id).reply,'本次结果');assert.equal(f.store.request(f.id).turn_id,'ours');assert.equal(f.store.request(f.id).status,'completed');});
test('通知回调拒绝私网、回环和不安全协议',()=>{for(const ip of ['127.0.0.1','10.0.0.1','169.254.1.1','192.168.1.1','::1','::ffff:127.0.0.1'])assert.equal(isPublic(ip),false);assert.equal(isPublic('8.8.8.8'),true);for(const u of ['http://example.com','https://127.0.0.1','https://user:pass@example.com','https://example.com:8443'])assert.throws(()=>callbackUrl(u));assert.equal(secretValid('weak'),false);});
test('订阅经挑战验证后保存，重复事件不再次投递',async t=>{const f=fixture(t);let deliveries=0;const events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async(s,body)=>{const p=JSON.parse(body);if(p.type==='verification')return {status:200,body:JSON.stringify({challenge:p.challenge})};deliveries++;return {status:202,body:'{}'};}});const params={name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/callback',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}};const a=await events.subscribe(params);const b=await events.subscribe(params);assert.equal(a.id,b.id);f.store.submit(f.id,f.c.id,f.payload);await events.tick();await events.tick();assert.equal(deliveries,1);assert.equal(f.store.request(f.id).event_status,'accepted');events.unsubscribe(params);assert.equal(events.status().connected,false);});
test('错误挑战不建立订阅，错误过滤参数被拒绝',async t=>{const f=fixture(t);const events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async()=>({status:200,body:'{"challenge":"wrong"}'})});const params={name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/callback',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}};await assert.rejects(events.subscribe(params));assert.equal(events.status().connected,false);await assert.rejects(events.subscribe({...params,arguments:{project:'other'}}));});
test('同一接收端续订保留编号并更新有效期，失败时保留已验证订阅',async t=>{
  const f=fixture(t);
  let probes=0;
  const events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async(s,body)=>{
    probes++;
    return {status:probes===1?200:503,body};
  }});
  const params={name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/callback',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}};
  const first=await events.subscribe({...params,ttlMs:60000});
  const renewal=await events.subscribe(params);
  assert.equal(renewal.id,first.id);
  assert.ok(Date.parse(renewal.refreshBefore)>Date.parse(first.refreshBefore)+86400000);
  assert.equal(probes,1);
  assert.equal(events.status().diagnostic.operation,'renew');
  await assert.rejects(events.subscribe({...params,delivery:{...params.delivery,secret:'whsec_'+Buffer.alloc(32,2).toString('base64')}}));
  assert.equal(probes,2);
  assert.equal(events.status().expires,renewal.refreshBefore);
  assert.equal(events.subscription().secret,params.delivery.secret);
});
test('明确请求长期订阅可跨重启发送，取消后停止投递',async t=>{
  const f=fixture(t);
  let deliveries=0;
  const options={seal:x=>x,unseal:x=>x,send:async(s,body)=>{
    if(JSON.parse(body).type==='verification')return {status:200,body};
    deliveries++;
    return {status:202};
  }};
  const params={name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/callback',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')},ttlMs:null};
  const result=await new Events(f.store,options).subscribe(params);
  assert.equal(result.refreshBefore,null);
  f.store.close();f.store.db=new Store(f.root).db;
  const events=new Events(f.store,options);
  assert.equal(events.status().lifetime,'persistent');
  assert.equal(events.status().connected,true);
  f.store.submit(f.id,f.c.id,f.payload);
  await events.tick();
  assert.equal(deliveries,1);
  events.unsubscribe(params);
  assert.equal(events.status().connected,false);
  await events.tick();
  assert.equal(deliveries,1);
});
test('Dot 轮换同来源回调地址时只在验证通过后切换，迟到的旧取消无效',async t=>{
  const f=fixture(t);
  let allowNew=false;
  const initial={name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/original',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')},ttlMs:60000};
  const rotated={...initial,ttlMs:undefined,delivery:{...initial.delivery,url:'https://example.com/replacement'}};
  const events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async(sub,body)=>({status:sub.url===initial.delivery.url||allowNew?200:503,body})});
  await events.subscribe(initial);
  await assert.rejects(events.subscribe(rotated),{reason:'challenge_failed'});
  assert.equal(events.subscription().url,initial.delivery.url);
  allowNew=true;
  const replacement=await events.subscribe(rotated);
  assert.equal(events.status().diagnostic.operation,'rotate_callback');
  assert.equal(events.status().expires,replacement.refreshBefore);
  events.unsubscribe(initial);
  assert.equal(events.subscription().url,rotated.delivery.url);
  await assert.rejects(events.subscribe({...rotated,delivery:{...rotated.delivery,url:'https://other.example/new'}}),{reason:'already_bound'});
});
test('MCP 2.0 能发现四个工具及独立事件',async()=>{const handler=makeMcp({store:{active:()=>[]},connection:{}},{status:()=>({connected:false})});try{for(const method of ['server/discover','tools/list','events/list']){const r=await handler.fetch(new Request('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})}));assert.equal(r.status,200);const p=await r.json();if(method==='tools/list')assert.equal(p.result.tools.length,4);if(method==='events/list')assert.equal(p.result.events[0].name,EVENT);}}finally{await handler.close();}});
test('附件被改动后不转交任务',async t=>{const f=fixture(t);const file=f.store.upload('验收.txt',Buffer.from('原始'));f.store.submit(f.id,f.c.id,{...f.payload,files:[file]});fs.writeFileSync(file.path,'变化');let sent=false;const svc=new ChatService(f.store,{call:async(name)=>{if(name==='list_projects')return {projects:[{projectId:'p',label:'示例项目'}]};if(name==='list_threads')return {threads:[]};sent=true;}},{projectId:'p',projectName:'示例项目'});await svc.approve(f.id);assert.equal(sent,false);assert.match(f.store.request(f.id).error,/附件已改变/);});
test('瞬时回调失败按同一事件编号重试，成功后停止',async t=>{const f=fixture(t);const ids=[];const events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async(s,body,id)=>{const p=JSON.parse(body);if(p.type==='verification')return {status:200,body:JSON.stringify({challenge:p.challenge})};ids.push(id);return {status:ids.length===1?503:202,body:'{}'};}});await events.subscribe({name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/callback',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}});f.store.submit(f.id,f.c.id,f.payload);await events.tick();assert.equal(f.store.request(f.id).event_status,'retry');await events.tick();assert.equal(ids.length,1);f.store.update(f.id,{event_next:0});await events.tick();await events.tick();assert.deepEqual(ids,[f.id,f.id]);assert.equal(f.store.request(f.id).event_attempts,2);});
test('非法模型、强度和邮箱不能进入待处理队列',t=>{const f=fixture(t);const svc=new ChatService(f.store,{},{});const input={id:f.id,conversationId:f.c.id,text:'测试',model:f.payload.model,effort:f.payload.effort};assert.throws(()=>svc.submit({...input,model:'fake'}));assert.throws(()=>svc.submit({...input,effort:'fake'}));assert.throws(()=>svc.submit({...input,email:'a@example.com\r\nBcc:b@example.com'}));assert.equal(f.store.active().length,0);});

test('订阅诊断保留失败阶段且不泄漏回调或密钥',async t=>{
  const f=fixture(t),secret='whsec_'+Buffer.alloc(32,2).toString('base64');
  const events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async()=>{throw Object.assign(new Error('敏感回调信息'),{code:'ETIMEDOUT'});}});
  await assert.rejects(events.subscribe({name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/private-callback',secret}}),{reason:'timeout'});
  const d=events.status().diagnostic;assert.equal(d.stage,'callback_verification');assert.equal(d.reason,'timeout');assert.equal(events.status().connected,false);
  assert.ok(!JSON.stringify(d).includes(secret));assert.ok(!JSON.stringify(d).includes('private-callback'));assert.ok(!JSON.stringify(d).includes('敏感'));
});

test('MCP 订阅请求返回分类错误并记录本机接收',async t=>{
  const f=fixture(t),events=new Events(f.store,{seal:x=>x,unseal:x=>x,send:async()=>({status:503,body:'{}'})});
  const handler=makeMcp({store:f.store,connection:{}},events);
  try{
    const response=await handler.fetch(new Request('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','mcp-protocol-version':'2026-07-28','mcp-method':'events/subscribe'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:EVENT,arguments:{project:'workbench-project'},delivery:{mode:'webhook',url:'https://example.com/callback',secret:'whsec_'+Buffer.alloc(32,3).toString('base64')},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})}));
    const payload=await response.json();assert.equal(payload.error.code,-32015);assert.equal(payload.error.data.reason,'challenge_failed');assert.equal(events.status().diagnostic.httpStatus,503);assert.equal(events.status().connected,false);
  }finally{await handler.close();}
});

test('新建聊天的 create_thread 输入能匹配原始请求',()=>{
  const r={id:randomUUID()};assert.equal(matchingTurn([{id:'new',items:[{type:'functionCallOutput',name:'create_thread',output:{text:'<input>'+marker(r.id)+'</input>'}}]}],r).id,'new');
});
test('无项目新建使用 projectless 目标，两个范围独立保存',async t=>{
  const f=fixture(t),c=f.store.newConversation('无项目测试','projectless');f.store.submit(f.id,c.id,f.payload);let target;
  const svc=new ChatService(f.store,{call:async(name,args)=>{if(name==='list_projects')return {projects:[{projectId:'p',label:'示例项目'}]};if(name==='list_threads')return {threads:[]};if(name==='create_thread'){target=args.target;return {threadId:'plain'};}}},{projectId:'p',projectName:'示例项目'});
  await svc.approve(f.id);assert.deepEqual(target,{type:'projectless'});assert.equal(f.store.conversation(c.id).scope,'projectless');assert.equal(f.store.conversation(f.c.id).scope,'workbench-project');assert.throws(()=>f.store.newConversation('非法','other'));
});
test('列表仅包含选定项目和本程序新建会话，不导入无项目旧会话',async t=>{
  const f=fixture(t);const own=f.store.newConversation('本程序无项目','projectless');f.store.link(own.id,'own');const svc=new ChatService(f.store,{call:async(name,args)=>name==='list_projects'?{projects:[{projectId:'p',label:'示例项目'}]}:{threads:args.archived?[]:[{id:'own',title:'本程序无项目',updatedAt:1},{id:'p1',projectId:'p',title:'项目',updatedAt:1},{id:'plain',title:'无项目',updatedAt:1},{id:'other',projectId:'other',title:'其他项目',updatedAt:1}]}},{projectId:'p',projectName:'示例项目'});
  await svc.refresh();assert.equal(f.store.conversation('plain'),undefined);assert.equal(f.store.conversation(own.id).created_here,1);assert.equal(f.store.conversation(own.id).scope,'projectless');assert.equal(f.store.conversation('p1').scope,'workbench-project');assert.equal(f.store.conversation('other'),undefined);assert.deepEqual(f.store.history('plain'),[]);
});

test('修正前已缓存的无项目旧会话不出现在列表中',t=>{
  const f=fixture(t);f.store.syncConversation({id:'old-external',title:'客户端旧对话',updatedAt:1},false,'projectless');
  const own=f.store.newConversation('网页新建','projectless');const rows=f.store.conversations();
  assert.ok(!rows.some(c=>c.id==='old-external'));assert.ok(rows.some(c=>c.id===own.id));assert.ok(rows.some(c=>c.id===f.c.id));
});
