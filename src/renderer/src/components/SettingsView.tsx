import { useEffect, useState } from 'react'
import { bridge, useSettings } from '../api'

export function SettingsView() {
  const { settings, update } = useSettings()
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null)
  const [zcodePath, setZcodePath] = useState('')
  const [nodePath, setNodePath] = useState('')
  const [dshPath, setDshPath] = useState('')

  useEffect(() => {
    if (settings) {
      setZcodePath(settings.zcodePath)
      setNodePath(settings.nodePath)
      setDshPath(settings.dshPath ?? '')
    }
  }, [settings?.zcodePath, settings?.nodePath, settings?.dshPath])

  if (!settings) return <div className="empty">加载中…</div>

  const doProbe = async () => {
    await update({ zcodePath: zcodePath.trim(), nodePath: nodePath.trim(), dshPath: dshPath.trim() })
    const r = await bridge.settings.probe()
    setProbe({ ok: r.ok, detail: r.detail })
  }

  return (
    <div className="settings">
      <h2>设置</h2>

      <section className="settings-card">
        <h3>执行后端 · ZCode</h3>
        <label className="field">
          <span>zcode.cjs 路径（留空 = 自动探测）</span>
          <input value={zcodePath} onChange={(e) => setZcodePath(e.target.value)} placeholder="D:\Program Files\ZCode\resources\glm\zcode.cjs" />
        </label>
        <label className="field">
          <span>Node 路径（留空 = 使用内置运行时）</span>
          <input value={nodePath} onChange={(e) => setNodePath(e.target.value)} placeholder="C:\Program Files\nodejs\node.exe" />
        </label>
        <label className="field">
          <span>DeepSeek Harness bin.js 路径（留空 = 自动扫描）</span>
          <input
            value={dshPath}
            onChange={(e) => setDshPath(e.target.value)}
            placeholder="D:\Program files\deepseek-harness\apps\cli\lib\bin.js"
          />
        </label>
        <div className="row">
          <button className="btn" onClick={doProbe}>
            检测可用性
          </button>
          {probe && (
            <span className={probe.ok ? 'probe-ok' : 'probe-fail'}>
              {probe.ok ? '✓ ' : '✗ '}
              {probe.detail}
            </span>
          )}
        </div>
      </section>

      <section className="settings-card">
        <h3>执行</h3>
        <label className="field">
          <span>并发任务数：{settings.concurrency}</span>
          <input
            type="range"
            min={1}
            max={4}
            value={settings.concurrency}
            onChange={(e) => update({ concurrency: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>权限模式</span>
          <select value={settings.mode} onChange={(e) => update({ mode: e.target.value as any })}>
            <option value="yolo">yolo（全自动，推荐）</option>
            <option value="build">build（构建类操作自动放行）</option>
            <option value="edit">edit（编辑需确认*）</option>
            <option value="plan">plan（只读规划*）</option>
          </select>
          <span className="hint">* 当前版本确认请求也会自动放行，交互式确认在路线图上</span>
        </label>
        <label className="field row-field">
          <input type="checkbox" checked={settings.notifyOnDone} onChange={(e) => update({ notifyOnDone: e.target.checked })} />
          <span>任务完成/失败时弹系统通知</span>
        </label>
      </section>

      <section className="settings-card">
        <h3>存储</h3>
        <p className="hint">
          任务数据保存在系统 userData 目录（tasks.json + 每任务 events.jsonl）。
          <br />
          首次执行会从 ZCode 登录态（~/.zcode/v2/config.json）生成本工具所需的 ~/.zcode/cli/config.json。
        </p>
      </section>
    </div>
  )
}
