import { getCloudSession, uid } from './store';
import { callCloud } from './cloud';
import { Family, selectFamily } from './repository';
import { isDeveloperMode } from './developer';
import { reconcileFamilyState } from './family-state';

export interface NewUserTestState {
  originalFamilyId: string;
  originalFamilyName: string;
  testFamilyId?: string;
  testFamilyName?: string;
  pendingClientId?: string;
  pendingFamilyName?: string;
}

function stateKey(userId: string) { return `jd_new_user_test_${userId}`; }
export function getNewUserTestState(): NewUserTestState | null {
  const session = getCloudSession();
  return session ? wx.getStorageSync(stateKey(session.userId)) || null : null;
}
export function isTestFamily(): boolean {
  const session = getCloudSession();
  const state = getNewUserTestState();
  return !!(session && state?.testFamilyId === session.familyId);
}
function developerSession() {
  if (!isDeveloperMode()) throw new Error('请先在「我的」开启开发者模式');
  const session = getCloudSession();
  if (!session) throw new Error('请先连接云端');
  if (!session.familyId) throw new Error('请先创建或加入一个家庭空间');
  return session;
}
function assertSession(userId: string, familyId: string) {
  const session = getCloudSession();
  if (session?.userId !== userId || session.familyId !== familyId) throw new Error('账号或家庭已切换，请重新进入测试页');
}

/** 创建失败 / 响应丢失时复用请求 ID，切换失败时保留返回信息。 */
export async function enterEmptyTestFamily(): Promise<void> {
  const session = developerSession();
  const families = await callCloud<Family[]>('family.list');
  assertSession(session.userId, session.familyId);
  reconcileFamilyState(session.userId, families.map((family) => family.id));
  const current = families.find((family) => family.id === session.familyId);
  if (!current) throw new Error('当前家庭不可用，请重新连接云端');
  let state = getNewUserTestState();
  // 一次测试流程只记最初的原家庭，多次新建测试家庭不能覆盖返回目标。
  if (!state || !state.originalFamilyId) state = { ...state, originalFamilyId: current.id, originalFamilyName: current.name };
  else if (current.id !== state.testFamilyId && !state.pendingClientId) {
    state = { ...state, originalFamilyId: current.id, originalFamilyName: current.name };
  }
  // 在检查空家庭和切换之前保存本次返回目标。
  wx.setStorageSync(stateKey(session.userId), state);
  if (state.testFamilyId && !state.pendingClientId) {
    const previousTest = families.find((family) => family.id === state!.testFamilyId);
    if (previousTest && previousTest.members.length === 1) {
      const pets = await callCloud<{ items: unknown[] }>('pet.list', { familyId: previousTest.id, limit: 1 });
      assertSession(session.userId, session.familyId);
      if (!pets.items.length) {
        await selectFamily(previousTest.id);
        return;
      }
    }
  }
  // 请求可能已在服务端成功；有待确认请求时必须允许幂等重试，即使已达上限。
  if (!state.pendingClientId && families.length >= 10) throw new Error('最多加入 10 个家庭。可先返回原家庭；已有测试数据不会自动删除。');
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
  state = {
    ...state,
    pendingClientId: state.pendingClientId || `new-user-${uid()}`,
    pendingFamilyName: state.pendingFamilyName || `新手测试 ${now.getMonth() + 1}/${now.getDate()} ${time}`,
  };
  wx.setStorageSync(stateKey(session.userId), state);
  let family: Family;
  try {
    family = await callCloud<Family>('family.create', { name: state.pendingFamilyName, clientId: state.pendingClientId });
  } catch (err: any) {
    assertSession(session.userId, session.familyId);
    if (err.code === 'FORBIDDEN') {
      wx.setStorageSync(stateKey(session.userId), { ...state, pendingClientId: '', pendingFamilyName: '' });
    }
    throw err;
  }
  assertSession(session.userId, session.familyId);
  state = { ...state, pendingClientId: '', pendingFamilyName: '', testFamilyId: family.id, testFamilyName: family.name };
  // 先保存返回目标：即使刷新新家庭失败 / 小程序关闭，也能恢复操作。
  wx.setStorageSync(stateKey(session.userId), state);
  await selectFamily(family.id);
}

export async function returnToOriginalFamily(): Promise<void> {
  const session = developerSession();
  const state = getNewUserTestState();
  if (!state) throw new Error('没有待返回的原家庭');
  const families = await callCloud<Family[]>('family.list');
  assertSession(session.userId, session.familyId);
  reconcileFamilyState(session.userId, families.map((family) => family.id));
  if (!families.some((family) => family.id === state.originalFamilyId)) throw new Error('原家庭已不可访问，请在「账号与家庭空间」选择可用家庭');
  await selectFamily(state.originalFamilyId);
  // 保留最近测试家庭的标识，下次仍为空时复用；不删除测试数据。
}
