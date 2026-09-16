import type { AgentInfo } from '../../../../shared/contracts'

/** 队长资格：非 dsh 平台，且（角色匹配 队长/领队/captain/leader 或带队员）。两处会议新建表单共用。 */
export function isCaptain(agent: AgentInfo): boolean {
  if (agent.backend === 'dsh') return false
  return (!!agent.role && /队长|领队|captain|leader/i.test(agent.role)) || (agent.subordinates?.length ?? 0) > 0
}

export function captains(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter(isCaptain)
}
