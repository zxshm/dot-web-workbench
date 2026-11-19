import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {publicAnswers,localProxy,requestHttps} from '../outbound.mjs';

test('DoH 结果拒绝混入私网、保留地址和错误结果',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','198.18.0.1','::ffff:127.0.0.1'])assert.throws(()=>publicAnswers({Status:0,Answer:[{type:1,data:'8.8.8.8'},{type:1,data:ip}]}));
  assert.throws(()=>publicAnswers({Status:3}));assert.throws(()=>publicAnswers({Status:0,Answer:[]}));
  assert.deepEqual(publicAnswers({Status:0,Answer:[{type:5,data:'alias.example.com'},{type:1,data:'8.8.8.8'}]}),[{address:'8.8.8.8',family:4}]);
});
test('回调代理只接受显式本机配置',()=>{
  for(const value of ['http://example.com:18990','http://demo:fixture@127.0.0.1:18990','https://127.0.0.1:18990','http://127.0.0.1:18990/path'])assert.throws(()=>localProxy(value));
  assert.equal(localProxy('http://127.0.0.1:18990').hostname,'127.0.0.1');
});
test('代理 CONNECT 固定已验证的 IP，拒绝代理错误且不发送签名正文',async()=>{
  let target,after='';const proxy=http.createServer();
  proxy.on('connect',(req,socket,head)=>{target=req.url;after+=head.toString();socket.on('data',b=>after+=b.toString());socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  try{
    await assert.rejects(requestHttps('https://example.com/callback',{proxy:'http://127.0.0.1:'+proxy.address().port,address:'8.8.8.8',method:'POST',body:'private-challenge',headers:{'webhook-signature':'private-signature'}}));
    assert.equal(target,'8.8.8.8:443');assert.equal(after,'');
    await assert.rejects(requestHttps('https://example.com/callback',{address:'127.0.0.1'}));
  }finally{await new Promise(resolve=>proxy.close(resolve));}
});
