import {Marked} from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';

function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function preview(src,name){
  const dialog=node('dialog',undefined,'image-dialog'),bar=node('div',undefined,'image-actions');
  const link=node('a','打开原图');link.href=src;link.target='_blank';link.rel='noopener noreferrer';
  const close=node('button','关闭');close.onclick=()=>dialog.close();bar.append(node('span',name),link,close);
  const img=node('img');img.src=src;img.alt=name;dialog.append(bar,img);document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});dialog.showModal();
}
export function imagePreview(src,name,small=false){
  const button=node('button',undefined,small?'image-thumbnail':'image-preview');button.type='button';button.setAttribute('aria-label','查看图片：'+name);
  const img=node('img');img.alt=name;img.loading='lazy';img.src=src;img.referrerPolicy='no-referrer';
  img.onerror=()=>{button.replaceChildren(node('span','图片无法加载：'+name));};
  button.append(img);button.onclick=()=>preview(src,name);return button;
}
export function renderMarkdown(source,assets={}){
  const box=node('div',undefined,'markdown'),images=[],formulas=[];
  const md=new Marked({gfm:true,breaks:false,renderer:{
    html(){return '';},
    image(token){images.push(token);return `<span data-image="${images.length-1}"></span>`;}
  }});
  const math=(name,level,regex)=>({name,level,start:src=>{const pos=src.search(level==='block'?/\$\$|\\\[/:/\$|\\\(/);return pos<0?undefined:pos;},tokenizer(src){const m=regex.exec(src);if(m)return {type:name,raw:m[0],text:m[1]??m[2],display:level==='block'};},renderer(token){formulas.push(token);return `<span data-formula="${formulas.length-1}"></span>`;}});
  md.use({walkTokens(token){if(token.type==='link'&&assets[token.href])token.href='/api/files/'+assets[token.href].id+'?download=1';},extensions:[math('blockMath','block',/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/),math('inlineMath','inline',/^(?:\$(?!\s|\$)([^\n$]+?)\$(?!\d)|\\\(([^\n]+?)\\\))/)]});
  box.innerHTML=DOMPurify.sanitize(md.parse(source),{FORBID_TAGS:['style','script','iframe','object','form','img'],FORBID_ATTR:['style','id','name'],ALLOW_DATA_ATTR:true});
  for(const link of box.querySelectorAll('a')){
    const href=link.getAttribute('href')||'',asset=assets[href];
    if(asset)link.href='/api/files/'+asset.id+'?download=1';
    else if(Object.values(assets).some(f=>href==='/api/files/'+f.id+'?download=1')){link.download='';continue;}
    else if(!/^(https?:\/\/|mailto:)/i.test(href)){link.removeAttribute('href');link.title='本机文件请通过附件下载';continue;}
    link.target='_blank';link.rel='noopener noreferrer';
  }
  for(const spot of box.querySelectorAll('[data-image]')){
    const token=images[Number(spot.dataset.image)];if(!token){spot.remove();continue;}
    const asset=assets[token.href],label=token.text||'图片';
    if(asset)spot.replaceWith(imagePreview('/api/files/'+asset.id,label));
    else if(/^https:\/\//i.test(token.href)){
      const load=node('button','加载外部图片：'+label,'external-image');load.type='button';load.title=token.href;
      load.onclick=()=>load.replaceWith(imagePreview(token.href,label));spot.replaceWith(load);
    }else spot.replaceWith(node('span','图片未保存或路径不可用：'+label,'image-missing'));
  }
  for(const spot of box.querySelectorAll('[data-formula]')){
    const formula=formulas[Number(spot.dataset.formula)];if(!formula){spot.remove();continue;}
    katex.render(formula.text,spot,{displayMode:formula.display,throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:20});
  }
  for(const code of box.querySelectorAll('pre > code')){
    const language=[...code.classList].find(x=>x.startsWith('language-'))?.slice(9);
    if(language&&hljs.getLanguage(language))code.innerHTML=hljs.highlight(code.textContent,{language}).value;
    const pre=code.parentElement,wrapper=node('div',undefined,'code-block'),bar=node('div',undefined,'code-header'),copy=node('button','复制代码');
    copy.type='button';copy.onclick=()=>navigator.clipboard.writeText(code.textContent).then(()=>{copy.textContent='已复制';setTimeout(()=>copy.textContent='复制代码',1800);}).catch(()=>{copy.textContent='请手动复制';});
    bar.append(node('span',language||'代码'),copy);pre.replaceWith(wrapper);wrapper.append(bar,pre);
  }
  for(const table of box.querySelectorAll('table')){const wrap=node('div',undefined,'table-scroll');table.replaceWith(wrap);wrap.append(table);}
  for(const input of box.querySelectorAll('input'))input.disabled=true;
  return box;
}
