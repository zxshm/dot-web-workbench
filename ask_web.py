"""把当前网页请求的澄清问题交给网页用户，并等待原问题的回答。"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error


def call(base, route, data=None):
    with urllib.request.urlopen(base + '/api/state', timeout=15) as response:
        csrf = json.load(response)['csrf']
    headers = {'Content-Type': 'application/json', 'X-Dialog-CSRF': csrf}
    request = urllib.request.Request(base + route, data=None if data is None else json.dumps(data).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--port', type=int, default=4190)
    args = parser.parse_args()
    questions = json.load(sys.stdin)
    base = f'http://127.0.0.1:{args.port}'
    group = call(base, '/api/questions/create', {'requestId': args.request, 'questions': questions})
    print('问题已显示在网页，等待用户回答。请继续等待此进程，不要替用户选择或重复提问。', file=sys.stderr, flush=True)
    deadline = time.monotonic() + 24 * 3600
    while time.monotonic() < deadline:
        try:
            group = call(base, '/api/questions/get?id=' + group['id'])
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(5)
            continue
        if group['status'] == 'answered':
            print(json.dumps({'questions': group['content'], 'answers': group['answers']}, ensure_ascii=False), flush=True)
            return
        if group['status'] != 'pending':
            raise RuntimeError('本轮已结束，问题已过期；不要把它当作用户回答。')
        time.sleep(2)
    raise RuntimeError('等待已超过 24 小时；没有获得用户回答。')


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
