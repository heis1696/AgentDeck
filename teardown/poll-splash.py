# -*- coding: utf-8 -*-
"""轮询已提交的 AgentDeck 开机动画生成任务并下载结果"""
import json, time, urllib.request, urllib.parse, sys

BASE = 'http://127.0.0.1:8188'
PID = sys.argv[1] if len(sys.argv) > 1 else 'edaa9424-d0c4-4d2a-b3f7-0a6022832ced'

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())

t0 = time.time()
while True:
    time.sleep(20)
    try:
        h = get('/history/' + PID).get(PID)
        q = get('/queue').get('queue_running', [])
        pending = get('/queue').get('queue_pending', [])
    except Exception as e:
        print(f'[{int(time.time()-t0)}s] poll error: {e}', flush=True)
        continue
    if h is None:
        print(f'[{int(time.time()-t0)}s] running={len(q)} pending={len(pending)} ...', flush=True)
        continue
    status = h.get('status', {})
    if status.get('status_str') == 'error':
        print('EXEC ERROR:', json.dumps(status, ensure_ascii=False)[:2000], flush=True)
        msgs = h.get('status', {}).get('messages', [])
        print('messages:', json.dumps(msgs, ensure_ascii=False)[:2000], flush=True)
        sys.exit(1)
    videos = []
    for nid, out in h.get('outputs', {}).items():
        for v in out.get('videos', []):
            videos.append(v)
    if not videos:
        print('completed without videos; outputs=', json.dumps(h.get('outputs', {}))[:800], flush=True)
        sys.exit(1)
    v = videos[0]
    print('DONE in', int(time.time() - t0), 's ->', v, flush=True)
    qurl = f"/view?filename={urllib.parse.quote(v['filename'])}&subfolder={urllib.parse.quote(v.get('subfolder',''))}&type={urllib.parse.quote(v.get('type',''))}"
    dest = r'D:\agentdeck\teardown\agentdeck-splash.mp4'
    with urllib.request.urlopen(BASE + qurl, timeout=300) as r, open(dest, 'wb') as f:
        f.write(r.read())
    print('SAVED', dest, flush=True)
