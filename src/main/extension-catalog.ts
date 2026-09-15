// 内置精选扩展源目录（「常用仓库」清单，随应用发布）；sources:add 用 repo 一键添加
import type { CatalogEntry } from '../shared/extensions'

export const EXTENSION_CATALOG: CatalogEntry[] = [
  { id: 'anthropic-skills', name: 'Anthropic 官方 Skills', repo: 'https://github.com/anthropics/skills', category: 'skills', description: '官方 Agent Skills 集：文档处理、创意工件等' },
  { id: 'claude-plugins-official', name: 'Claude 官方插件市场', repo: 'https://github.com/anthropics/claude-plugins-official', category: 'plugins', description: 'Claude Code 官方插件目录（290+ 插件）' },
  { id: 'superpowers', name: 'Superpowers', repo: 'https://github.com/obra/superpowers', category: 'skills', description: '知名技能合集：TDD、头脑风暴、调试方法论等' },
  { id: 'wshobson-agents', name: 'Claude Agents', repo: 'https://github.com/wshobson/agents', category: 'skills', description: '70+ 专业 subagent 提示词集' },
  { id: 'mcp-reference-servers', name: 'MCP 参考服务器', repo: 'https://github.com/modelcontextprotocol/servers', category: 'mcp', description: 'MCP 官方参考服务器源码（Filesystem/SQLite/GitHub 等）' },
  { id: 'awesome-mcp-servers', name: 'Awesome MCP Servers', repo: 'https://github.com/punkpeye/awesome-mcp-servers', category: 'index', description: 'MCP 服务器大全索引' },
  { id: 'awesome-claude-code', name: 'Awesome Claude Code', repo: 'https://github.com/hesreallyhim/awesome-claude-code', category: 'index', description: 'Claude Code 生态资源大全索引' }
]
