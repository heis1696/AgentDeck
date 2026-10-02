(() => {
  const meetingId = 'meeting_preview_v0';
  const members = [
    { agentId: 'reporter', name: 'ZetCode', platform: 'zcode', role: '报告者', initial: 'Z' },
    { agentId: 'critic', name: 'Claude', platform: 'claude', role: '质疑者', initial: 'C' },
    { agentId: 'designer', name: 'Codex', platform: 'codex', role: '综合者', initial: 'X' }
  ];
  const statusLabels = { pending: '正在准备', speaking: '正在执行', done: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过' };
  const phaseLabels = { report: '陈述', challenge: '质疑', defense: '答复', synthesis: '综合' };
  const baseTime = new Date('2026-10-02T10:20:00+08:00').getTime();
  const fixture = [
    ['reporter', 'report', 'done', '建议保留普通 Issue 的标题区、时间线和底部输入区。\n公开讨论显示实名发言；调查和工具过程留在右侧，不另外生成看板卡片。'],
    ['user', 'report', 'done', '默认固定我选择的成员。另一位开始发言时，不要把我正在看的日志切走。'],
    ['critic', 'challenge', 'failed', ''],
    ['critic', 'challenge', 'done', '质疑：点击一条旧发言时，如果成员已经开始下一次执行，应该展示哪个 Run？\n必须定位这条发言的确切执行，不能用“该成员最新一次”替代。'],
    ['reporter', 'defense', 'done', '同意。公开发言保存自己的执行关联；点击这条答复会定位本次 Run 与回合。\n会议停止也必须等待整场的退出确认，不能因为容器任务取消就显示“已停止”。'],
    ['designer', 'synthesis', 'speaking', ''],
    ['critic', 'synthesis', 'pending', ''],
    ['reporter', 'challenge', 'cancelled', '']
  ].map(([agentId, phase, status, body], index) => {
    const member = members.find((item) => item.agentId === agentId);
    return {
      id: `speech_${index + 1}`, meetingId, sequence: index + 1, version: index + 1, round: index < 5 ? 1 : 2,
      phase, status, agentId, purpose: agentId === 'user' ? 'chair' : 'speech',
      speaker: member ? { name: member.name, role: member.role, platform: member.platform } : { name: '你', role: '主持人', platform: '用户' },
      officeTaskId: member ? `task_${agentId}_session` : '', sessionTaskId: member ? `task_${agentId}_session` : undefined,
      runId: member && status !== 'pending' ? `run_${agentId}_${index + 1}` : undefined,
      executionTurnId: member && status !== 'pending' ? `execution_${index + 1}` : undefined,
      contextVersion: Math.max(0, index - 1), startedAt: baseTime + index * 120000,
      deliveryState: status === 'pending' ? 'prepared' : 'accepted',
      delivery: { publicVersion: Math.max(0, index - 1), sourceTurnIds: index ? ['speech_1'] : [], chairTurnIds: index > 1 ? ['speech_2'] : [] },
      body: status === 'done' ? body : undefined,
      error: status === 'failed' ? '示例：平台连接中断。本次未发布正式发言，下一条是新的执行，不覆盖这条失败记录。' : undefined
    };
  });
  const calls = [];
  let sourceVersion = fixture.length;
  const snapshots = new Map();
  let snapshotId = 0;
  const authority = {
    async readTurns(id, query = {}) {
      if (id !== meetingId) throw new Error('未知预览会议');
      calls.push({ method: 'readTurns', query: { ...query } });
      let snapshot;
      let offset = 0;
      let token;
      if (query.cursor) {
        const [key, position] = query.cursor.split(':');
        token = key;
        snapshot = snapshots.get(key);
        offset = Number(position);
        if (!snapshot) throw new Error('无效预览游标');
      } else {
        token = String(++snapshotId);
        snapshot = { version: sourceVersion, turns: fixture.filter((turn) => query.afterVersion === undefined || turn.version > query.afterVersion).map((turn) => structuredClone(turn)) };
        snapshots.set(token, snapshot);
      }
      const limit = query.limit ?? 3;
      const turns = snapshot.turns.slice(offset, offset + limit);
      const hasMore = offset + limit < snapshot.turns.length;
      if (!hasMore) snapshots.delete(token);
      return { meetingId, turns, latestVersion: snapshot.version, hasMore, nextCursor: hasMore ? `${token}:${offset + limit}` : undefined };
    },
    async getTurn(id, turnId) {
      if (id !== meetingId) throw new Error('未知预览会议');
      calls.push({ method: 'getTurn', turnId });
      const turn = fixture.find((item) => item.id === turnId);
      return turn ? structuredClone(turn) : null;
    },
    async memberExecutions(id, agentId) {
      if (id !== meetingId) throw new Error('未知预览会议');
      calls.push({ method: 'memberExecutions', agentId });
      return { agentId, sessionTaskId: `task_${agentId}_session`, turns: fixture.filter((turn) => turn.agentId === agentId).map(({ body, ...turn }) => structuredClone(turn)), investigations: agentId === 'designer' ? [{ taskId: 'task_designer_investigation', runId: 'run_investigation_1', status: 'running' }] : [] };
    }
  };
  const meeting = { id: meetingId, status: 'active', currentTurn: { agentId: 'designer' }, stopState: undefined };
  const storageKey = `agentdeck:meeting-v0:${meetingId}`;
  let selection;
  try { selection = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); } catch {}
  if (!selection || !members.some((member) => member.agentId === selection.agentId)) selection = { agentId: null, turnId: null, follow: false, open: false };
  const requestedMember = new URLSearchParams(location.search).get('member');
  if (members.some((member) => member.agentId === requestedMember)) selection = { agentId: requestedMember, turnId: new URLSearchParams(location.search).get('turn'), follow: false, open: true };
  const turns = new Map();
  let latestVersion;
  let requestId = 0;
  let advancing = false;
  const byId = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(selection)); } catch {} };
  const notice = (text) => { byId('notice').textContent = text; };
  const currentSpeech = () => [...turns.values()].find((turn) => turn.status === 'speaking' && turn.purpose !== 'chair' && turn.agentId === meeting.currentTurn?.agentId);
  const sortedTurns = () => [...turns.values()].sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0) || first.id.localeCompare(second.id));
  async function refreshTurns(initial = false) {
    const query = initial || latestVersion === undefined ? { limit: 3 } : { afterVersion: latestVersion, limit: 3 };
    let cursor;
    let page;
    const incoming = new Map();
    do {
      page = await authority.readTurns(meetingId, { ...query, ...(cursor ? { cursor } : {}) });
      for (const turn of page.turns) {
        const existing = incoming.get(turn.id) ?? turns.get(turn.id);
        if (!existing || (turn.version ?? 0) >= (existing.version ?? 0)) incoming.set(turn.id, turn);
      }
      cursor = page.nextCursor;
      if (page.hasMore && !cursor) throw new Error('读取游标缺失');
    } while (page.hasMore);
    for (const [id, turn] of incoming) turns.set(id, turn);
    latestVersion = page.latestVersion;
    renderTimeline();
    renderMeeting();
  }
  function renderMeeting() {
    const states = {
      draft: ['pending', '正在准备', '正在建立会议成员会话；尚未开始正式发言。'],
      active: ['speaking', '讨论中', `${members.find((member) => member.agentId === meeting.currentTurn?.agentId)?.name ?? '成员'} 正在公开发言；内部调查不会切换当前发言者。`],
      failed: ['failed', '执行失败', '会议执行失败，不代表进程退出已确认；恢复与清理由宿主核验。'],
      cancelled: ['cancelled', '已停止', '示例：全部会议执行的退出已确认；独立咨询办公室不在本次停止范围。'],
      concluded: ['done', '已完成', '示例：唯一纪要已由三名成员确认，三票绑定同一纪要版本与公共输入版本。']
    };
    const [state, label, message] = meeting.stopState === 'stopping'
      ? ['pending', '正在停止', '已请求停止整场会议，仍在等待成员与调查进程退出确认；尚未停止成功，不可删除。']
      : meeting.stopState === 'failed'
        ? ['failed', '停止受阻', '示例：仍有执行未取得退出证明。保留记录与删除屏障，不能显示“已停止”或允许删除。']
        : states[meeting.status];
    byId('meeting-status').dataset.state = state;
    byId('meeting-status').textContent = label;
    byId('meeting-state').dataset.state = state;
    byId('meeting-state').innerHTML = `<strong>${escape(label)}</strong><span class="muted">${escape(message)}</span>`;
    byId('version').textContent = `发言水位 v${latestVersion ?? 0}`;
    byId('members').innerHTML = members.map((member) => `<button type="button" class="member" data-member="${member.agentId}" aria-pressed="${selection.open && selection.agentId === member.agentId}"><span class="avatar" aria-hidden="true">${member.initial}</span><span class="member-label"><strong>${member.name}</strong><span>${member.role} · ${member.platform}</span></span><span class="member-state ${meeting.status === 'active' && !meeting.stopState && meeting.currentTurn?.agentId === member.agentId ? 'current' : ''}">${meeting.status === 'active' && !meeting.stopState && meeting.currentTurn?.agentId === member.agentId ? '公开发言中' : member.agentId === 'designer' && meeting.status === 'active' && !meeting.stopState ? '内部调查中' : '查看执行'}</span></button>`).join('');
    byId('minutes-state').textContent = meeting.status === 'concluded' ? '同版本确认 3 / 3 · 示例' : '尚未形成';
    byId('minutes-body').textContent = meeting.status === 'concluded' ? '示例决议：固定成员侧栏，按确切发言关联定位执行。纪要 minutes_demo_1，确认公共输入 v7。' : '质疑、答复与成员确认保留在公开时间线；不是仅展示最后一份总结。';
    byId('next-speaker').disabled = meeting.status !== 'active' || !!meeting.stopState || advancing;
    byId('reopen').hidden = !selection.agentId || selection.open;
  }
  function renderTimeline() {
    byId('timeline').setAttribute('aria-busy', 'false');
    byId('turn-count').textContent = `${turns.size} 条记录`;
    byId('timeline').innerHTML = sortedTurns().map((turn) => {
      const speaker = turn.speaker;
      const body = turn.status === 'done' ? turn.body ?? '完整正文缺失，不能用兼容评论代替。' : turn.error ?? (turn.status === 'speaking' ? '正在生成正式发言。内部调查、工具调用和草稿仅在右侧查看。' : turn.status === 'pending' ? '准备公开上下文，尚未投递给成员；正式发言还未开始。' : '本次已取消，没有发布正式发言。');
      const state = statusLabels[turn.status];
      const time = new Date(turn.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
      return `<article class="turn ${selection.open && selection.turnId === turn.id ? 'selected' : ''}" data-turn-id="${escape(turn.id)}" data-status="${escape(turn.status)}"><span class="avatar" aria-hidden="true">${escape(speaker.name.slice(0, 1))}</span><div class="turn-content"><div class="speaker"><strong>${escape(speaker.name)}</strong><span>${escape(speaker.platform)} · ${escape(speaker.role)}</span><span>${turn.purpose === 'chair' ? '用户插话' : `第 ${turn.round} 轮 · ${phaseLabels[turn.phase]}`}</span><time>${time}</time></div><div class="bubble"><div class="body ${turn.id === 'speech_6' && turn.status === 'done' ? 'code' : ''}">${escape(body)}</div><div class="turn-footer"><span class="chip" data-state="${turn.status}">${state}</span>${turn.purpose === 'chair' ? '<span>进入后续公共输入 · 在途请求不改写</span>' : `<span>输入上下文 v${turn.contextVersion}</span><button type="button" data-execution="${escape(turn.id)}" aria-label="查看 ${escape(speaker.name)} 第 ${turn.round} 轮${phaseLabels[turn.phase]}的本次执行">查看本次执行 →</button>`}</div></div></div></article>`;
    }).join('');
  }
  async function renderDock() {
    const token = ++requestId;
    byId('dock').hidden = !selection.open;
    byId('follow').checked = selection.follow;
    byId('mode-label').textContent = selection.follow ? '跟随正式发言' : '固定所选成员';
    if (!selection.open || !selection.agentId) return;
    const member = members.find((item) => item.agentId === selection.agentId);
    byId('dock-person').innerHTML = `<span class="avatar">${member.initial}</span><div><strong>${member.name}</strong><span class="muted small">${member.role} · ${member.platform} · 会议范围会话</span></div>`;
    byId('execution-detail').textContent = '正在读取所选执行…';
    const result = await authority.memberExecutions(meetingId, member.agentId);
    if (token !== requestId) return;
    if (!selection.turnId) selection.turnId = result.turns.find((turn) => turn.status === 'speaking')?.id ?? result.turns[result.turns.length - 1]?.id ?? null;
    byId('execution').innerHTML = result.turns.map((turn) => `<option value="${escape(turn.id)}">第 ${turn.round} 轮 · ${phaseLabels[turn.phase]} · ${statusLabels[turn.status]} · ${escape(turn.runId ?? '尚未建立 Run')}</option>`).join('');
    if (selection.turnId && !result.turns.some((turn) => turn.id === selection.turnId)) byId('execution').insertAdjacentHTML('afterbegin', `<option value="${escape(selection.turnId)}">选定旧发言 · 执行列表中缺失</option>`);
    byId('execution').value = selection.turnId ?? '';
    const turn = selection.turnId ? await authority.getTurn(meetingId, selection.turnId) : null;
    if (token !== requestId) return;
    persist();
    renderTimeline();
    const taskId = turn?.sessionTaskId ?? turn?.officeTaskId;
    const exact = !!(taskId && turn?.runId && turn?.executionTurnId);
    byId('execution-detail').innerHTML = `<dl><dt>发言</dt><dd><code>${escape(turn?.id ?? '暂无发言')}</code></dd><dt>Task</dt><dd><code>${escape(taskId ?? '关联缺失')}</code></dd><dt>Run</dt><dd><code>${escape(turn?.runId ?? '尚未建立 / 关联缺失')}</code></dd><dt>Turn</dt><dd><code>${escape(turn?.executionTurnId ?? '尚未建立 / 关联缺失')}</code></dd></dl><div class="audit"><strong>${exact ? '按所选发言的确切关联读取' : '执行关联尚未完整，不替换为最新一次'}</strong><br>实际输入上下文 v${turn?.delivery?.publicVersion ?? '—'} · ${turn?.deliveryState === 'prepared' ? '尚未投递' : '已投递（示例）'}<br>用户插话来源：${escape(turn?.delivery?.chairTurnIds?.join(', ') || '无')}</div><section class="dock-section"><h2>内部调查 · 与公开发言分开</h2>${result.investigations.length ? result.investigations.map((item) => `<div class="investigation"><span class="chip" data-state="speaking">执行中</span>核对旧发言关联<br><code>${escape(item.taskId)}</code><br><span class="small muted">调查不切换跟随成员</span></div>`).join('') : '<div class="muted small">该成员没有内部调查。</div>'}</section><section class="dock-section"><h2>执行日志 · 示例</h2><pre class="log">${escape(exact ? `[会话] ${taskId}\n[Run] ${turn.runId}\n[Turn] ${turn.executionTurnId}\n[输入] 公共上下文 v${turn.delivery.publicVersion}\n[状态] ${statusLabels[turn.status]}\n${turn.status === 'speaking' ? '[工具] 只读核对执行关联（示例）\n[草稿] 尚未发布，不进入公开时间线' : '[工具] 本次示例无工具事件'}\n只显示本 Run / Turn 的记录` : '尚无可定位的执行日志。\n不会回退到该成员最新 Run。')}</pre></section>`;
  }
  async function selectMember(agentId, turnId = null) {
    selection = { agentId, turnId, follow: false, open: true };
    persist();
    renderMeeting();
    await renderDock();
    notice('侧栏已固定。其他成员开始公开发言时，不会切走这位成员。');
  }
  byId('members').addEventListener('click', (event) => { const button = event.target.closest('[data-member]'); if (button) void selectMember(button.dataset.member); });
  byId('timeline').addEventListener('click', (event) => { const button = event.target.closest('[data-execution]'); const turn = button && turns.get(button.dataset.execution); if (turn) void selectMember(turn.agentId, turn.id); });
  byId('execution').addEventListener('change', () => { selection.turnId = byId('execution').value; selection.follow = false; persist(); void renderDock(); });
  byId('close-dock').addEventListener('click', () => { selection.open = false; ++requestId; persist(); renderMeeting(); renderTimeline(); void renderDock(); });
  byId('reopen').addEventListener('click', () => { selection.open = true; persist(); renderMeeting(); void renderDock(); });
  byId('follow').addEventListener('change', () => {
    selection.follow = byId('follow').checked;
    const current = currentSpeech();
    if (selection.follow && meeting.status === 'active' && !meeting.stopState && current) { selection.agentId = current.agentId; selection.turnId = current.id; }
    persist(); renderMeeting(); void renderDock();
    notice(selection.follow ? '只跟随正式发言者；手动选成员或旧发言会恢复固定模式。' : '已固定当前成员。');
  });
  byId('theme').addEventListener('click', () => { const light = document.documentElement.classList.toggle('light'); byId('theme').textContent = light ? '切换深色' : '切换浅色'; });
  byId('scenario').addEventListener('change', () => {
    const value = byId('scenario').value;
    meeting.status = value === 'stop-failed' ? 'cancelled' : ['stopping', 'empty', 'read-error'].includes(value) ? 'active' : value;
    meeting.stopState = value === 'stopping' ? 'stopping' : value === 'stop-failed' ? 'failed' : undefined;
    renderMeeting(); renderTimeline();
    if (value === 'empty') { byId('timeline').innerHTML = '<div class="audit">还没有公开发言。准备完成后，第一位成员会实名出现在这里。</div>'; byId('turn-count').textContent = '0 条记录'; }
    if (value === 'read-error') { byId('timeline').insertAdjacentHTML('afterbegin', '<div role="alert" class="audit">示例：增量读取失败。保留上次成功的时间线与水位，不降级读取兼容评论。切回“讨论中”恢复预览。</div>'); }
    notice('仅切换状态示意；没有停止、删除、恢复或启动任何真实执行。');
  });
  byId('next-speaker').addEventListener('click', async () => {
    if (advancing || meeting.status !== 'active' || meeting.stopState) return;
    advancing = true; renderMeeting();
    try {
      const current = fixture.find((turn) => turn.status === 'speaking');
      if (current) { current.status = 'done'; current.body = 'const selectedExecution = {\n  taskId: speech.sessionTaskId,\n  runId: speech.runId,\n  turnId: speech.executionTurnId\n};'; current.version = ++sourceVersion; }
      const next = fixture.find((turn) => turn.status === 'pending');
      if (next) { next.status = 'speaking'; next.runId = 'run_critic_7'; next.executionTurnId = 'execution_7'; next.deliveryState = 'accepted'; next.version = ++sourceVersion; meeting.currentTurn = { agentId: next.agentId }; }
      else { const restart = fixture.find((turn) => turn.id === 'speech_6'); restart.status = 'speaking'; restart.body = undefined; restart.version = ++sourceVersion; meeting.currentTurn = { agentId: restart.agentId }; }
      const oldTurn = fixture[0]; oldTurn.version = ++sourceVersion; oldTurn.body = oldTurn.body.replace(/\n\n已补充审计信息.*$/s, '') + '\n\n已补充审计信息：这条旧序号发言的更新同样由版本增量合并。';
      await refreshTurns();
      const currentTurn = currentSpeech();
      if (selection.follow && currentTurn) { selection.agentId = currentTurn.agentId; selection.turnId = currentTurn.id; }
      persist(); await renderDock();
      notice(selection.follow ? '侧栏跟随新的正式发言者；旧发言更新已按稳定 ID 合并。' : '新发言已更新，固定成员未切走；旧发言也收到版本更新。');
    } catch (error) { notice(`增量读取失败，保留旧水位与记录：${error.message}`); }
    finally { advancing = false; renderMeeting(); }
  });
  if (new URLSearchParams(location.search).get('theme') === 'light') { document.documentElement.classList.add('light'); byId('theme').textContent = '切换深色'; }
  const ready = (async () => {
    await refreshTurns(true);
    const current = currentSpeech();
    if (selection.follow && current) { selection.agentId = current.agentId; selection.turnId = current.id; }
    await renderDock();
  })();
  window.meetingV0 = { ready, calls, getState: () => ({ selection: { ...selection }, latestVersion, turnCount: turns.size }) };
  ready.catch((error) => { byId('timeline').setAttribute('aria-busy', 'false'); notice(`预览读取失败：${error.message}`); });
})();
