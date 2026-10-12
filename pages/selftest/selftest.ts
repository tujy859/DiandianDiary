/** 开发自检：在真实运行环境里验证确定性逻辑与数据层，不依赖网络 */
import {
  getPets, savePet, removePet, getRecords, addRecord, updateRecord, removeRecord,
  getMessages, saveMessages, uid, Pet,
} from '../../utils/store';
import { respond } from '../../utils/intent';
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

    /* ---------- 2. 意图区分 ---------- */
    const pet = { id: 'fake', name: '咪咪' };
    const hasDraft = (outs: any[]) => outs.some((o) => o.kind === 'draft');
    const kinds = (outs: any[]) => outs.map((o) => o.kind).join('/');

    const fact = respond({ text: '今天给咪咪洗澡了，洗完一直躲在床底', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 已发生的事实 → 出待保存卡', hasDraft(fact), kinds(fact));
    const factDraft: any = fact.find((o) => o.kind === 'draft');
    check('意图 · 事实卡片日期为今天且含「洗澡」标签',
      !!factDraft && factDraft.draft.date === t && factDraft.draft.tags.indexOf('洗澡') >= 0,
      JSON.stringify(factDraft && factDraft.draft));

    const consult = respond({ text: '今天该洗澡吗？', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 咨询 → 不出卡', !hasDraft(consult), kinds(consult));

    const plan = respond({ text: '明天想给它洗澡', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 计划 → 不出卡', !hasDraft(plan), kinds(plan));

    const neg = respond({ text: '今天没有洗澡', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 否定 → 不出卡', !hasDraft(neg), kinds(neg));

    const query = respond({ text: '上次什么时候洗澡？', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 查询 → 不出卡，只给答案或说明', !hasDraft(query), kinds(query));

    const chat = respond({ text: '咪咪今天好萌', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 感叹 → 不出卡但保留手动入口',
      !hasDraft(chat) && chat.some((o) => o.action === 'draft-from'), kinds(chat));

    const photoOnly = respond({ text: '', photos: ['tmp://a.jpg'], petId: pet.id, petName: pet.name });
    const photoDraft: any = photoOnly.find((o) => o.kind === 'draft');
    check('意图 · 只发照片 → 照片日记且日期待确认',
      !!photoDraft && photoDraft.draft.tags.indexOf('照片') >= 0 && photoDraft.draft.date === null,
      JSON.stringify(photoDraft && photoDraft.draft));

    const mixed = respond({ text: '今天给咪咪洗澡了，上次是什么时候洗的？', photos: [], petId: pet.id, petName: pet.name });
    check('意图 · 事实+问题 → 分别处理（卡 + 查询）',
      hasDraft(mixed) && mixed.some((o) => o.kind === 'query' || o.kind === 'text'),
      kinds(mixed));

    /* ---------- 3. 数据层 CRUD 与查询确定性 ---------- */
    const testPet: Pet = savePet({ name: '__selftest__', species: '其他' });
    try {
      const r1 = addRecord({ petId: testPet.id, date: addDays(t, -10), text: '第一次洗澡', tags: ['洗澡'], photos: [] });
      const r2 = addRecord({ petId: testPet.id, date: addDays(t, -3), text: '第二次洗澡', tags: ['洗澡'], photos: [] });
      const list = getRecords(testPet.id);
      check('数据 · 按日期倒序', list[0].id === r2.id && list[1].id === r1.id, list.map((r) => r.date).join(','));

      const q = respond({ text: '上次什么时候洗澡？', photos: [], petId: testPet.id, petName: testPet.name });
      const qText = (q[0] && q[0].text) || '';
      check('查询 · 命中真实记录并给出天数', qText.indexOf('3天前') >= 0 && !!q[0].refs, qText.replace(/\n/g, ' '));

      const qCount = respond({ text: '洗了几次澡？', photos: [], petId: testPet.id, petName: testPet.name });
      check('查询 · 次数为确定性统计', ((qCount[0] && qCount[0].text) || '').indexOf('2 条') >= 0, ((qCount[0] && qCount[0].text) || '').replace(/\n/g, ' '));

      updateRecord(r1.id, { text: '第一次洗澡（已改）' });
      check('数据 · 编辑生效', (getRecords(testPet.id).find((r) => r.id === r1.id) || ({} as any)).text === '第一次洗澡（已改）', '');

      const qAfterEdit = respond({ text: '上次什么时候洗澡？', photos: [], petId: testPet.id, petName: testPet.name });
      check('查询 · 反映编辑后的记录', !!qAfterEdit[0] && !!qAfterEdit[0].refs, '');

      removeRecord(r2.id);
      const qAfterDel = respond({ text: '上次什么时候洗澡？', photos: [], petId: testPet.id, petName: testPet.name });
      check('查询 · 删除后反映变化', ((qAfterDel[0] && qAfterDel[0].text) || '').indexOf('10天前') >= 0, (qAfterDel[0] && qAfterDel[0].text) || '');

      const qNone = respond({ text: '上次什么时候驱虫？', photos: [], petId: testPet.id, petName: testPet.name });
      check('查询 · 无记录时明确说没有', ((qNone[0] && qNone[0].text) || '').indexOf('没有找到') >= 0, (qNone[0] && qNone[0].text) || '');
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
