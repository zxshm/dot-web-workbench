import net from 'node:net';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

// 使用桌面程序自带工具的命名管道协议，不修改客户端聊天数据库。
export class NativeBridge {
  constructor(config) { this.config = config; }
  pipe() {
    if (process.env.CODEX_APP_TOOLS_PIPE_PATH) return process.env.CODEX_APP_TOOLS_PIPE_PATH;
    const names = fs.readdirSync('\\\\.\\pipe\\').filter(n => n.startsWith(this.config.pipePrefix));
    if (names.length !== 1) throw new Error('请打开 Codex；未找到唯一的桌面通信管道。');
    return '\\\\.\\pipe\\' + names[0];
  }
  rpc(method, params, timeout = 90000) {
    return new Promise((resolve, reject) => {
      let pending = Buffer.alloc(0), done = false;
      const socket = net.createConnection(this.pipe());
      const finish = (err, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); err ? reject(err) : resolve(result); };
      const timer = setTimeout(() => finish(new Error('桌面接口响应超时；操作结果未知，请勿重复发送。')), timeout);
      socket.on('error', e => finish(e));
      socket.on('close', () => { if (!done) finish(new Error('桌面连接中断；操作结果未知。')); });
      socket.on('connect', () => {
        const payload = Buffer.from(JSON.stringify({jsonrpc:'2.0', id:1, method, params}));
        const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
        socket.write(Buffer.concat([header, payload]));
      });
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 4) return;
        const size = pending.readUInt32LE(0);
        if (size > 64 * 1024 * 1024) return finish(new Error('桌面响应超过上限。'));
        if (pending.length < size + 4) return;
        try { const r = JSON.parse(pending.subarray(4, size + 4)); finish(r.error ? new Error(r.error.message) : null, r.result); }
        catch (e) { finish(e); }
      });
    });
  }
  async call(tool, args) {
    const allowed = ['list_projects','list_threads','read_thread','create_thread','send_message_to_thread'];
    if (!allowed.includes(tool)) throw new Error('不支持此客户端操作。');
    if(!this.config.callerThreadId)throw new Error('请在 config.json 填写调用来源的本机 Codex 对话 ID。');
    const catalog = await this.rpc('tools/list', {threadStartKind:'all'});
    const entry = catalog.tools.find(t => t.name === tool);
    if (!entry) throw new Error('客户端尚未提供此工具：' + tool);
    const r = await this.rpc('tools/call', {
      namespace:entry.namespace, tool, arguments:args, callerSource:'codex', hostId:'local',
      threadId:this.config.callerThreadId, callId:'dialog-' + randomUUID(), turnId:'dialog-' + randomUUID()
    });
    const txt = r.contentItems?.filter(c => c.type === 'inputText').map(c => c.text).join('\n') || '';
    if (!r.success) throw new Error(txt || '客户端操作失败。');
    try { return JSON.parse(txt); } catch { return {text:txt}; }
  }
}
