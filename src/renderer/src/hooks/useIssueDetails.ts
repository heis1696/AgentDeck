import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from '../api'
import type { Comment, Issue, IssuePriority, IssueStatus, Run } from '../../../shared/types'

export function useIssueDetails(issueId: string, refreshKey: string) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [labelsDraft, setLabelsDraft] = useState('')
  const mountedRef = useRef(false)
  const requestRef = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    const [nextIssue, nextComments, nextRuns] = await Promise.all([bridge.issues.get(issueId), bridge.issues.comments(issueId), bridge.issues.runs(issueId)])
    if (!mountedRef.current || request !== requestRef.current) return nextIssue
    setIssue(nextIssue)
    setLabelsDraft(nextIssue?.labels.join(', ') ?? '')
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

  const addComment = useCallback(async (content: string) => {
    if (!content.trim()) return null
    const comment = await bridge.issues.addComment(issueId, content)
    if (comment) setComments((current) => [...current, comment])
    return comment
  }, [issueId])

  const updateIssue = useCallback(async (patch: { priority?: IssuePriority; labels?: string[] }) => {
    const next = await bridge.issues.update(issueId, patch)
    if (next) {
      setIssue(next)
      setLabelsDraft(next.labels.join(', '))
    }
    return next
  }, [issueId])

  const updateWorkflow = useCallback((status: IssueStatus) => bridge.issues.update(issueId, { status }).then((next) => {
    if (next) setIssue(next)
    return next
  }), [issueId])

  return { issue, comments, runs, labelsDraft, setLabelsDraft, refreshIssue: refresh, addComment, updateIssue, updateWorkflow }
}
