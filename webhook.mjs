import net from 'node:net';
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
import {resolvePublic,requestHttps} from './outbound.mjs';
export {isPublic} from './outbound.mjs';

export function callbackUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443')||net.isIP(u.hostname)||!u.hostname.includes('.')) throw new Error('回调地址必须为公开 HTTPS 域名。');
  return u;
}
export function secretValid(secret) {
  if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))return false;
  const b=Buffer.from(secret.slice(6),'base64');return b.length>=24&&b.length<=64&&b.toString('base64')===secret.slice(6);
}
export async function sendWebhook(sub,body,id,{proxy=''}={}) {
  const u=callbackUrl(sub.url); if(!secretValid(sub.secret))throw new Error('签名密钥格式无效。');
  const signal=AbortSignal.timeout(12000);
  let addresses;
  try{addresses=await resolvePublic(u.hostname,{proxy,signal:AbortSignal.any([signal,AbortSignal.timeout(4000)])});}catch(error){error.stage='dns';throw error;}
  const now=new Date();
  const headers={'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(+now/1000)),'webhook-signature':new Webhook(sub.secret).sign(id,now,body),'X-MCP-Subscription-Id':sub.id};
  try{return await requestHttps(u,{proxy,address:addresses[0].address,method:'POST',headers,body,signal});}catch(error){error.stage='https';throw error;}
}
export const EVENT='workbench.request_created';
const DEFAULT_TTL_MS=30*24*60*60*1000;
const VERIFY_CACHE_MS=15*60*1000;

function activeSubscription(sub, now=Date.now()) {
  return !!sub && (sub.expires===null || Date.parse(sub.expires)>now);
}
// 仅保存固定分类，不能将回调地址、签名密钥或完整异常写入诊断。
export function subscriptionFailure(error) {
  const message=String(error?.message||'');
  if(/参数|时长/.test(message))return 'invalid_parameters';
  if(/已绑定/.test(message))return 'already_bound';
  if(/非公开/.test(message))return 'non_public_dns';
  if(/公开 HTTPS/.test(message)||error?.code==='ERR_INVALID_URL')return 'invalid_callback_url';
  if(/重定向/.test(message))return 'redirect_rejected';
  if(/回调验证失败/.test(message))return 'challenge_failed';
  if(/超时/.test(message)||['ABORT_ERR','ETIMEDOUT'].includes(error?.code))return 'timeout';
  if(['ENOTFOUND','EAI_AGAIN'].includes(error?.code))return 'dns_failed';
  if(['ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'].includes(error?.code))return 'network_failed';
  if(/CERT|TLS|SSL/.test(error?.code||''))return 'tls_failed';
  return 'internal_error';
}
export class Events {
  constructor(store,{seal,unseal,send=sendWebhook}) {
    this.store=store;
    this.seal=seal;
    this.unseal=unseal;
    this.send=send;
    this.subscriptionRevision=0;
  }
  subscription() {const s=this.store.setting('subscription');return s?this.unseal(s):null;}
  status() {
    const sub=this.subscription();
    return {
      connected:activeSubscription(sub),
      expires:sub?.expires??null,
      lifetime:!sub?'unbound':sub.expires===null?'persistent':'finite',
      event:EVENT,
      diagnostic:this.store.setting('subscription_diagnostic')||null
    };
  }
  async subscribe(p) {
    const diagnostic={at:new Date().toISOString(),stage:'received'};
    const record=()=>this.store.setting('subscription_diagnostic',diagnostic);
    record();
    try {
      if(p.name!==EVENT||JSON.stringify(p.arguments)!=='{"project":"workbench-project"}'||p.delivery?.mode!=='webhook'||!secretValid(p.delivery.secret))throw new Error('订阅参数无效。');
      const receiver=callbackUrl(p.delivery.url);
      const revision=this.subscriptionRevision;
      const old=this.subscription();
      const sameReceiver=old?.url===p.delivery.url;
      // 此接口使用工作台独立凭据。平台可在同一来源下轮换回调路径，新地址仍须通过签名挑战。
      const rotatesReceiver=!!old&&!sameReceiver&&callbackUrl(old.url).origin===receiver.origin;
      if(activeSubscription(old)&&!sameReceiver&&!rotatesReceiver)throw new Error('已绑定一个 Dot 接收端，请先取消原订阅。');

      const requestedTtl=p.ttlMs===undefined?DEFAULT_TTL_MS:p.ttlMs;
      if(requestedTtl!==null&&(!Number.isSafeInteger(requestedTtl)||requestedTtl<=0))throw new Error('订阅时长无效。');
      const ttl=requestedTtl===null?null:Math.min(requestedTtl,DEFAULT_TTL_MS);
      const sub={id:'sub_'+createHash('sha256').update(EVENT+p.delivery.url).digest('hex').slice(0,32),url:p.delivery.url,secret:p.delivery.secret};
      diagnostic.operation=sameReceiver?'renew':rotatesReceiver?'rotate_callback':'create';
      diagnostic.requestedTtlMs=p.ttlMs??null;
      diagnostic.ttlOmitted=p.ttlMs===undefined;

      const verifiedAt=Date.parse(old?.verifiedAt);
      if(sameReceiver&&activeSubscription(old)&&old.secret===sub.secret&&verifiedAt<=Date.now()&&Date.now()-verifiedAt<VERIFY_CACHE_MS) {
        sub.verifiedAt=old.verifiedAt;
        diagnostic.verification='cached';
      } else {
        const challenge=randomUUID(),body=JSON.stringify({type:'verification',challenge});
        diagnostic.stage='callback_verification';record();
        const response=await this.send(sub,body,'verify_'+randomUUID());
        diagnostic.httpStatus=response.status;record();
        let echo;
        try { echo=JSON.parse(response.body).challenge; } catch {}
        const expected=Buffer.from(challenge),actual=Buffer.from(typeof echo==='string'?echo:'');
        if(response.status<200||response.status>=300||expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Dot 回调验证失败。');
        sub.verifiedAt=new Date().toISOString();
      }
      if(this.subscriptionRevision!==revision)throw new Error('订阅状态已变更，请重试。');

      sub.expires=ttl===null?null:new Date(Date.now()+ttl).toISOString();
      this.store.setting('subscription',this.seal(sub));
      this.subscriptionRevision++;
      diagnostic.stage='subscribed';
      diagnostic.grantedUntil=sub.expires;
      record();
      return {id:sub.id,refreshBefore:sub.expires,cursor:null,truncated:false};
    } catch(error) {
      diagnostic.reason=subscriptionFailure(error);if(['dns','https'].includes(error.stage))diagnostic.networkStage=error.stage;record();
      const failure=new Error('事件订阅未建立');failure.reason=diagnostic.reason;throw failure;
    }
  }
  unsubscribe(p) {
    if(p.name!==EVENT||p.arguments?.project!=='workbench-project')throw new Error('订阅参数无效。');
    const sub=this.subscription();
    if(sub&&sub.url===p.delivery?.url){
      this.store.setting('subscription',null);
      this.subscriptionRevision++;
    }
    return {};
  }
  async tick() {
    if(this.ticking)return;this.ticking=true;
    try {
      const sub=this.subscription();if(!activeSubscription(sub))return;
      const revision=this.subscriptionRevision;
      for(const r of this.store.active().filter(r=>r.status==='pending'&&['pending','unknown','retry'].includes(r.event_status)&&r.event_attempts<5&&r.event_next<=Date.now())) {
        if(this.subscriptionRevision!==revision||!activeSubscription(sub))break;
        const attempts=r.event_attempts+1;
        this.store.update(r.id,{event_status:'sending',event_attempts:attempts,event_next:Date.now()+Math.min(600000,30000*2**(attempts-1))});
        const event={eventId:r.id,name:EVENT,timestamp:r.created,data:{project:'workbench-project',request_id:r.id},cursor:null};
        try{const result=await this.send(sub,JSON.stringify(event),r.id);this.store.update(r.id,{event_status:result.status>=200&&result.status<300?'accepted':(result.status>=500||result.status===429)?'retry':'rejected'});}
        catch{this.store.update(r.id,{event_status:'unknown'});}
      }
    }finally{this.ticking=false;}
  }
}
