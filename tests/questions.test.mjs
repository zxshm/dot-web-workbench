import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../store.mjs';
import {Questions} from '../questions.mjs';
import {notificationSettings,saveNotificationSettings} from '../preferences.mjs';
import {ChatService,models} from '../service.mjs';
import {JSDOM} from 'jsdom';
import http from 'node:http';
import {spawn} from 'node:child_process';

function setup(t){
  const parent=path.resolve(import.meta.dirname,'../runtime/tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'question-'));
  const store=new Store(root),c=store.newConversation('测试'),id=randomUUID();
  const payload={text:'测试',files:[],model:models()[0].id,effort:models()[0].efforts[0],email:'test@example.com',notify:true};
  store.submit(id,c.id,payload);store.update(id,{status:'sent'});
  t.after(()=>{store.close();assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});});
  return {store,id,c,payload,root};
}
const content=[{id:'color',question:'选择测试颜色',options:['蓝色','绿色']},{id:'note',question:'补充说明'}];
test('问题重复创建和重复回答幂等，跨请求和多端覆盖被拒绝',t=>{
  const {store,id}=setup(t),questions=new Questions(store),q=questions.create(id,content);
  assert.equal(questions.create(id,content).id,q.id);assert.equal(questions.list(id).length,1);
  assert.throws(()=>questions.answer('other',q.id,{color:'蓝色',note:'测试'}));
  assert.throws(()=>questions.answer(id,q.id,{color:'蓝色'}));
  questions.answer(id,q.id,{color:'蓝色',note:'测试'});
  assert.equal(questions.answer(id,q.id,{note:'测试',color:'蓝色'}).status,'answered');
  assert.throws(()=>questions.answer(id,q.id,{color:'绿色',note:'测试'}));
});
test('服务重启保留待答问题与答案，结束后不能回答过期问题',t=>{
  const f=setup(t);let q=new Questions(f.store);const item=q.create(f.id,content);
  f.store.close();const again=new Store(f.root);f.store.db=again.db;q=new Questions(f.store);
  assert.equal(q.get(item.id).status,'pending');q.expire(f.id);
  assert.throws(()=>q.answer(f.id,item.id,{color:'蓝色',note:'测试'}));
});
test('邮箱设置存服务端；旧版本不能覆盖另一端；取消通知跳过积压',t=>{
  const {store,id}=setup(t),config={defaultEmail:'first@example.com'};
  const before=notificationSettings(store,config);
  saveNotificationSettings(store,config,{...before,email:'second@example.com',enabled:false});
  assert.equal(notificationSettings(store,config).email,'second@example.com');assert.equal(store.request(id).mail_status,'skipped');
  assert.throws(()=>saveNotificationSettings(store,config,{...before,email:'stale@example.com'}));
  assert.throws(()=>saveNotificationSettings(store,config,{version:1,email:'a@example.com\r\nBcc:b@example.com',enabled:true}));
});
test('单轮取消通知或总开关关闭都不调用邮件发送，重新打开不补发',async t=>{
  const {store,id}=setup(t),service=new ChatService(store,{},{});let calls=0;service.deliverMail=async()=>{calls++;return true;};
  store.update(id,{status:'completed'});store.setting('notification',{email:'new@example.com',enabled:false,version:1});
  await service.notify(id);assert.equal(calls,0);assert.equal(store.request(id).mail_status,'skipped');
  store.setting('notification',{email:'new@example.com',enabled:true,version:2});await service.notify(id);assert.equal(calls,0);
  const c=store.newConversation('无通知'),other=randomUUID();store.submit(other,c.id,{email:'test@example.com',notify:false,files:[]});store.update(other,{status:'completed'});
  await service.notify(other);assert.equal(calls,0);
});
test('明确勾选的已完成请求只通知一次，待答时不发完成邮件',async t=>{
  const {store,id}=setup(t),service=new ChatService(store,{},{});const deliveries=[];service.deliverMail=async p=>{deliveries.push(p);return true;};
  store.setting('notification',{email:'test@example.com',enabled:true,version:1});
  await service.notify(id);assert.equal(deliveries.length,0);store.update(id,{status:'completed'});
  await service.notify(id);await service.notify(id);assert.equal(deliveries.length,1);assert.equal(deliveries[0].recipient,'test@example.com');
});
test('提交时以后端设置为准，未勾选仍带邮箱也不会发送',t=>{
  const f=setup(t);f.store.update(f.id,{status:'completed'});const service=new ChatService(f.store,{},{});
  f.store.setting('notification',{email:'shared@example.com',enabled:true,version:1});
  const body={id:randomUUID(),conversationId:f.c.id,text:'测试',model:f.payload.model,effort:f.payload.effort,email:'stale@example.com',notify:false};
  const r=service.submit(body);assert.equal(r.payload.email,'');assert.equal(r.payload.notify,false);
  f.store.update(r.id,{status:'completed'});assert.throws(()=>service.submit({...body,id:randomUUID(),notify:true}));
});
test('网页选项、自由回答、草稿恢复和提交使用原问题编号',async()=>{
  const dom=new JSDOM('<body></body>',{url:'http://localhost'});globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
  const {renderQuestions}=await import('../public/questions.js');const calls=[];let refreshed=false;
  const r={id:'request',questions:[{id:'group',status:'pending',content:content.map(q=>({...q,options:q.options||[]}))}]};
  const render=()=>renderQuestions(r,async(url,payload)=>{calls.push({url,payload});},async()=>{refreshed=true;},message=>assert.fail(message));
  let card=render();card.querySelector('button').click();let inputs=card.querySelectorAll('textarea');inputs[1].value='自定义补充';inputs[1].dispatchEvent(new dom.window.Event('input'));
  card=render();inputs=card.querySelectorAll('textarea');assert.equal(inputs[0].value,'蓝色');assert.equal(inputs[1].value,'自定义补充');
  await card.querySelector('form').onsubmit({preventDefault(){}});assert.deepEqual(calls[0].payload,{requestId:'request',id:'group',answers:{color:'蓝色',note:'自定义补充'}});assert.equal(refreshed,true);
  dom.window.close();delete globalThis.document;delete globalThis.localStorage;
});
test('Python 提问通道按 UTF-8 读取中文，原进程得到原问题的回答',async()=>{
  let received;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/state'){res.end(JSON.stringify({csrf:'test'}));return;}
    if(req.url==='/api/questions/create'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);received=JSON.parse(Buffer.concat(chunks));
      res.end(JSON.stringify({id:'test-group',status:'pending'}));return;
    }
    res.end(JSON.stringify({id:'test-group',status:'answered',content:received.questions,answers:{color:'蓝色'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const child=spawn('python',['ask_web.py','--request','test-request','--port',String(server.address().port)],{cwd:path.resolve(import.meta.dirname,'..'),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b.toString('utf8'));child.stderr.on('data',b=>stderr+=b.toString('utf8'));
    child.stdin.end(JSON.stringify(content));
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    assert.equal(code,0,stderr);assert.deepEqual(received.questions,content);assert.equal(JSON.parse(stdout).answers.color,'蓝色');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
