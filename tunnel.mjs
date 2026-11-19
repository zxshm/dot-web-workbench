import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

// 凭据只在当前 Windows 用户的 DPAPI 文件和子进程环境中使用。
export class Tunnel {
  constructor(config,{secretsRoot,crypt,token}) {
    this.config=config;this.crypt=crypt;this.token=token;
    this.keyPath=path.join(secretsRoot,'tunnel-runtime.dpapi');
    this.child=null;this.error='';this.timer=null;this.stopped=false;
  }
  status(){return {configured:fs.existsSync(this.keyPath),running:!!this.child,error:this.error,tunnelId:this.config.tunnel?.id||''};}
  save(key){
    const t=this.config.tunnel;
    if(!t?.id||!t.organizationId||!t.clientPath)throw new Error('请先在 config.json 填写隧道 ID、组织 ID 和客户端路径。');
    if(typeof key!=='string'||!/^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim()))throw new Error('运行密钥格式不正确。');
    if(this.child)throw new Error('隧道已运行，请先停止程序再更换凭据。');
    fs.writeFileSync(this.keyPath,this.crypt('seal',key.trim()),{mode:0o600});
    this.start();return this.status();
  }
  start(){
    if(this.child||this.stopped||!fs.existsSync(this.keyPath))return;
    const t=this.config.tunnel;if(!t||!fs.existsSync(t.clientPath)){this.error='找不到官方隧道客户端。';return;}
    try{
      const args=['run','--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.tunnel-id',t.id,'--control-plane.organization-id',t.organizationId,'--mcp.server-url',`http://127.0.0.1:${this.config.mcpPort}/mcp`,'--mcp.extra-headers','Authorization: env:DIALOG_MCP_AUTH','--mcp.discovery-extra-headers','Authorization: env:DIALOG_MCP_AUTH','--health.listen-addr','127.0.0.1:4192','--admin-ui.log-buffer-events','1','--log.format','json','--log.level','warn'];
      if(t.proxy)args.push('--control-plane.http-proxy',t.proxy);
      const child=spawn(t.clientPath,args,{windowsHide:true,stdio:'ignore',env:{...process.env,CONTROL_PLANE_API_KEY:this.crypt('unseal',fs.readFileSync(this.keyPath,'utf8')),DIALOG_MCP_AUTH:'Bearer '+this.token}});
      this.child=child;this.error='';
      child.once('error',()=>{this.error='隧道客户端启动失败。';});
      child.once('close',code=>{if(this.child===child)this.child=null;if(!this.stopped){this.error=`隧道已退出（${code}），30 秒后重连。`;this.timer=setTimeout(()=>this.start(),30000);}});
    }catch{this.error='无法读取本机加密凭据。';}
  }
  stop(){this.stopped=true;clearTimeout(this.timer);this.child?.kill();}
}
