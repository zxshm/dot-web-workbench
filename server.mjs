import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Store} from './store.mjs';
import {NativeBridge} from './native.mjs';
import {ChatService,models} from './service.mjs';
import {Events,sendWebhook} from './webhook.mjs';
import {makeMcp} from './mcp.mjs';
import {Tunnel} from './tunnel.mjs';
import {notificationSettings,saveNotificationSettings} from './preferences.mjs';
import {fileType} from './assets.mjs';

const root=import.meta.dirname;
const configPath=path.join(root,'config.json');
if(!fs.existsSync(configPath))throw new Error('请先把 config.example.json 复制为 config.json。');
const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
// 先独占监听端口，再打开记录库，避免重复启动误改运行中请求的状态。
const app=http.createServer(),mcpServer=http.createServer();
await Promise.all([[app,config.port],[mcpServer,config.mcpPort]].map(([server,port])=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);})));
const data=path.join(root,'data');
const store=new Store(data),native=new NativeBridge(config),service=new ChatService(store,native,config);
function crypt(mode,text) {
  const r=spawnSync('python',[path.join(root,'protect.py'),mode],{input:text,encoding:'utf8',windowsHide:true});
  if(r.status!==0)throw new Error('Windows 凭据加密服务不可用。');return r.stdout;
}
const instanceId=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
const secretsRoot=path.join(process.env.LOCALAPPDATA||os.homedir(),'DotWebWorkbench',instanceId);fs.mkdirSync(secretsRoot,{recursive:true});
const tokenPath=path.join(secretsRoot,'mcp-token.dpapi');
if(!fs.existsSync(tokenPath))fs.writeFileSync(tokenPath,crypt('seal',randomBytes(32).toString('hex')),{flag:'wx'});
const token=crypt('unseal',fs.readFileSync(tokenPath,'utf8'));
const tunnel=new Tunnel(config,{secretsRoot,crypt,token});
const events=new Events(store,{seal:s=>crypt('seal',JSON.stringify(s)),unseal:s=>JSON.parse(crypt('unseal',s)),send:(...args)=>sendWebhook(...args,{proxy:config.tunnel?.proxy||''})});
const mcp=makeMcp(service,events),csrf=randomBytes(24).toString('hex');
const equal=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
async function body(req,max=1048576) {const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>max)throw new Error('请求内容超过大小限制。');chunks.push(c);}return Buffer.concat(chunks);}
function localHost(req,port) {return [`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host);}
function publicRequest(r) {return {...r,questions:service.questions.list(r.id),payload:{...r.payload,files:r.payload.files.map(({path:file,...f})=>({...f,mime:fileType(file)}))}};}
app.on('request',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  try{
    if(!localHost(req,config.port))return json(res,403,{error:'仅允许本机访问。'});
    if(req.headers.origin && ![`http://127.0.0.1:${config.port}`,`http://localhost:${config.port}`].includes(req.headers.origin))return json(res,403,{error:'来源不受信任。'});
    if(req.method==='POST'&&!equal(req.headers['x-dialog-csrf'],csrf))return json(res,403,{error:'请刷新页面后重试。'});
    const url=new URL(req.url,`http://127.0.0.1:${config.port}`);
    if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,{csrf,project:config.projectName,connection:service.connection,dot:events.status(),tunnel:tunnel.status(),models:models(),notification:notificationSettings(store,config),defaultEmail:notificationSettings(store,config).email,emails:store.setting('emails')||(config.defaultEmail?[config.defaultEmail]:[]),conversations:store.conversations(),pending:store.active().length});
    if(req.method==='POST'&&url.pathname==='/api/notification-settings')return json(res,200,saveNotificationSettings(store,config,JSON.parse(await body(req))));
    if(req.method==='POST'&&url.pathname==='/api/questions/create'){const p=JSON.parse(await body(req));return json(res,200,service.questions.create(p.requestId,p.questions));}
    if(req.method==='GET'&&url.pathname==='/api/questions/get'){const q=service.questions.get(url.searchParams.get('id'));return json(res,q?200:404,q||{error:'问题不存在。'});}
    if(req.method==='POST'&&url.pathname==='/api/questions/answer'){const p=JSON.parse(await body(req));return json(res,200,service.questions.answer(p.requestId,p.id,p.answers));}
    if(req.method==='POST'&&url.pathname==='/api/tunnel/connect'){const p=JSON.parse(await body(req,8192));return json(res,200,tunnel.save(p.key));}
    if(req.method==='GET'&&url.pathname==='/api/diagnostics')return json(res,200,{methods:store.setting('mcp_diagnostics')||{},subscription:events.status().diagnostic});
    if(req.method==='POST'&&url.pathname==='/api/shutdown'){json(res,200,{ok:true});close();return;}
    if(req.method==='GET'&&url.pathname==='/api/history')return json(res,200,store.history(url.searchParams.get('id')).map(publicRequest));
    if(req.method==='POST'&&url.pathname==='/api/refresh'){await service.refresh();return json(res,200,{ok:true});}
    if(req.method==='POST'&&url.pathname==='/api/conversations'){
      const p=JSON.parse(await body(req));if(typeof p.title!=='string'||!p.title.trim()||p.title.length>100)throw new Error('请输入 1 至 100 字的对话名称。');
      if(p.scope==='workbench-project'&&!config.projectId)throw new Error('请先配置 Codex 项目，或使用无项目会话。');
      return json(res,201,store.newConversation(p.title.trim(),p.scope||'projectless'));
    }
    if(req.method==='POST'&&url.pathname==='/api/upload'){
      const name=decodeURIComponent(req.headers['x-file-name']||'附件');const f=store.upload(name,await body(req,50*1024*1024));
      return json(res,201,(({path:file,...rest})=>({...rest,mime:fileType(file)}))(f));
    }
    if(req.method==='GET'&&url.pathname.startsWith('/api/files/')){
      const f=store.file(url.pathname.split('/').at(-1));if(!f)return json(res,404,{error:'附件不存在。'});
      const mime=fileType(f.path),inline=mime&&!url.searchParams.has('download');
      res.writeHead(200,{'Content-Type':inline?mime:'application/octet-stream','Content-Disposition':(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(f.name),'Content-Length':f.size});fs.createReadStream(f.path).pipe(res);return;
    }
    if(req.method==='POST'&&url.pathname==='/api/requests'){
      const r=service.submit(JSON.parse(await body(req)));json(res,201,publicRequest(r));void events.tick().catch(()=>{});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/cancel'){
      const p=JSON.parse(await body(req)),r=store.request(p.id);if(!r||r.status!=='pending')throw new Error('仅能取消尚未被 Dot 接收的请求。');
      store.update(r.id,{status:'cancelled'});return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/reconcile'){
      const p=JSON.parse(await body(req)),r=store.request(p.id);if(!r||!['sent','uncertain'].includes(r.status))throw new Error('此请求无须核对。');
      await service.reconcile(p.id);return json(res,200,publicRequest(store.request(p.id)));
    }
    if(req.method==='GET'&&url.pathname==='/api/export'){
      const c=store.conversation(url.searchParams.get('id'));if(!c)throw new Error('对话不存在。');
      res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(c.title+'.json'));
      return json(res,200,{conversation:c,requests:store.history(c.id).map(publicRequest)});
    }
    if(req.method==='GET'){
      if(/^\/fonts\/[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/.test(url.pathname)){
        const font=path.join(root,'public',url.pathname);if(fs.existsSync(font)){res.writeHead(200,{'Content-Type':url.pathname.endsWith('woff2')?'font/woff2':url.pathname.endsWith('woff')?'font/woff':'font/ttf'});res.end(fs.readFileSync(font));return;}
      }
      const file={'/':'index.html','/app.js':'app.js','/questions.js':'questions.js','/rich.js':'rich.js','/rich.css':'rich.css','/style.css':'style.css'}[url.pathname];
      if(file){res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'public',file)));return;}
    }
    json(res,404,{error:'页面或接口不存在。'});
  }catch(e){if(!res.headersSent)json(res,400,{error:e.message});else res.destroy();}
});
mcpServer.on('request',async(req,res)=>{
  try{
    if(!localHost(req,config.mcpPort)||req.headers.origin)return json(res,403,{error:'访问来源无效。'});
    if(!equal(req.headers.authorization,'Bearer '+token))return json(res,401,{error:'需要专用连接凭据。'});
    if(req.method!=='POST'||req.url!=='/mcp')return json(res,404,{});
    const headers=new Headers();for(const name of ['content-type','accept','mcp-protocol-version','mcp-method','mcp-name'])if(req.headers[name])headers.set(name,req.headers[name]);
    const bytes=await body(req);let method='other';
    try{const supplied=JSON.parse(bytes).method;if(['initialize','server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe'].includes(supplied))method=supplied;}catch{}
    const diagnostic=store.setting('mcp_diagnostics')||{};
    diagnostic[method]={count:(diagnostic[method]?.count||0)+1,lastAt:new Date().toISOString()};store.setting('mcp_diagnostics',diagnostic);
    const response=await mcp.fetch(new Request(`http://127.0.0.1:${config.mcpPort}/mcp`,{method:'POST',headers,body:bytes}));
    res.statusCode=response.status;for(const [k,v]of response.headers)if(!['connection','transfer-encoding','set-cookie'].includes(k))res.setHeader(k,v);
    if(response.body)for await(const c of response.body)res.write(c);res.end();
  }catch{if(!res.headersSent)json(res,500,{error:'MCP 请求失败。'});else res.destroy();}
});
console.log(`Dot 网页工作台：http://127.0.0.1:${config.port}`);
tunnel.start();
void service.refresh().catch(()=>{});
const tick=setInterval(()=>{void service.tick().catch(()=>{});void events.tick().catch(()=>{});},5000);
const refresh=setInterval(()=>void service.refresh().catch(()=>{}),120000);
function close(){tunnel.stop();clearInterval(tick);clearInterval(refresh);app.close();mcpServer.close();setTimeout(()=>process.exit(),1500).unref();}
process.on('SIGINT',close);process.on('SIGTERM',close);
