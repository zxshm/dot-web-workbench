export function notificationSettings(store, config) {
  const email=store.setting('emails')?.at(-1)||config.defaultEmail||'';
  return store.setting('notification')||{email,enabled:Boolean(email),version:0};
}
export function saveNotificationSettings(store, config, input) {
  const current=notificationSettings(store,config);
  if(input.version!==current.version)throw new Error('通知设置已在另一端修改，请刷新后重试。');
  if(typeof input.email!=='string'||input.email.length>254||(input.email&&!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(input.email)))throw new Error('通知邮箱格式不正确。');
  if(typeof input.enabled!=='boolean')throw new Error('通知开关无效。');
  const next={email:input.email,enabled:input.enabled,version:current.version+1};
  store.setting('notification',next);
  if(!next.enabled)store.db.prepare("UPDATE requests SET mail_status='skipped' WHERE mail_status='none'").run();
  return next;
}
