import { useEffect, useState } from 'react'
import { bridge, useSettings } from '../api'
import { Settings } from 'lucide-react'
import { Menu } from '../ui/Menu'

export function SettingsView() {
  const { settings, update } = useSettings()
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null)
  const [probing, setProbing] = useState(false)
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
    if (probing) return
    setProbing(true)
    try {
      await update({ zcodePath: zcodePath.trim(), nodePath: nodePath.trim(), dshPath: dshPath.trim() })
      const r = await bridge.settings.probe()
      setProbe({ ok: r.ok, detail: r.detail })
    } catch (e) {
      setProbe({ ok: false, detail: '检测失败: ' + (e instanceof Error ? e.message : String(e)) })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="settings">
      <header className="page-header-bar">
        <div className="detail-title-wrap">
          <div className="page-title-row">
            <Settings size={16} className="page-icon" />
            <h2 className="page-title">设置</h2>
          </div>
        </div>
      </header>

      <section className="settings-card">
        <h3>执行后端 · ZCode / DeepSeek Harness 路径</h3>
        <p className="hint">
          执行后端 = 实际执行任务的 CLI 程序（zcode、claude、codex、opencode、dsh）。zcode 与 dsh
          不是标准 PATH 安装，需要在此指定路径；claude / codex / opencode 装在 PATH 上即可自动发现，无需配置，未安装也不影响 zcode 使用。
        </p>
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
          <button className="btn" onClick={doProbe} disabled={probing}>
            {probing ? '检测中…' : '检测可用性'}
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
        <h3>外观</h3>
        <label className="field">
          <span>主题</span>
          <Menu
            items={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' }
            ]}
            value={settings.theme ?? 'dark'}
            onChange={(v) => update({ theme: v as any })}
            trigger={(cur, open) => (
              <button className="btn menu-trigger" type="button">
                {cur?.label ?? '深色'} <span className="menu-caret">{open ? '▴' : '▾'}</span>
              </button>
            )}
          />
        </label>
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
          <Menu
            items={[
              { value: 'yolo', label: 'yolo', hint: '全自动，推荐' },
              { value: 'build', label: 'build', hint: '构建类操作自动放行' },
              { value: 'edit', label: 'edit', hint: '编辑需确认*' },
              { value: 'plan', label: 'plan', hint: '只读规划*' }
            ]}
            value={settings.mode}
            onChange={(v) => update({ mode: v as any })}
            trigger={(cur, open) => (
              <button className="btn menu-trigger" type="button">
                {cur?.label ?? settings.mode} <span className="menu-caret">{open ? '▴' : '▾'}</span>
              </button>
            )}
          />
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
