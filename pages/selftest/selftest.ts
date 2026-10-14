/** 开发自检：在真实运行环境里验证确定性逻辑与数据层，不依赖网络 */
import {
  getPets, savePet, removePet, getRecords, addRecord, updateRecord, removeRecord,
  getMessages, saveMessages, uid, Pet, ChatMessage,
} from '../../utils/store';
import { sourceForDraft, extractTags } from '../../utils/intent';
import { validateDraft } from '../../utils/draft';
import { queryRecords, resolveQueryOptions } from '../../utils/query';
import { buildHistory, currentSessionMessages, unclaimedPhotos } from '../../utils/context';
import { today, addDays, diffDays, parseDateWords, relDay } from '../../utils/date';

interface Case {
  name: string;
  pass: boolean;
  detail: string;
}

Page({
  data: {
    results: [] as Case[],
    passed: 0,
    failed: 0,
    running: false,
    lastRunAt: '',
  },

  onLoad() {
    this.run();
  },

  onRerun() {
    // 先清空并给出「运行中」反馈，避免看起来像没反应
    this.setData({ results: [], passed: 0, failed: 0, running: true });
    wx.showLoading({ title: '运行中…', mask: true });
    setTimeout(() => {
      this.run();
      wx.hideLoading();
    }, 120);
  },

  run() {
    const results: Case[] = [];
    const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

    /* ---------- 1. 日期：确定性，不猜模糊时间 ---------- */
    const t = today();
    check('日期 · 今天', parseDateWords('今天给咪咪洗澡了') === t, t);
    check('日期 · 昨天', parseDateWords('昨天洗的澡') === addDays(t, -1), String(parseDateWords('昨天洗的澡')));
    check('日期 · 前天', parseDateWords('前天洗的澡') === addDays(t, -2), String(parseDateWords('前天洗的澡')));
    check('日期 · 10月5日', /^\d{4}-10-05$/.test(String(parseDateWords('10月5日洗的'))), String(parseDateWords('10月5日洗的')));
    check(
      '日期 · 「上周左右」不猜精确日期',
      parseDateWords('上周左右洗的澡') === null,
      String(parseDateWords('上周左右洗的澡')),
    );
    check('日期 · 天数差计算', diffDays(addDays(t, -6), t) === 6, String(diffDays(addDays(t, -6), t)));
    check('日期 · 相对描述', relDay(t) === '今天' && relDay(addDays(t, -1)) === '昨天', relDay(addDays(t, -3)));

    /* ---------- 2. 事实分句与标签（确定性，不依赖模型） ---------- */
    const pet = { id: 'fake', name: '咪咪' };

    const factSource = sourceForDraft('今天给咪咪洗澡了，洗完一直躲在床底') || '';
    check('事实 · 已发生的陈述能取出事实分句', factSource.indexOf('洗澡') >= 0, factSource);
    check('事实 · 咨询不是事实', sourceForDraft('今天该洗澡吗？') === null, String(sourceForDraft('今天该洗澡吗？')));
    check('事实 · 计划不是事实', sourceForDraft('明天想给它洗澡') === null, String(sourceForDraft('明天想给它洗澡')));
    check('事实 · 否定不是事实', sourceForDraft('今天没有洗澡') === null, String(sourceForDraft('今天没有洗澡')));
    check('事实 · 查询不是事实', sourceForDraft('上次什么时候洗澡？') === null, String(sourceForDraft('上次什么时候洗澡？')));
    const mixedSource = sourceForDraft('今天给咪咪洗澡了，上次是什么时候洗的？') || '';
    check('事实 · 事实+问题只留事实', mixedSource.indexOf('洗澡') >= 0 && mixedSource.indexOf('上次') < 0, mixedSource);
    check('标签 · 按词表抽取', extractTags('今天给咪咪洗澡了').indexOf('洗澡') >= 0, extractTags('今天给咪咪洗澡了').join());

    /* ---------- 2.5 草稿校验：事实只能来自当前会话内的用户原话 ---------- */
    const throws = (work: () => unknown) => {
      try { work(); return false; } catch (e) { return true; }
    };
    // 是否值得记录由模型判断；校验器只保证日期来自用户原话、正文可用模型整理的结果
    const tidyDraft = validateDraft({ text: '给咪咪洗了澡，洗完躲进床底', tags: [] },
      { text: '昨天给咪咪洗澡了，洗完躲床底了', petId: pet.id, photos: [] }, t);
    check('校验 · 正文用模型整理的说法、日期只从用户原话取',
      tidyDraft.date === addDays(t, -1) && tidyDraft.text === '给咪咪洗了澡，洗完躲进床底', JSON.stringify(tidyDraft));
    check('校验 · 正文为空时拒绝出卡',
      throws(() => validateDraft({ text: '   ', tags: [] }, { text: '记一下', petId: pet.id, photos: [] }, t)), '');
    check('校验 · 未来的日期不能记成已发生事实',
      throws(() => validateDraft({ text: '给咪咪洗澡了', tags: [] }, { text: `${addDays(t, 1)} 给咪咪洗澡了`, petId: pet.id, photos: [] }, t)), '');

    /* ---------- 2.6 话题会话与上下文管理 ---------- */
    const sessionMsgs: ChatMessage[] = [
      { id: 's1', role: 'user', kind: 'text', text: '旧话题内容', time: 1 },
      { id: 's2', role: 'ai', kind: 'divider', text: '新话题开始', time: 2 },
      { id: 's3', role: 'user', kind: 'text', text: '新话题内容', time: 3 },
    ];
    check('会话 · 分隔条之后才是当前上下文',
      currentSessionMessages(sessionMsgs).length === 1 && buildHistory(sessionMsgs)[0].content === '新话题内容',
      JSON.stringify(buildHistory(sessionMsgs)));
    check('会话 · 无分隔条时整段历史为同一会话（兼容旧数据）',
      currentSessionMessages([sessionMsgs[0], sessionMsgs[2]]).length === 2, '');

    const photoMsgs: ChatMessage[] = [
      { id: 'p1', role: 'user', kind: 'text', text: '看这张', photos: ['u/p1.jpg'], time: 1 },
    ];
    check('照片 · 未被草稿使用时进入待认领池', unclaimedPhotos(photoMsgs).join() === 'u/p1.jpg', unclaimedPhotos(photoMsgs).join());
    const claimedMsgs = photoMsgs.concat([{
      id: 'p2', role: 'ai', kind: 'draft', time: 2,
      draft: { key: 'p2', petId: 'x', date: null, text: 't', tags: [], photos: ['u/p1.jpg'], status: 'pending' },
    } as ChatMessage]);
    check('照片 · 待确认草稿已认领则不重复贴图', unclaimedPhotos(claimedMsgs).length === 0, unclaimedPhotos(claimedMsgs).join());
    claimedMsgs[1].draft!.status = 'discarded';
    check('照片 · 草稿丢弃后照片释放回池', unclaimedPhotos(claimedMsgs).length === 1, unclaimedPhotos(claimedMsgs).join());
    const divider: ChatMessage = { id: 'd1', role: 'ai', kind: 'divider', text: '新话题开始', time: 2 };
    check('照片 · 分隔条之前的照片不进新会话的池',
      unclaimedPhotos([photoMsgs[0], divider, { id: 'p4', role: 'user', kind: 'text', text: '新话题', time: 3 }]).length === 0, '');

    /* ---------- 3. 数据层 CRUD 与查询确定性 ---------- */
    const testPet: Pet = savePet({ name: '__selftest__', species: '其他' });
    try {
      const r1 = addRecord({ petId: testPet.id, date: addDays(t, -10), text: '第一次洗澡', tags: ['洗澡'], photos: [] });
      const r2 = addRecord({ petId: testPet.id, date: addDays(t, -3), text: '第二次洗澡', tags: ['洗澡'], photos: [] });
      const list = getRecords(testPet.id);
      check('数据 · 按日期倒序', list[0].id === r2.id && list[1].id === r1.id, list.map((r) => r.date).join(','));

      const ask = (text: string) => queryRecords({ ...resolveQueryOptions(text), petId: testPet.id });

      const q = ask('上次什么时候洗澡？');
      check('查询 · 命中真实记录并给出天数', q.summary.indexOf('3天前') >= 0 && !!q.refs.length, q.summary.replace(/\n/g, ' '));

      check('查询 · 次数为确定性统计', ask('洗了几次澡？').summary.indexOf('2 条') >= 0, ask('洗了几次澡？').summary.replace(/\n/g, ' '));

      updateRecord(r1.id, { text: '第一次洗澡（已改）' });
      check('数据 · 编辑生效', (getRecords(testPet.id).find((r) => r.id === r1.id) || ({} as any)).text === '第一次洗澡（已改）', '');
      check('查询 · 反映编辑后的记录', ask('上次什么时候洗澡？').refs.length > 0, '');

      removeRecord(r2.id);
      const qAfterDel = ask('上次什么时候洗澡？');
      check('查询 · 删除后反映变化', qAfterDel.summary.indexOf('10天前') >= 0, qAfterDel.summary);

      const qNone = ask('上次什么时候驱虫？');
      check('查询 · 无记录时明确说没有', qNone.summary.indexOf('没有找到') >= 0, qNone.summary);
    } finally {
      removePet(testPet.id);
    }
    check('数据 · 删除宠物后其记录一并清除', getRecords(testPet.id).length === 0, String(getRecords(testPet.id).length));

    /* ---------- 4. 消息按宠物隔离 ---------- */
    const pa = savePet({ name: '__msg_a__', species: '猫' });
    const pb = savePet({ name: '__msg_b__', species: '猫' });
    try {
      const msgId = uid();
      saveMessages(pa.id, [{ id: msgId, role: 'user', kind: 'text', text: 'A 的消息', time: Date.now() }]);
      check('消息 · 按宠物隔离', getMessages(pa.id).length === 1 && getMessages(pb.id).length === 0,
        `A:${getMessages(pa.id).length} B:${getMessages(pb.id).length}`);
    } finally {
      removePet(pa.id);
      removePet(pb.id);
      wx.removeStorageSync(`jd_messages_${pa.id}`);
      wx.removeStorageSync(`jd_messages_${pb.id}`);
    }

    const passed = results.filter((r) => r.pass).length;
    const d = new Date();
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    this.setData({
      results,
      passed,
      failed: results.length - passed,
      running: false,
      lastRunAt: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    });
  },
});
