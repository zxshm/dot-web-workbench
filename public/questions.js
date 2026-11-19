function node(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
export function renderQuestions(request,api,reload,toast){
  const section=node('section');section.className='question-groups';
  for(const group of request.questions||[]){
    const form=node('form');form.className='question-card';
    form.append(node('h3',group.status==='pending'?'需要你回答':group.status==='answered'?'你的回答':'问题已结束'));
    const key='question-draft:'+group.id;let draft={};try{draft=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
    const inputs=new Map();
    for(const q of group.content){
      const field=node('fieldset'),legend=node('legend',q.question);field.append(legend);
      if(group.status!=='pending'){field.append(node('p',group.answers?.[q.id]||'本轮已结束，未提交回答。'));form.append(field);continue;}
      const input=node('textarea');input.rows=2;input.maxLength=12000;input.required=true;input.placeholder=q.options.length?'点击选项，或输入自己的回答…':'输入你的回答…';input.setAttribute('aria-label',q.question);input.value=draft[q.id]||'';
      const buttons=[];const save=()=>{draft[q.id]=input.value;localStorage.setItem(key,JSON.stringify(draft));for(const b of buttons)b.setAttribute('aria-pressed',String(b.textContent===input.value));};
      const choices=node('div');choices.className='question-options';
      for(const option of q.options){const b=node('button',option);b.type='button';b.setAttribute('aria-pressed',String(input.value===option));b.onclick=()=>{input.value=option;save();};buttons.push(b);choices.append(b);}
      input.oninput=save;inputs.set(q.id,input);field.append(choices,input);form.append(field);
    }
    if(group.status==='pending'){
      const submit=node('button','提交回答，继续处理');submit.type='submit';submit.className='question-submit';form.append(submit);
      form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{await api('/api/questions/answer',{requestId:request.id,id:group.id,answers:Object.fromEntries([...inputs].map(([id,input])=>[id,input.value]))});localStorage.removeItem(key);await reload();}catch(e){toast(e.message);submit.disabled=false;}};
    }
    section.append(form);
  }
  for(const group of request.native_questions||[]){
    const card=node('div');card.className='question-card';card.append(node('h3',group.completed?'Codex 提问记录':'Codex 原生提问'));
    for(const q of group.questions||[]){card.append(node('p',q.question));for(const o of q.options||[])card.append(node('p','• '+o.label+(o.description?'：'+o.description:'')));const answer=group.answers?.[q.id];if(answer)card.append(node('p','回答：'+(Array.isArray(answer)?answer.join('；'):JSON.stringify(answer))));}
    if(!group.completed){card.append(node('p','这条提问使用了客户端原生组件，当前接口无法从网页提交。请在 Codex 原会话回答；之后这里会自动更新。'));const a=node('a','打开 Codex 原会话');a.href='codex://threads/'+encodeURIComponent(group.threadId);card.append(a);}
    section.append(card);
  }
  return section;
}
