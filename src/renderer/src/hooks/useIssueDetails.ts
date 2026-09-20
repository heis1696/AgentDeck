import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from '../api'
import type { Comment, Issue, IssueStatus, Run } from '../../../shared/types'

export function useIssueDetails(issueId: string, refreshKey: string) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  // 任务隔离：issueId 跟着任务走（缺省 `iss_<taskId>`），而任务详情是同一个实例复用的。
  // 渲染期结算掉上一个 Issue 的详情，避免切任务那一帧拿 A 的 identifier/评论/报告去渲染 B 的头部与动态；
  // 在途请求本身另由 requestRef 序号判废，旧响应不会落地。refreshKey 变化（状态/结果/事件数）不触发清空。
  const [scope, setScope] = useState(issueId)
  if (scope !== issueId) {
    setScope(issueId)
    setIssue(null)
    setComments([])
    setRuns([])
  }
  const mountedRef = useRef(false)
  const requestRef = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    const [nextIssue, nextComments, nextRuns] = await Promise.all([bridge.issues.get(issueId), bridge.issues.comments(issueId), bridge.issues.runs(issueId)])
    if (!mountedRef.current || request !== requestRef.current) return nextIssue
    setIssue(nextIssue)
    setComments(nextComments)
    setRuns(nextRuns)
  }, [issueId])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const off = bridge.issues.onUpdated((payload) => {
      if (payload.issueId === issueId) void refresh()
    })
    return () => {
      mountedRef.current = false
      ++requestRef.current
      off()
    }
  }, [issueId, refresh, refreshKey])

  const updateWorkflow = useCallback((status: IssueStatus) => bridge.issues.update(issueId, { status }).then((next) => {
    if (next) setIssue(next)
    return next
  }), [issueId])

  return { issue, comments, runs, refreshIssue: refresh, updateWorkflow }
}
