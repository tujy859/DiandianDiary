import { addDays } from './date';
export interface FlowStep { id: string; title: string; kind: 'record' | 'query' | 'topic'; text: string; date?: string; recordIndex?: number }
/** 合成样例；CI、端侧运行器可共用，不包含任何用户数据。 */
export function diaryFlowSteps(referenceDate: string): FlowStep[] {
  return [
    { id: 'adoption', title: '记录领养并确认保存', kind: 'record', text: '2025年1月1号领养了点点', date: '2025-01-01' },
    { id: 'deworming', title: '记录驱虫并确认保存', kind: 'record', text: '2026年6月1号驱虫了', date: '2026-06-01' },
    { id: 'play', title: '记录昨天玩耍并确认保存', kind: 'record', text: '昨天和猫玩了', date: addDays(referenceDate, -1) },
    { id: 'current-adoption', title: '当前话题查询领养', kind: 'query', text: '我什么时候领养的点点', recordIndex: 0 },
    { id: 'current-deworming', title: '当前话题查询驱虫', kind: 'query', text: '上次驱虫是什么时候', recordIndex: 1 },
    { id: 'new-topic', title: '新建话题并重新读取云端', kind: 'topic', text: '' },
    { id: 'new-adoption', title: '新话题查询领养', kind: 'query', text: '我什么时候领养的点点', recordIndex: 0 },
    { id: 'new-deworming', title: '新话题查询驱虫', kind: 'query', text: '上次驱虫是什么时候', recordIndex: 1 },
  ];
}
