import type { Meeting, MeetingTurn } from '../../../../shared/meeting'
import type { Issue, Task, TaskStatus } from '../../../../shared/types'

export function meetingRootId(meetingId: string): string { return `meeting:${meetingId}` }

export function currentMeetingRound(meeting: Meeting, turns: readonly MeetingTurn[]): number {
  return turns.reduce((round, turn) => turn.meetingId === meeting.id && Number.isSafeInteger(turn.round)
    ? Math.max(round, turn.round) : round, Math.max(1, meeting.round || 0))
}

export function isMeetingInternalTask(task: Pick<Task, 'meetingTaskRole' | 'suppressIssue' | 'trigger' | 'officeAgentId'>): boolean {
  return task.meetingTaskRole === 'member' || task.meetingTaskRole === 'investigation'
    || (task.meetingTaskRole !== 'container' && !!task.suppressIssue && task.trigger === 'meeting' && !task.officeAgentId)
}

export function meetingPresentation(meeting: Meeting): { label: string; detail: string; status: TaskStatus } {
  if (meeting.stopState === 'failed') return { label: '停止受阻', detail: meeting.blockedReason || '仍有会议执行未取得退出证明，不能视为停止成功或删除。', status: 'failed' }
  if (meeting.stopState === 'stopping') return { label: '正在停止', detail: '已请求停止整场会议，正在等待成员和内部调查的退出确认。独立咨询办公室不受影响。', status: 'queued' }
  if (meeting.deleting) return { label: '正在删除', detail: '正在核验整场会议的退出证明并清理任务和日志。', status: 'queued' }
  if (meeting.status === 'cancelled') return meeting.executionEpoch === undefined
    ? { label: '历史已取消', detail: '旧记录没有提供整场会议的退出证明；清理仍由宿主核验，不能从页面状态推断进程已退出。', status: 'cancelled' }
    : { label: '已停止', detail: '会议停止已完成。独立咨询办公室不归本会议停止或删除。', status: 'cancelled' }
  if (meeting.status === 'concluded') return { label: '已完成', detail: '公开讨论已结束；纪要和逐成员确认保留在时间线。行动项执行需要单独批准。', status: 'done' }
  if (meeting.status === 'failed') return { label: '执行失败', detail: meeting.blockedReason || '执行失败不代表整场进程退出已确认；恢复和删除由宿主重新核验。', status: 'failed' }
  if (meeting.status === 'waiting_user') return { label: '等你处理', detail: meeting.blockedReason || '会议等待你的插话或继续决定；内部调查不等于当前公开发言。', status: 'queued' }
  if (meeting.status === 'draft') return { label: '待开始', detail: '会议已创建，尚未启动成员会话。', status: 'queued' }
  return { label: meeting.currentTurn ? '讨论中' : '正在准备', detail: meeting.currentTurn ? '正式发言串行发布，内部调查可并行；工具和草稿在成员侧栏查看。' : '正在准备会议成员会话与公开输入上下文。', status: 'running' }
}

export function currentMeetingSpeech(meeting: Meeting, turns: readonly MeetingTurn[]): MeetingTurn | null {
  if (meeting.status !== 'active' || meeting.stopState || meeting.deleting || !meeting.currentTurn) return null
  return [...turns].reverse().find((turn) => turn.agentId === meeting.currentTurn!.agentId && turn.status === 'speaking' && turn.purpose !== 'chair') ?? null
}

export function meetingForNavigation(id: string, tasks: readonly Task[], meetings: readonly Meeting[]): Meeting | null {
  const direct = meetings.find((meeting) => id === meetingRootId(meeting.id) || id === meeting.id)
  if (direct) return direct
  const task = tasks.find((item) => item.id === id)
  if (task && isMeetingInternalTask(task)) return null
  return meetings.find((meeting) => (meeting.ownsIssue !== false || task?.meetingTaskRole === 'container')
    && (id === meeting.issueId || id === meeting.containerTaskId || task?.meetingId === meeting.id || task?.issueId === meeting.issueId)) ?? null
}

export function meetingNavigationTasks(tasks: readonly Task[], meetings: readonly Meeting[], issues: readonly Issue[]): Task[] {
  return [...tasks, ...meetings.map((meeting): Task => {
    const issue = issues.find((item) => item.id === meeting.issueId)
    return {
      id: meetingRootId(meeting.id), title: issue?.title ?? meeting.topic, prompt: issue?.description ?? meeting.topic,
      workdir: meeting.workdir ?? '', backend: 'meeting', issueId: meeting.issueId, meetingId: meeting.id,
      meetingTaskRole: 'container', status: meetingPresentation(meeting).status, createdAt: meeting.createdAt,
      startedAt: meeting.createdAt, endedAt: meeting.concludedAt, eventCount: 0
    }
  })]
}

export function meetingNavigationCatalog(tasks: readonly Task[], meetings: readonly Meeting[], issues: readonly Issue[]) {
  const catalog = meetingNavigationTasks(tasks, meetings, issues).map((task) => {
    const internal = isMeetingInternalTask(task)
    const meeting = task.meetingId ? meetings.find((item) => item.id === task.meetingId) : meetingForNavigation(task.id, tasks, meetings)
    const root = meeting ? meetingRootId(meeting.id) : undefined
    return { id: task.id, title: task.title, parentTaskId: task.parentTaskId, ...(root && root !== task.id ? { viewRootId: root } : {}), ...(internal ? { hidden: true } : {}) }
  })
  const ids = new Set(catalog.map((item) => item.id))
  for (const meeting of meetings) {
    const title = issues.find((issue) => issue.id === meeting.issueId)?.title ?? meeting.topic
    for (const id of [meeting.id, meeting.containerTaskId, ...(meeting.ownsIssue !== false ? [meeting.issueId] : [])]) {
      if (!id || ids.has(id)) continue
      catalog.push({ id, title, parentTaskId: undefined, viewRootId: meetingRootId(meeting.id) })
      ids.add(id)
    }
  }
  return catalog
}

export function meetingNavigationEntries(tasks: readonly Task[], meetings: readonly Meeting[], issues: readonly Issue[]): Task[] {
  return meetingNavigationTasks(tasks, meetings, issues).filter((task) => {
    if (isMeetingInternalTask(task)) return false
    const meeting = meetingForNavigation(task.id, tasks, meetings)
    return !meeting || task.id === meetingRootId(meeting.id)
  })
}
