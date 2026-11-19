import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublic(address) {
  try {let ip=ipaddr.parse(address);if(ip.kind()==='ipv6'&&ip.isIPv4MappedAddress())ip=ip.toIPv4Address();return ip.range()==='unicast';}catch{return false;}
}
export function localProxy(value) {
  const p=new URL(value);
  if(p.protocol!=='http:'||p.hostname!=='127.0.0.1'||p.username||p.password||p.pathname!=='/'||p.search||p.hash)throw new Error('仅支持配置中的本机 HTTP 代理。');
  return p;
}

// CONNECT 目标使用已经验证的公网 IP；TLS 与 Host 始终使用原域名。
// 只有固定的 DoH 解析器允许交给本机代理解析，回调域名不能走此例外。
function proxyAgent(proxy,address,hostname,signal) {
  const p=localProxy(proxy),agent=new https.Agent({keepAlive:false});
  agent.createConnection=(_options,callback)=>{
    const target=(net.isIP(address)===6?'['+address+']':address)+':443';
    let socket,finished=false;
    const done=(error,stream)=>{if(finished)return;finished=true;callback(error,stream);};
    const request=http.request({host:p.hostname,port:p.port||80,method:'CONNECT',path:target,headers:{Host:target},signal});
    request.on('connect',(response,stream,head)=>{
      socket=stream;
      if(response.statusCode!==200){stream.destroy();done(Object.assign(new Error('代理连接失败'),{code:'ECONNREFUSED'}));return;}
      if(head.length)stream.unshift(head);
      socket=tls.connect({socket:stream,servername:hostname,rejectUnauthorized:true});
      const abort=()=>socket.destroy(Object.assign(new Error('回调连接超时'),{code:'ABORT_ERR'}));
      signal.addEventListener('abort',abort,{once:true});socket.once('close',()=>signal.removeEventListener('abort',abort));
      socket.once('secureConnect',()=>done(null,socket));socket.once('error',error=>done(error));
      if(signal.aborted)abort();
    });
    request.once('error',error=>{socket?.destroy();done(error);});request.end();
  };
  return agent;
}

export async function requestHttps(url,{proxy='',address,method='GET',headers={},body,signal=AbortSignal.timeout(12000)}={}) {
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw new Error('回调地址必须为公开 HTTPS 域名。');
  if(!isPublic(address)&&!(address==='cloudflare-dns.com'&&u.hostname==='cloudflare-dns.com'&&method==='GET'&&u.pathname==='/dns-query'))throw new Error('回调解析到非公开地址。');
  const agent=proxy?proxyAgent(proxy,address,u.hostname,signal):false;
  try{return await new Promise((resolve,reject)=>{
    const req=https.request(u,{method,headers,agent,signal,lookup:(_host,options,callback)=>options.all?callback(null,[{address,family:net.isIP(address)}]):callback(null,address,net.isIP(address))},res=>{
      if(res.statusCode>=300&&res.statusCode<400){res.resume();reject(new Error('不接受回调重定向。'));return;}
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>16384)res.destroy(new Error('回调响应过大'));else chunks.push(chunk);});
      res.on('error',reject);res.on('aborted',()=>reject(new Error('回调响应中断。')));
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });req.on('error',reject);req.end(body);
  });}finally{if(agent)agent.destroy();}
}

export function publicAnswers(result) {
  if(result.Status!==0)throw Object.assign(new Error('回调 DNS 失败'),{code:'ENOTFOUND'});
  const addresses=(result.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>({address:a.data,family:net.isIP(a.data)}));
  if(!addresses.length)throw Object.assign(new Error('回调 DNS 无地址'),{code:'ENOTFOUND'});
  if(addresses.some(a=>!isPublic(a.address)))throw new Error('回调解析到非公开地址。');
  return addresses;
}
export async function resolvePublic(hostname,{proxy='',signal=AbortSignal.timeout(5000)}={}) {
  if(proxy){
    const result=await requestHttps('https://cloudflare-dns.com/dns-query?'+new URLSearchParams({name:hostname,type:'A'}),{proxy,address:'cloudflare-dns.com',headers:{accept:'application/dns-json'},signal});
    if(result.status!==200)throw Object.assign(new Error('回调 DNS 失败'),{code:'ENOTFOUND'});
    return publicAnswers(JSON.parse(result.body));
  }
  let abort;
  const addresses=await Promise.race([dns.lookup(hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{
    abort=()=>reject(Object.assign(new Error('回调 DNS 超时'),{code:'ABORT_ERR'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  })]).finally(()=>signal.removeEventListener('abort',abort));
  if(!addresses.length||addresses.some(a=>!isPublic(a.address)))throw new Error('回调解析到非公开地址。');
  return addresses;
}
