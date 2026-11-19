"""配置 SMTP 授权码，或发送一条用户已启用的通知。"""
import getpass
import json
from pathlib import Path
import smtplib
import ssl
import sys
from email.message import EmailMessage

from protect import protect


ROOT = Path(__file__).resolve().parent
PASSWORD = ROOT / 'data' / 'smtp-password.dpapi'


def setup():
    password = getpass.getpass('输入 SMTP 授权码（输入内容不会显示）：').strip()
    if not password:
        raise ValueError('SMTP 授权码不能为空。')
    PASSWORD.parent.mkdir(exist_ok=True)
    partial = PASSWORD.with_suffix('.part')
    partial.write_bytes(protect(password.encode('utf-8')))
    partial.replace(PASSWORD)
    print('SMTP 授权码已使用当前 Windows 用户的 DPAPI 加密保存。')


def deliver(payload):
    smtp = json.loads((ROOT/'config.json').read_text(encoding='utf-8-sig')).get('smtp', {})
    if not smtp.get('host') or not smtp.get('username') or not PASSWORD.is_file():
        raise ValueError('SMTP 未配置。')
    password = protect(PASSWORD.read_bytes(), decrypt=True).decode('utf-8')
    message = EmailMessage()
    message['From'] = smtp['username']
    message['To'] = payload['recipient']
    message['Subject'] = 'Dot 网页工作台：' + payload['title'][:80]
    message.set_content(payload['body'])
    with smtplib.SMTP_SSL(smtp['host'], smtp.get('port', 465), timeout=30, context=ssl.create_default_context()) as client:
        client.login(smtp['username'], password)
        client.send_message(message)


if __name__ == '__main__':
    if sys.argv[1:] == ['--setup']:
        setup()
    else:
        try:
            deliver(json.load(sys.stdin.buffer))
            print('邮件服务器已接收。')
        except Exception:
            # 连接中断时可能已被接收，退出后由工作台标记未确认。
            print('邮件发送结果未确认，请检查本机 SMTP 配置。')
            sys.exit(1)
