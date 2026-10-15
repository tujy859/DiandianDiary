import { ChatMessage, getCloudSession, getCloudSessionEpoch, getCurrentPet, getModelConfig, getRecords, getPets, setCurrentPet, uid } from './store';
import { isDeveloperMode } from './developer';
import { isModelReady } from './llm';
import { enterReusableTestFamily, isTestFamily } from './new-user-test';
import { Family, savePet, refreshCloudIfStale, removeRecord, removePet } from './repository';
import { callCloud } from './cloud';
import { today } from './date';
import { setTraceEnabled } from './debug-trace';
import { diaryFlowSteps } from './flow-scenarios';

export interface FlowRun {
  id: string; userId: string; familyId: string; petId: string; epoch: number;
  status: string; next: number; error: string; startedAt: number; petRequested: boolean; topicId?: string;
  records: Array<{ id: string; date: string }>;
  results: Array<{ id: string; title: string; pass: boolean; detail: string }>;
}
/** 适配器只连接正式页面动作；运行器不另写模型、草稿或保存实现。 */
export interface FlowPage {
  petId(): string; visible(): boolean; messages(): ChatMessage[]; topicId(): string;
  send(text: string): Promise<ChatMessage[]>; save(key: string): Promise<void>;
  newTopic(): void; cancel(): void; update(): void;
}
const runKey = (userId: string) => `jd_flow_test_${userId}`;
let active: { id: string; cancelled: boolean; cancel: () => void } | null = null;
let preparing = false;
let cleaning = false;
export function getFlowRun(): FlowRun | null {
  const s = getCloudSession(); if (!isDeveloperMode() || !s) return null;
  const run = wx.getStorageSync(runKey(s.userId));
  return run && run.userId === s.userId && Array.isArray(run.results) && Array.isArray(run.records) ? JSON.parse(JSON.stringify(run)) : null;
}
function write(run: FlowRun) {
  if (getCloudSession()?.userId === run.userId) wx.setStorageSync(runKey(run.userId), run);
}
function assertScope(run: FlowRun, page?: FlowPage) {
  const s = getCloudSession();
  if (!isDeveloperMode() || !s || s.userId !== run.userId || s.familyId !== run.familyId
    || getCloudSessionEpoch() !== run.epoch || !isTestFamily()) throw new Error('账号或测试家庭已变化，本轮已停止');
  if (active?.cancelled || (page && (!page.visible() || page.petId() !== run.petId || getCurrentPet()?.id !== run.petId))) throw new Error('测试已停止或宠物已切换');
}
async function soleOwner(run: FlowRun, page?: FlowPage) {
  assertScope(run, page);
  const families = await callCloud<Family[]>('family.list');
  assertScope(run, page);
  const f = families.find(f => f.id === run.familyId);
  if (!f || f.members.length !== 1 || f.members[0].userId !== run.userId || f.members[0].role !== 'owner') throw new Error('测试家庭须仅包含你，且你是创建者');
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function prepareFlowRun(alive: () => boolean = () => true): Promise<FlowRun> {
  if (preparing || active || cleaning) throw new Error('已有测试操作进行中');
  if (!isDeveloperMode() || !isModelReady(getModelConfig())) throw new Error('请开启开发者模式并配置模型');
  const s = getCloudSession(); if (!s?.familyId) throw new Error('请先连接云端并加入家庭');
  const previous = getFlowRun();
  if (previous && !['prepare_failed', 'preparing'].includes(previous.status)) throw new Error('请先查看或清理上一轮测试');
  const run: FlowRun = previous || { id: `flow-${uid()}`, userId: s.userId, familyId: '', petId: '', epoch: 0,
    status: 'preparing', next: 0, error: '', startedAt: Date.now(), petRequested: false, records: [], results: [] };
  const initialEpoch = getCloudSessionEpoch();
  preparing = true; run.status = 'preparing'; run.error = ''; write(run);
  try {
    if (run.familyId) { run.epoch = initialEpoch; assertScope(run); }
    else {
      if (!alive()) throw new Error('准备已取消');
      await enterReusableTestFamily(alive);
      const current = getCloudSession();
      check(current?.userId === run.userId && isTestFamily(), '测试家庭切换失败');
      run.familyId = current.familyId; run.epoch = getCloudSessionEpoch(); write(run);
    }
    if (!alive()) throw new Error('准备已取消');
    await soleOwner(run);
    if (!alive()) throw new Error('准备已取消');
    run.petRequested = true; write(run);
    const pet = await savePet({ name: '点点（流程测试）', species: '猫', clientId: run.id });
    assertScope(run); run.petId = pet.id; write(run);
    if (!alive()) throw new Error('准备已取消');
    setCurrentPet(pet.id); setTraceEnabled(true);
    run.status = 'ready'; write(run); return run;
  } catch (error: any) {
    run.status = 'prepare_failed'; run.error = error.message || '准备失败';
    // 登出或重登后不能恢复旧运行信息。
    if (getCloudSession()?.userId === run.userId && (!run.familyId ? initialEpoch === getCloudSessionEpoch() : run.epoch === getCloudSessionEpoch())) write(run);
    throw error;
  } finally { preparing = false; }
}
export function recoverFlowRun(): FlowRun | null {
  const run = getFlowRun();
  if (run && ['running', 'cleaning'].includes(run.status) && !active && !cleaning) {
    run.status = 'interrupted'; run.error = '上次运行已中断，保留现场，请查看日志或清理'; write(run);
  }
  return run;
}
export async function openFlowRun(alive: () => boolean = () => true): Promise<void> {
  if (active || preparing || cleaning) throw new Error('已有测试操作进行中');
  const run = recoverFlowRun(); if (!run?.petId) throw new Error('没有可打开的测试');
  await enterReusableTestFamily(alive);
  check(alive() && getFlowRun()?.id === run.id && getCloudSession()?.familyId === run.familyId, '本轮测试家庭已失效或页面已关闭');
  run.epoch = getCloudSessionEpoch(); await soleOwner(run);
  check(alive(), '打开已停止'); check(getPets().some(p => p.id === run.petId), '本轮测试宠物已不可用，请清理运行记录'); setCurrentPet(run.petId); write(run);
}
export function cancelFlowRun(): void {
  if (active) { active.cancelled = true; active.cancel(); }
}

export async function executeFlow(page: FlowPage, all = false): Promise<void> {
  if (active || preparing || cleaning) return;
  const run = getFlowRun();
  if (!run || !['ready', 'paused'].includes(run.status)) return;
  assertScope(run, page);
  active = { id: run.id, cancelled: false, cancel: () => page.cancel() };
  run.status = 'running'; write(run); page.update();
  try {
    do {
      const step = diaryFlowSteps(today())[run.next];
      check(step, '测试步骤不存在');
      await soleOwner(run, page);
      if (run.topicId) check(page.topicId() === run.topicId, '话题已变化，请保留现场后重新测试');
      if (step.kind === 'topic') {
        const old = page.topicId(); page.newTopic();
        check(page.topicId() !== old && !page.messages().some(m => m.role === 'user'), '新话题未隔离旧消息');
        await refreshCloudIfStale(0); assertScope(run, page);
        for (const expected of run.records) check(getRecords(run.petId).some(r => r.id === expected.id && r.date === expected.date), '云端重读缺少已保存记录');
      } else {
        const before = getRecords(run.petId).length;
        const messages = await page.send(step.text); assertScope(run, page);
        check(!messages.some(m => m.retry), '模型请求失败，请查看执行日志');
        const drafts = messages.filter(m => m.draft), refs = messages.flatMap(m => m.refs || []);
        if (step.kind === 'record') {
          check(drafts.length === 1, '应只生成一张草稿');
          const draft = drafts[0].draft!;
          check(draft.date === step.date, `日期不符，预期 ${step.date}，实际 ${draft.date || '未识别'}`);
          check(draft.rawInput?.text === step.text, '原始输入未保留');
          check(refs.length === 0 && !messages.some(m => m.role === 'ai' && m.kind !== 'draft'), '单纯记录不应展示额外回复或引用');
          check(getRecords(run.petId).length === before, '确认前不应写入日记');
          assertScope(run, page); await page.save(draft.key);
          const saved = page.messages().find(m => m.draft?.key === draft.key)?.draft;
          // 已发出的保存不能撤销；即使此时停止，也记录已确认回包的 ID，供精确清理。
          const actual = getCloudSessionEpoch() === run.epoch && saved?.recordId
            ? getRecords(run.petId).find(r => r.id === saved.recordId) : undefined;
          if (actual && !run.records.some(r => r.id === actual.id)) {
            run.records.push({ id: actual.id, date: actual.date }); write(run);
          }
          assertScope(run, page);
          check(saved?.status === 'saved' && saved.recordId, '确认保存失败');
          const rows = getRecords(run.petId);
          check(rows.length === before + 1 && rows.some(r => r.id === saved.recordId && r.date === step.date), '保存数量或日期不符');
        } else {
          const expected = run.records[step.recordIndex!];
          check(expected && drafts.length === 0, '查询不应生成草稿');
          check(refs.length === 1 && refs[0].recordId === expected.id, '查询引用包含无关记录或缺少目标记录');
          check(messages.some(m => m.text?.includes(expected.date)), '回复没有正确的事件日期');
          check(getRecords(run.petId).length === before, '查询不应新增日记');
        }
      }
      assertScope(run, page);
      run.topicId = page.topicId();
      run.results.push({ id: step.id, title: step.title, pass: true, detail: '日期、保存状态与可见结果符合预期' });
      run.next++; write(run); page.update();
    } while (all && run.next < diaryFlowSteps(today()).length);
    run.status = run.next === diaryFlowSteps(today()).length ? 'complete' : 'paused';
  } catch (error: any) {
    run.status = active?.cancelled ? 'cancelled' : 'failed'; run.error = error.message || '测试失败';
    const step = diaryFlowSteps(today())[run.next];
    run.results.push({ id: step?.id || 'scope', title: step?.title || '测试作用域', pass: false, detail: run.error });
  } finally {
    // 页面退出 / 身份变化后只停止，不恢复旧家庭或业务数据。
    if (getCloudSessionEpoch() === run.epoch) write(run);
    active = null; page.update();
  }
}

export async function cleanupFlowRun(alive: () => boolean = () => true): Promise<void> {
  if (active || preparing || cleaning) throw new Error('请先停止运行');
  check(alive(), '清理已取消');
  const run = getFlowRun(); if (!run) return;
  cleaning = true;
  try {
    if (!run.petId) {
      if (run.petRequested) throw new Error('宠物创建结果待确认，请先继续准备以复用同一请求');
      wx.removeStorageSync(runKey(run.userId)); return;
    }
    run.epoch = getCloudSessionEpoch(); await soleOwner(run);
    check(alive(), '清理已取消'); run.status = 'cleaning'; write(run);
    await refreshCloudIfStale(0); assertScope(run);
    // 仅清理本轮已确认创建的 ID，不清空家庭；其他记录存在时保留宠物。
    for (const row of run.records) {
      const actual = getRecords(run.petId).find(r => r.id === row.id);
      if (actual) { check(alive(), '清理已取消'); assertScope(run); await removeRecord(row.id); assertScope(run); }
    }
    if (getRecords(run.petId).length) throw new Error('已清理本轮已知记录；宠物下还有其他记录，已保留现场');
    check(alive(), '清理已取消'); assertScope(run);
    if (getPets().some(p => p.id === run.petId)) { await removePet(run.petId); assertScope(run); }
    wx.removeStorageSync(runKey(run.userId));
  } catch (error: any) { run.status = run.petId ? 'interrupted' : 'prepare_failed'; run.error = error.message || '清理失败'; if (getCloudSessionEpoch() === run.epoch) write(run); throw error; }
  finally { cleaning = false; }
}
