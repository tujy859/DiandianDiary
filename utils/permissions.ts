/** 页面能力仅改善体验；服务端仍对每次写入重新鉴权。 */
import { callCloud, CloudError } from './cloud';
import { getCloudSession, getCloudSessionEpoch, DiaryRecord } from './store';

export type FamilyRole = 'owner' | 'member' | '';

export async function readFamilyRole(): Promise<FamilyRole> {
  const session = getCloudSession(), epoch = getCloudSessionEpoch();
  if (!session?.familyId) return '';
  const families = await callCloud<Array<{ id: string; members: Array<{ userId: string; role: FamilyRole }> }>>('family.list');
  if (epoch !== getCloudSessionEpoch()) throw new CloudError('SESSION_CHANGED', '家庭空间已变化');
  return families.find(f => f.id === session.familyId)?.members?.find(m => m.userId === session.userId)?.role || '';
}

export function canEditDiary(record: DiaryRecord | null, role: FamilyRole): boolean {
  const session = getCloudSession();
  return !!record && !!session && !!role && record.familyId === session.familyId
    && (role === 'owner' || record.createdBy === session.userId);
}
