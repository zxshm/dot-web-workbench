import fs from 'node:fs';
import path from 'node:path';
import {marked} from 'marked';

export function imageType(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
export function fileType(file) {
  const fd=fs.openSync(file,'r');try{const bytes=Buffer.alloc(16);const size=fs.readSync(fd,bytes);return imageType(bytes.subarray(0,size));}finally{fs.closeSync(fd);}
}
export function collectReplyFiles(store,request,reply,cwd) {
  const assets={...request.assets};
  let root;try{root=cwd?fs.realpathSync(cwd):null;}catch{}
  const within=(file,base)=>{const rel=path.relative(base,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
  // 只保存本轮回复明确链接、位于该聊天目录或已上传附件中的文件。
  marked.walkTokens(marked.lexer(reply),token=>{
    if(!['image','link'].includes(token.type)||assets[token.href]||Object.keys(assets).length>=40)return;
    try{
      let source=decodeURIComponent(token.href);
      if(/^(https?:|data:|blob:|file:|\/\/|\\\\)/i.test(source))return;
      if(/^\/[a-z]:[\\/]/i.test(source))source=source.slice(1);
      if(!path.isAbsolute(source)&&!root)return;
      if(token.type==='link')source=source.replace(/:\d+(?::\d+)?$/,'');
      const candidate=fs.realpathSync(path.resolve(root||'.',source));
      const uploaded=request.payload.files.find(f=>fs.realpathSync(f.path)===candidate);
      if(!uploaded&&(!root||!within(candidate,root)))return;
      const stat=fs.statSync(candidate);if(!stat.isFile()||!stat.size||stat.size>50*1024*1024)return;
      const mime=fileType(candidate);if(token.type==='image'&&!mime)return;
      const f=uploaded||store.upload(path.basename(candidate),fs.readFileSync(candidate));
      assets[token.href]={id:f.id,name:f.name,size:f.size,mime};
    }catch{}
  });
  return assets;
}
