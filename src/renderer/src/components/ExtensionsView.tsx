import { useEffect, useState } from 'react'
import { FolderOpen, Layers, Puzzle, Server, Sparkles, Webhook, type LucideIcon } from 'lucide-react'
import { bridge, useSettings } from '../api'
import { PageHeader } from '../ui/PageHeader'
import { SkillsTabWithUrlInstall } from './extensions/skills/SkillDiscover'
import { McpTab } from './extensions/mcp/McpTab'
import { HooksTab } from './extensions/hooks/HooksTab'
import { PluginsTab } from './extensions/plugins/PluginsTab'

type ExtTabId = 'skills' | 'mcp' | 'hooks' | 'plugins'

const TABS: Array<{ id: ExtTabId; label: string; icon: LucideIcon }> = [
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Server },
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  { id: 'plugins', label: '插件', icon: Puzzle }
]

/** 选中的 tab 跨普通导航保留（离开扩展页再回来不重置）；与 workspace-dir 等一样走 localStorage */
const EXT_TAB_KEY = 'agentdeck:extensions-tab'
const EXT_TAB_IDS = TABS.map((item) => item.id)

function readStoredTab(): ExtTabId {
  try {
    const saved = localStorage.getItem(EXT_TAB_KEY)
    return EXT_TAB_IDS.includes(saved as ExtTabId) ? saved as ExtTabId : 'skills'
  } catch {
    return 'skills'
  }
}

/** 扩展页：技能 / MCP / Hooks / 插件四 tab 的外壳（标题 + 共享目录链接 + tab 条）。
 *  EXTENSIONS-HUB §8.7：无独立仓库 tab——发现与已装同页，扩展源是发现区（技能 tab / 插件 tab）的数据层。
 *  本文件只做装配：各 tab 的实现在 extensions/ 四域子目录（skills / mcp / hooks / plugins，
 *  源管理与市场展示层在 sources/ 与 shared/），域间只单向依赖 shared/，不得互相成环。 */
export function ExtensionsView() {
  const { settings } = useSettings()
  const [tab, setTab] = useState<ExtTabId>(readStoredTab)
  const [root, setRoot] = useState('')

  // 共享目录解析路径（空设置时主进程回落到 ~/.agentdeck）
  useEffect(() => {
    let alive = true
    void bridge.skills.list().then((data) => { if (alive) setRoot(data.root) }).catch(() => {})
    return () => { alive = false }
  }, [settings?.sharedDir])

  /** 选中即记忆：普通导航（切走再切回）不重置到技能 tab，应用重启后也保持一致 */
  const selectTab = (next: ExtTabId) => {
    setTab(next)
    try {
      localStorage.setItem(EXT_TAB_KEY, next)
    } catch {
      /* 存储不可用（隐私模式 / 配额）时只在本次会话内保留 */
    }
  }

  return <div className="skills-view page-surface ext-view">
    {/* 共享目录路径是页头里的上下文/动作项，不再另起一套页头布局 */}
    <PageHeader
      title="扩展"
      icon={<Layers size={16} />}
      metadata={<button className="skills-root-link" onClick={() => void bridge.skills.openDir()} title="打开共享目录">
        <FolderOpen size={13} /><span>{root || settings?.sharedDir || '…'}</span>
      </button>}
    />
    <div className="ext-tabs" role="tablist" aria-label="扩展分类">
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={`ext-tab ${tab === item.id ? 'active' : ''}`}
          onClick={() => selectTab(item.id)}
        >
          <item.icon size={14} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
    <div className="page-content market-content ext-content">
      {tab === 'skills' ? <SkillsTabWithUrlInstall />
        : tab === 'mcp' ? <McpTab />
          : tab === 'hooks' ? <HooksTab />
            : <PluginsTab />}
    </div>
  </div>
}
