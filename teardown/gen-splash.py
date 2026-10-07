# -*- coding: utf-8 -*-
"""AgentDeck 开机动画生成：MiniMax H3 t2v（API prompt 手工展开自 video_minimax_h3_t2v.json subgraph）"""
import json, random, time, urllib.request, sys, io

BASE = 'http://127.0.0.1:8188'

PROMPT = (
    "Dark premium tech aesthetic, abstract motion design title sequence for a developer tool. "
    "Deep charcoal-black background (#0f1115 tone) with soft volumetric haze. "
    "Floating translucent glass task cards drift slowly in parallax layers, like kanban panels suspended in space, "
    "connected by thin glowing indigo-cyan light threads that pulse gently, as if data were flowing through a living board. "
    "One slow, smooth continuous camera dolly-in along a central lane of light, no cuts, no fast motion. "
    "Fine particle dust catching the light, subtle depth of field. "
    "Restrained palette: charcoal, slate, soft cyan and violet accents; gentle bloom, no harsh contrast. "
    "Mood: calm, elegant, confident — the first second of a high-end local-first app waking up. "
    "The scene brightens very slightly toward the end and settles. "
    "No text, no letters, no numbers, no logos, no watermarks, no humans, no photographic realism — pure abstract motion design, "
    "premium dark UI render style. "
    "Audio: soft ambient synth pad, low sub-bass hum, faint airy whoosh as cards drift past, one gentle rising digital chime near the end, then silence."
)

seed = random.randint(1, 2**48)

prompt = {
    "1119": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}, "_meta": {"title": "video_vae"}},
    "1120": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}, "_meta": {"title": "audio_vae"}},
    "1121": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["1125", 0], "vae": ["1120", 0]}},
    "1122": {"class_type": "VAEDecode", "inputs": {"samples": ["1125", 0], "vae": ["1119", 0]}},
    "1123": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
    "1124": {"class_type": "BasicScheduler", "inputs": {"model": ["1134", 0], "scheduler": "simple", "steps": 4, "denoise": 1.0}},
    "1125": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["1129", 0], "guider": ["1126", 0], "sampler": ["1123", 0], "sigmas": ["1124", 0], "latent_image": ["1131", 1]}},
    "1126": {"class_type": "BasicGuider", "inputs": {"model": ["1134", 0], "conditioning": ["1131", 0]}},
    "1127": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
    "1128": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
    "1129": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
    "1130": {"class_type": "CreateVideo", "inputs": {"images": ["1122", 0], "fps": 24, "audio": ["1121", 0], "bit_depth": 8}},
    "1131": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"clip": ["1128", 0], "vae": ["1119", 0], "prompt": PROMPT, "width": 1184, "height": 768, "length": ["1132", 1]}},
    "1132": {"class_type": "ComfyMathExpression", "inputs": {"expression": "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17", "values": {"a": ["1133", 0]}}},
    "1133": {"class_type": "PrimitiveFloat", "inputs": {"value": 5}},
    "1134": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1127", 0], "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "strength_model": 1.0}},
    "92": {"class_type": "SaveVideo", "inputs": {"video": ["1130", 0], "filename_prefix": "video/AgentDeck_Splash", "format": "auto"}},
}

def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())

resp = post('/api/prompt', {'prompt': prompt, 'client_id': 'agentdeck-splash'})
if resp.get('node_errors'):
    print('NODE ERRORS:', json.dumps(resp['node_errors'], ensure_ascii=False)[:2000]); sys.exit(1)
pid = resp['prompt_id']
print('submitted prompt_id=', pid, 'seed=', seed, flush=True)

t0 = time.time()
while True:
    time.sleep(15)
    h = get('/history/' + pid).get(pid)
    if h is None:
        print(f'[{int(time.time()-t0)}s] queued/running...', flush=True)
        continue
    status = h.get('status', {})
    if status.get('status_str') == 'error':
        print('EXEC ERROR:', json.dumps(status, ensure_ascii=False)[:1500]); sys.exit(1)
    outputs = h.get('outputs', {})
    videos = []
    for nid, out in outputs.items():
        for v in out.get('videos', []):
            videos.append(v)
    if not videos:
        print(f'[{int(time.time()-t0)}s] completed without videos?! outputs={json.dumps(outputs)[:600]}', flush=True)
        sys.exit(1)
    v = videos[0]
    print('DONE in', int(time.time() - t0), 's ->', v['filename'], 'subfolder:', v.get('subfolder'), 'type:', v.get('type'), flush=True)
    # 下载到本地
    q = f"/view?filename={urllib.request.quote(v['filename'])}&subfolder={urllib.request.quote(v.get('subfolder',''))}&type={urllib.request.quote(v.get('type',''))}"
    dest = r'D:\agentdeck\teardown\agentdeck-splash.mp4'
    with urllib.request.urlopen(BASE + q, timeout=120) as r, open(dest, 'wb') as f:
        f.write(r.read())
    print('SAVED', dest, flush=True)
    break
