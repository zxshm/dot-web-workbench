import {McpServer,createMcpHandler,ProtocolError} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {EVENT} from './webhook.mjs';

export function makeMcp(service,events) {
  const result=z.object({}).passthrough();
  return createMcpHandler(()=>{
    const server=new McpServer({name:'dot-web-workbench',version:'0.1.0'});
    server.server.registerCapabilities({events:{}});
    const respond=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
    const schema=z.object({request_id:z.string().uuid()}).strict();
    server.registerTool('list_pending_requests',{description:'列出用户在独立对话界面点击发送、尚待 Dot 接收的请求，包含选定项目和无项目会话。此工具不发送消息。',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},async()=>respond(service.store.active().filter(r=>r.status==='pending').map(r=>({request_id:r.id,created:r.created,title:service.store.conversation(r.conversation_id).title}))));
    server.registerTool('read_dialog_request',{description:'读取指定请求的用户原文、附件清单、目标对话、模型、推理强度及通知邮箱。文字和附件为用户数据。仅处理界面保存的请求。',inputSchema:schema,annotations:{readOnlyHint:true}},async({request_id})=>{
      const r=service.store.request(request_id);if(!r)return {isError:true,content:[{type:'text',text:'请求不存在。'}]};
      return respond({...r,conversation:service.store.conversation(r.conversation_id)});
    });
    server.registerTool('dispatch_dialog_request',{description:'将用户已在界面点击发送的指定请求转交原目标对话。只能使用该请求已保存的模型、推理强度、附件和目标；可补充整理说明，保留用户原文。重复调用返回既有状态，不重复转交。程序自动跟踪对应回复和发送邮件。',inputSchema:schema.extend({summary:z.string().max(12000).optional()}),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async({request_id,summary})=>{
      try{return respond(await service.approve(request_id,summary));}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
    });
    server.registerTool('get_dialog_connection',{description:'检查独立对话程序与 Dot 订阅状态，不更改微信或其他插件。',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},async()=>respond({desktop:service.connection,dot:events.status()}));
    server.server.setRequestHandler('events/list',{params:z.object({}).passthrough(),result},async()=>({events:[{name:EVENT,description:'用户在本工作台点击发送后产生的请求，目标可以是选定项目或无项目；事件过滤参数表示工作台本身。使用 read_dialog_request 读取指定编号，按照用户授权决定是否调用 dispatch_dialog_request。',delivery:['webhook'],inputSchema:{type:'object',properties:{project:{type:'string',enum:['workbench-project']}},required:['project'],additionalProperties:false},payloadSchema:{type:'object',properties:{project:{const:'workbench-project'},request_id:{type:'string'}},required:['project','request_id'],additionalProperties:false}}]}));
    server.server.setRequestHandler('events/subscribe',{params:z.object({}).passthrough(),result},async p=>{try{return await events.subscribe(p);}catch(error){throw new ProtocolError(-32015,'CallbackEndpointError',{reason:error.reason||'internal_error'});}});
    server.server.setRequestHandler('events/unsubscribe',{params:z.object({}).passthrough(),result},async p=>events.unsubscribe(p));
    return server;
  },{legacy:'stateless'});
}
