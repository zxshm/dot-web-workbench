import {renderQuestions} from '/questions.js';
import {renderMarkdown, imagePreview} from '/rich.js';
const $=s=>document.querySelector(s),state={data:null,current:null,history:[],files:[],busy:false,used:false,requestId:null,scope:localStorage.getItem('scope')||'projectless'};
const welcome=$('#messages').innerHTML;
const labels={pending:'等待 Dot 接收',approved:'Dot 已接收，等待客户端空闲',sending:'正在转交',sent:'处理中',completed:'已完成',failed:'处理失败',interrupted:'已中断',uncertain:'结果待核对',cancelled:'已取消'};
const efforts={low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
const mails={skipped:'',none:'',sending:'通知邮件发送中',accepted:'通知邮件：服务器已接收',unknown:'通知邮件：发送结果未确认'};
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),6500);}
async function api(url,data,options={}){
  const response=await fetch(url,{...options,...(data!==undefined?{method:'POST',headers:{'Content-Type':'application/json','X-Dialog-CSRF':state.data.csrf},body:JSON.stringify(data)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败。');return result;
}
function selectOptions(node,items,current){node.replaceChildren(...items.map(([value,label])=>{const o=el('option',label);o.value=value;return o;}));if(items.some(i=>i[0]===current))node.value=current;}
function refreshEfforts(){if(!state.data)return;const m=state.data.models.find(m=>m.id===$('#model').value);selectOptions($('#effort'),(m?.efforts||[]).map(x=>[x,efforts[x]||x]),$('#effort').value||m?.defaultEffort);}
function renderList(){
  if(!state.data)return;
  const query=$('#search').value.trim().toLowerCase();const rows=state.data.conversations.filter(c=>c.scope===state.scope&&(!c.archived||$('#show-archived').checked)&&c.title.toLowerCase().includes(query)&&(!state.used||c.has_records));
  $('#count').textContent=rows.length;const list=$('#conversation-list');
  const signature=JSON.stringify([state.current?.id,rows]);if(list.dataset.signature===signature)return;list.dataset.signature=signature;list.replaceChildren();
  for(const c of rows){const b=el('button',undefined,'conversation'+(state.current?.id===c.id?' active':''));b.append(el('span',c.title,'title'));b.setAttribute('aria-current',state.current?.id===c.id?'page':'false');if(c.archived)b.append(el('small','已归档'));else if(!c.remote_id)b.append(el('small','待创建'));b.title=c.title;b.onclick=()=>choose(c);list.append(b);}
  if(!rows.length)list.append(el('p','没有匹配的对话','muted'));
}
async function choose(c,save=true){if(state.busy)return;if(save)saveDraft();state.current=c;localStorage.setItem('current',c.id);state.files=[];state.requestId=null;loadDraft();$('#chat-title').textContent=c.title;$('#export').disabled=false;document.body.classList.remove('sidebar-open');renderList();await history();}
function saveDraft(){localStorage.setItem('draft:'+(state.current?.id||'new:'+state.scope),JSON.stringify({text:$('#message').value,model:$('#model').value,effort:$('#effort').value,files:state.files,requestId:state.requestId}));}
function loadDraft(){let d={};try{d=JSON.parse(localStorage.getItem('draft:'+(state.current?.id||'new:'+state.scope))||'{}');}catch{}$('#message').value=d.text||'';if(state.data.models.some(m=>m.id===d.model))$('#model').value=d.model;refreshEfforts();if([...$('#effort').options].some(o=>o.value===d.effort))$('#effort').value=d.effort;state.files=d.files||[];state.requestId=d.requestId||null;renderFiles();resizeInput();}
function renderFiles(){$('#attachments').replaceChildren(...state.files.map(f=>{const chip=el('span',f.name,'attachment'),remove=el('button','×');remove.type='button';remove.setAttribute('aria-label','移除 '+f.name);remove.onclick=()=>{state.requestId=null;state.files=state.files.filter(x=>x.id!==f.id);renderFiles();saveDraft();};if(f.mime)chip.prepend(imagePreview('/api/files/'+f.id,f.name,true));chip.append(remove);return chip;}));}
async function history(){if(!state.current)return;const selected=state.current.id;const result=await api('/api/history?id='+encodeURIComponent(selected));if(state.current?.id!==selected)return;const stable=rows=>JSON.stringify(rows.map(({updated,...row})=>row));const changed=stable(state.history)!==stable(result);state.history=result;if(changed||$('#messages').dataset.conversation!==selected)renderHistory();}
function renderHistory(){const box=$('#messages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;const switched=box.dataset.conversation!==state.current.id;box.dataset.conversation=state.current.id;box.replaceChildren();
  if(!state.history.length){const d=el('div',undefined,'empty');d.append(el('p','在下方输入消息，继续这个对话。'),el('small','这里只显示通过本程序发送的消息和回复。'));box.append(d);}
  for(const r of state.history){const user=el('article',undefined,'message user');user.append(el('pre',r.payload.text||'（附件消息）'));for(const f of r.payload.files){const a=el('a','▤ '+f.name,'file-link');a.href='/api/files/'+f.id+'?download=1';if(f.mime)user.append(imagePreview('/api/files/'+f.id,f.name));a.download=f.name;user.append(a);}const meta=el('div',`${new Date(r.created).toLocaleString('zh-CN')} · ${r.payload.model} · ${efforts[r.payload.effort]||r.payload.effort}`,'meta');user.append(meta);box.append(user);
    const answer=el('article',undefined,'message assistant');answer.append(el('div',(r.reply?'Dot · ':'')+((r.questions||[]).some(q=>q.status==='pending')?'等待你的回答':(labels[r.status]||r.status)),'role'));if(r.reply){answer.append(renderMarkdown(r.reply,r.assets));for(const f of Object.values(r.assets||{})){const a=el('a','下载 '+f.name,'file-link');a.href='/api/files/'+f.id+'?download=1';a.download=f.name;answer.append(a);}const copy=el('button','复制回复','copy-reply');copy.onclick=()=>navigator.clipboard.writeText(r.reply).then(()=>toast('已复制回复。')).catch(()=>toast('复制失败，请选择文字复制。'));answer.append(copy);}else answer.append(el('div',r.status==='pending'?'消息和附件已保存在本机，等待Dot接收。':r.status==='cancelled'?'本次请求已取消。':'处理状态会自动更新。','meta'));
    const status=el('div',undefined,'meta');status.title='请求编号：'+r.id;if(mails[r.mail_status])status.append(el('span',mails[r.mail_status],'badge'));if(r.error)status.append(el('div',r.error));if(r.status==='pending'){const b=el('button','取消排队');b.onclick=async()=>{try{await api('/api/cancel',{id:r.id});await history();}catch(e){toast(e.message);}};status.append(b);}if(['uncertain','sent'].includes(r.status)){const b=el('button','核对客户端结果');b.onclick=async()=>{b.disabled=true;try{await api('/api/reconcile',{id:r.id});await history();}catch(e){toast(e.message);}finally{b.disabled=false;}};status.append(b);}answer.append(renderQuestions(r,api,history,toast));answer.append(status);box.append(answer);
  }if(switched||nearBottom)box.scrollTop=box.scrollHeight;
}
async function refresh(){
  const d=await api('/api/state');state.data=d;
  const project=$('#scope option[value="workbench-project"]');project.hidden=!d.project;
  project.textContent=d.project||'选定项目';
  if(!d.project&&state.scope!=='projectless'){state.scope='projectless';$('#scope').value=state.scope;}
  $('#desktop-status').textContent=d.connection.ok?'客户端已连接':'客户端连接异常';$('#desktop-dot').classList.toggle('online',d.connection.ok);
  const dotStatus=$('#dot-status');
  dotStatus.textContent=d.dot.connected?'Dot 已连接':d.dot.expires?'Dot 订阅已到期':'Dot 待连接';
  dotStatus.title=d.dot.lifetime==='persistent'?'事件订阅长期有效':d.dot.expires?'订阅有效期至 '+new Date(d.dot.expires).toLocaleString('zh-CN'):'';
  dotStatus.classList.toggle('online',d.dot.connected);
  $('#notice').textContent=!d.connection.ok?(d.connection.error||'正在连接客户端…'):!d.dot.connected?`${dotStatus.textContent}，发送后将暂存在本机。`:'';$('#notice').classList.toggle('visible',!d.connection.ok||!d.dot.connected);
  if(!$('#model').options.length){selectOptions($('#model'),d.models.map(m=>[m.id,m.name]));refreshEfforts();}
  if(!state.notificationDirty&&!state.notificationSaving&&d.notification.version>=(state.notificationVersion??0)){$('#email').value=d.notification.email;$('#notify').checked=d.notification.enabled;state.notificationVersion=d.notification.version;}
  $('#email-options').replaceChildren(...d.emails.map(email=>{const o=el('option');o.value=email;return o;}));
  if(state.current)state.current=d.conversations.find(c=>c.id===state.current.id)||state.current;
  renderList();await history();
}
async function addFiles(files){
  if(state.busy||!state.data)return; if(state.files.length+files.length>12)return toast('最多添加 12 个附件。');state.busy=true;$('#send').disabled=true;
  try{for(const f of files){if(f.size>50*1024*1024)throw new Error(f.name+' 超过 50 MB。');const r=await fetch('/api/upload',{method:'POST',headers:{'X-Dialog-CSRF':state.data.csrf,'X-File-Name':encodeURIComponent(f.name)},body:f});const p=await r.json();if(!r.ok)throw new Error(p.error);state.requestId=null;state.files.push(p);renderFiles();}saveDraft();}catch(e){toast(e.message);}finally{state.busy=false;$('#send').disabled=false;$('#file-input').value='';}
}
// 新对话先作为草稿，首次发送时自动命名并创建，避免反复弹窗。
function resizeInput(){const input=$('#message');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';}
function newChat(){if(state.busy||!state.data)return;localStorage.removeItem('current');saveDraft();state.current=null;state.history=[];loadDraft();$('#chat-title').textContent=state.scope==='projectless'?'新对话 · 无项目':`新对话 · ${state.data.project}`;$('#export').disabled=true;$('#messages').innerHTML=welcome;delete $('#messages').dataset.conversation;document.body.classList.remove('sidebar-open');renderList();$('#message').focus();}
$('#composer').onsubmit=async e=>{
  e.preventDefault();if(state.busy||!state.data)return;
  const text=$('#message').value;if(!text.trim()&&!state.files.length)return toast('请输入消息或添加文件。');
  if(state.current?.archived)return toast('已归档对话暂不支持发送。');
  if(!state.data.models.length)return toast('尚无模型可用，请先打开并登录本机 Codex。');
  if($('#notify').checked&&(!$('#email').value.trim()||!$('#email').checkValidity()))return toast('请输入有效的通知邮箱。');
  state.busy=true;$('#send').disabled=true;
  try{
    await saveNotification();
    if(!state.current){
      const title=(text.trim().split('\n')[0]||state.files[0]?.name||'新对话').slice(0,40);
      state.current=await api('/api/conversations',{title,scope:state.scope});localStorage.setItem('current',state.current.id);
      $('#chat-title').textContent=state.current.title;$('#export').disabled=false;
      saveDraft();localStorage.removeItem('draft:new:'+state.scope);
    }
    const payload={id:state.requestId||crypto.randomUUID(),conversationId:state.current.id,text,model:$('#model').value,effort:$('#effort').value,notify:$('#notify').checked,email:$('#notify').checked?$('#email').value.trim():'',attachmentIds:state.files.map(f=>f.id)};
    state.requestId=payload.id;saveDraft();await api('/api/requests',payload);
    $('#message').value='';state.files=[];state.requestId=null;renderFiles();resizeInput();saveDraft();
    await refresh();$('#messages').scrollTop=$('#messages').scrollHeight;
  }catch(error){toast(error.message);}finally{state.busy=false;$('#send').disabled=false;$('#message').focus();}
};
$('#message').addEventListener('input',()=>{state.requestId=null;resizeInput();saveDraft();});$('#model').onchange=()=>{state.requestId=null;refreshEfforts();saveDraft();};$('#effort').onchange=()=>{state.requestId=null;saveDraft();};
$('#message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}};
$('#new-chat').onclick=newChat;
$('#scope').value=state.scope;$('#scope').onchange=()=>{if(state.busy||!state.data){$('#scope').value=state.scope;return;}saveDraft();state.scope=$('#scope').value;state.current=null;localStorage.setItem('scope',state.scope);loadDraft();newChat();};
$('#message').addEventListener('paste',e=>{const files=[...e.clipboardData.files];if(files.length){e.preventDefault();addFiles(files);}});
$('#search').oninput=renderList;$('#show-archived').onchange=renderList;
$('#show-used').onchange=()=>{state.used=$('#show-used').checked;renderList();};
$('#refresh').onclick=async()=>{$('#refresh').disabled=true;try{await api('/api/refresh',{});await refresh();toast('对话列表已刷新。');}catch(e){toast(e.message);}finally{$('#refresh').disabled=false;}};
$('#add-file').onclick=()=>$('#file-input').click();$('#file-input').onchange=()=>addFiles([...$('#file-input').files]);
$('#export').onclick=()=>{if(state.current)location.href='/api/export?id='+encodeURIComponent(state.current.id);};
$('#connection').onclick=()=>{
  if(!state.data)return toast('正在连接，请稍后打开设置。');
  const badge=$('#dot-status');
  $('#connection-details').replaceChildren(el('p','客户端：'+(state.data.connection.ok?'已连接':state.data.connection.error)),el('p',badge.textContent+(badge.title?' · '+badge.title:'')));
  $('#connection-dialog').showModal();
};$('#close-connection').onclick=()=>$('#connection-dialog').close();
$('#menu').onclick=()=>document.body.classList.toggle('sidebar-open');
async function saveNotification(){
  clearTimeout(state.notificationTimer);
  if(state.notificationSaving){await state.notificationSaving;if(state.notificationDirty)return saveNotification();return;}
  if(!state.notificationDirty)return;
  const value={email:$('#email').value.trim(),enabled:$('#notify').checked,version:state.notificationVersion};
  if(value.email&&!$('#email').checkValidity())throw new Error('请输入有效邮箱；设置尚未保存。');
  state.notificationDirty=false;
  state.notificationSaving=api('/api/notification-settings',value).then(result=>{state.notificationVersion=result.version;state.data.notification=result;$('#email-save-status').textContent='已同步到各端';}).catch(async error=>{state.notificationDirty=true;try{state.notificationVersion=(await api('/api/state')).notification.version;}catch{}$('#email-save-status').textContent='未保存：'+error.message;throw error;}).finally(()=>{state.notificationSaving=null;});
  return state.notificationSaving;
}
function notificationChanged(){state.requestId=null;state.notificationDirty=true;$('#email-save-status').textContent='正在保存…';clearTimeout(state.notificationTimer);state.notificationTimer=setTimeout(()=>saveNotification().catch(e=>toast(e.message)),600);}
$('#notify').onchange=()=>{if(!$('#notify').checked&&!$('#email').checkValidity()){$('#email').value=state.data.notification.email;toast('邮箱输入尚未完成，先保留已保存的地址并关闭通知。');}notificationChanged();saveNotification().catch(e=>toast(e.message));};
$('#email').addEventListener('input',notificationChanged);
$('#email').addEventListener('change',()=>saveNotification().catch(e=>toast(e.message)));

document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();document.body.classList.add('sidebar-open');$('#search').focus();}});
document.addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('dragging');});document.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('dragging');});document.addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('dragging');addFiles([...e.dataTransfer.files]);});
window.addEventListener('beforeunload',saveDraft);
$('#notify').checked=false;$('#email').disabled=false;
await refresh().then(async()=>{const previous=state.data.conversations.find(c=>c.id===localStorage.getItem('current')&&c.scope===state.scope);if(previous)await choose(previous,false);else loadDraft();}).catch(e=>toast(e.message));setInterval(()=>refresh().catch(()=>{}),5000);

$('#tunnel-form').onsubmit=async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true;
  try{await api('/api/tunnel/connect',{key:$('#tunnel-key').value});$('#tunnel-key').value='';$('#tunnel-result').textContent='凭据已加密保存，隧道正在连接。';await refresh();}
  catch(error){$('#tunnel-result').textContent=error.message;}finally{button.disabled=false;}
};

$('#close-sidebar').onclick=$('#sidebar-backdrop').onclick=()=>document.body.classList.remove('sidebar-open');
