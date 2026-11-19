import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../store.mjs';
import {collectReplyFiles,imageType} from '../assets.mjs';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
const {renderMarkdown}=await import('../public/rich.js');
test('富文本显示标题、表格、任务列表、代码和公式',()=>{
  const box=renderMarkdown('# 标题\n\n**粗体** 与 `代码`\n\n| 名称 | 值 |\n|---|---|\n| 测试 | 12 |\n\n- [x] 完成\n\n```js\nconst value = 12;\n```\n\n$$\\frac{1}{2}$$\n\n行内 $x^2$。');
  assert.equal(box.querySelector('h1').textContent,'标题');assert.equal(box.querySelectorAll('table').length,1);assert.equal(box.querySelector('input').disabled,true);assert.match(box.querySelector('pre').textContent,/const value = 12/);assert.ok(box.querySelector('.hljs-keyword'));assert.equal(box.querySelectorAll('.katex').length,2);
});
test('不执行正文 HTML、危险链接或远程图片；代码中的公式保持原文',()=>{
  const box=renderMarkdown('<img src=x onerror=alert(1)>\n\n[危险](javascript:alert%281%29)\n\n![远程](https://example.com/test.png)\n\n`$x$`\n\n<script>alert(1)</script>');
  assert.equal(box.querySelectorAll('script,img,[onerror],a[href]').length,0);assert.equal(box.querySelectorAll('.external-image').length,1);assert.equal(box.querySelector('code').textContent,'$x$');assert.equal(box.querySelectorAll('.katex').length,0);
});
test('已保存图片通过附件接口预览，缺失图片显示提示',()=>{
  const box=renderMarkdown('![结果](result.png)\n\n![缺失](missing.png)',{'result.png':{id:'saved',name:'结果.png'}});
  assert.equal(box.querySelector('img').getAttribute('src'),'/api/files/saved');assert.match(box.querySelector('.image-missing').textContent,/缺失/);
});
test('本地图片只保存在聊天根目录内，重复核对不重复存储',t=>{
  const parent=path.resolve('runtime/tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'images-'));const store=new Store(path.join(root,'data'));
  t.after(()=>{store.close();if(path.dirname(root)!==parent)throw new Error('测试目录边界错误');fs.rmSync(root,{recursive:true,force:true});});
  const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=','base64');fs.writeFileSync(path.join(cwd,'result.png'),png);fs.writeFileSync(path.join(root,'outside.png'),png);
  const r={payload:{files:[]},assets:{}};const result=collectReplyFiles(store,r,'![内](result.png)\n![外](../outside.png)',cwd);assert.deepEqual(Object.keys(result),['result.png']);assert.equal(imageType(Buffer.from('<svg/>')),null);assert.equal(imageType(png),'image/png');
  assert.deepEqual(collectReplyFiles(store,{...r,assets:result},'![内](result.png)',cwd),result);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n,1);
});

test('回复文件链接独立保存，越界文件与目录不能下载',t=>{
  const parent=path.resolve('runtime/tests');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'files-'));const store=new Store(path.join(root,'data'));
  t.after(()=>{store.close();if(path.dirname(root)!==parent)throw new Error('测试目录边界错误');fs.rmSync(root,{recursive:true,force:true});});
  const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'交付.txt'),'双向文件传递');fs.writeFileSync(path.join(root,'外部.txt'),'不能读取');
  const assets=collectReplyFiles(store,{payload:{files:[]},assets:{}},'[下载](%E4%BA%A4%E4%BB%98.txt)\n[越界](../外部.txt)\n[目录](.)',cwd);
  assert.equal(Object.keys(assets).length,1);const f=Object.values(assets)[0];assert.equal(f.name,'交付.txt');assert.equal(fs.readFileSync(store.file(f.id).path,'utf8'),'双向文件传递');
  fs.writeFileSync(path.join(cwd,'交付.txt'),'原始文件后来改变');assert.equal(fs.readFileSync(store.file(f.id).path,'utf8'),'双向文件传递');
});

test('Windows 绝对路径下载链接在清理 HTML 前转换为本机附件链接',()=>{
  const source='C:/demo/workspace/交付.txt';const box=renderMarkdown('[下载结果]('+source+')',{[source]:{id:'file-id',name:'交付.txt'}});assert.equal(box.querySelector('a').getAttribute('href'),'/api/files/file-id?download=1');
});
