import ActionSheet from 'tdesign-miniprogram/action-sheet/index';
import Toast from 'tdesign-miniprogram/toast/index';
import {
  getPets, getCurrentPet, setCurrentPet, petEmoji,
  getMessages, saveMessages, persistPhotos, uid,
  getModelConfig, getRecords, getCloudSession,
  Pet, ChatMessage,
} from '../../utils/store';
import { respond, extractTags } from '../../utils/intent';
import { chatWithModel, isModelReady } from '../../utils/llm';
import { runAgent, AbortedError } from '../../utils/agent';
import { today, isValidDate } from '../../utils/date';
import { RequestToken } from '../../utils/cancellation';
import { isHistoryQuery, queryRecords, resolveQueryOptions } from '../../utils/query';
import { validateDraft } from '../../utils/draft';
import { addRecord, refreshCloud } from '../../utils/repository';

Page({
  data: {
    pets: [] as Pet[],
    currentPet: null as Pet | null,
    petAvatar: '',
    messages: [] as ChatMessage[],
    inputValue: '',
    attachments: [] as string[],
    placeholder: '说点什么，比如：今天给咪咪洗澡了',
    focusFlag: false,
    scrollTo: '',
    keyboardHeight: 0,
    aiThinking: false,
    modelOn: false,
    editorVisible: false,
    editorValue: {} as any,
    editorKey: '',
    tabbarHeight: 60,
  },

  _abort: null as RequestToken | null,

  isActive(token: RequestToken, petId: string): boolean {
    return this._abort === token && !token.aborted && this.data.currentPet?.id === petId;
  },

  assertActive(token: RequestToken, petId: string) {
    if (!this.isActive(token, petId)) throw new AbortedError();
  },

  cancelGeneration(notice = false) {
    const token = this._abort;
    if (!token) return;
    token.cancel();
    this._abort = null;
    this.setData({ aiThinking: false });
    wx.hideLoading();
    if (notice) this.appendMessages([this.toMessage({ kind: 'text', text: '已停止生成。' }, false, 'local')]);
  },

  tabbarHeight(): number {
    const app: any = getApp();
    return (app && app.globalData && app.globalData.tabbarHeight) || 60;
  },

  async onShow() {
    if (getCloudSession()) {
      this.setData({ pets: [], currentPet: null, messages: [] });
      try { await refreshCloud(); } catch (err: any) {
        Toast({ context: this, selector: '#t-toast', message: err.message || '云端读取失败，请重新进入页面', theme: 'error' });
        return;
      }
    }
    const pets = getPets();
    const currentPet = getCurrentPet();
    this.setData({
      pets,
      currentPet,
      petAvatar: currentPet ? petEmoji(currentPet.species) : '',
      messages: currentPet ? getMessages(currentPet.id) : [],
      modelOn: isModelReady(getModelConfig()),
      tabbarHeight: this.tabbarHeight(),
    });
    const tabbar = this.getTabBar && this.getTabBar();
    if (tabbar) tabbar.setData({ selected: 1 });
    this.scrollToBottom();
  },

  /* ---------- 键盘 ---------- */

  onHide() {
    this.cancelGeneration(true);
    if (this.data.keyboardHeight) this.setData({ keyboardHeight: 0 });
  },

  onUnload() {
    this.cancelGeneration();
  },

  onKeyboardHeight(e: WechatMiniprogram.CustomEvent) {
    const h = e.detail.height || 0;
    this.setData({ keyboardHeight: h });
    if (h > 0) this.scrollToBottom();
  },

  /* ---------- 发送 ---------- */

  onInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ inputValue: e.detail.value });
  },

  onChoosePhoto() {
    const petId = this.data.currentPet?.id;
    const remain = 9 - this.data.attachments.length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      success: (res) => {
        if (this.data.currentPet?.id !== petId) return;
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ attachments: this.data.attachments.concat(paths) });
      },
    });
  },

  onRemoveAttachment(e: WechatMiniprogram.TouchEvent) {
    const { index } = e.currentTarget.dataset;
    const attachments = this.data.attachments.slice();
    attachments.splice(index, 1);
    this.setData({ attachments });
  },

  async onSend() {
    const originalText = this.data.inputValue;
    const text = originalText.trim();
    const photos = this.data.attachments.slice();
    const pet = this.data.currentPet;
    if (!pet || (!text && !photos.length) || this.data.aiThinking) return;
    const token = new RequestToken();
    const historyMessages = this.data.messages.slice();
    this._abort = token;
    this.setData({ aiThinking: true }); // 照片处理阶段也锁定发送，防止连点重复提交
    try {
      let savedPhotos: string[] = [];
      if (photos.length) {
        wx.showLoading({ title: '处理照片…', mask: true });
        savedPhotos = await persistPhotos(photos);
        this.assertActive(token, pet.id);
        wx.hideLoading();
      }
      this.assertActive(token, pet.id);
      const userMsg: ChatMessage = { id: uid(), role: 'user', kind: 'text', text, sourceText: originalText, photos: savedPhotos, time: Date.now() };
      this.setData({ messages: this.data.messages.concat(userMsg), inputValue: '', attachments: [],
        placeholder: '说点什么，比如：今天给咪咪洗澡了' });
      this.persist();
      if (text && this.data.modelOn) await this.replyByAI(text, savedPhotos, pet, token, historyMessages);
      else this.appendMessages(respond({ text, photos: savedPhotos, petId: pet.id, petName: pet.name })
        .map((o) => this.toMessage(o, true, 'local')));
    } catch (error) {
      if (this.isActive(token, pet.id)) Toast({ context: this, selector: '#t-toast', message: '照片处理失败，请重试', theme: 'error' });
    } finally {
      if (this._abort === token) {
        this._abort = null;
        this.setData({ aiThinking: false });
        wx.hideLoading();
      }
    }
  },

  toMessage(o: any, demo: boolean, mode: 'local' | 'model' | 'tool'): ChatMessage {
    const msg: ChatMessage = {
      id: uid(),
      role: 'ai',
      kind: o.kind,
      text: o.text,
      refs: o.refs,
      action: o.action,
      sourceText: o.sourceText,
      demo,
      mode,
      time: Date.now(),
    };
    if (o.draft) {
      const source = this.data.messages.slice().reverse().find((m: ChatMessage) => m.role === 'user');
      msg.draft = { ...o.draft, key: msg.id, status: 'pending', rawInput: o.draft.rawInput || {
        text: o.sourceText !== undefined ? o.sourceText : source?.sourceText !== undefined ? source.sourceText : source?.text || o.draft.text || '',
        photos: (o.sourcePhotos || source?.photos || o.draft.photos || []).slice(), provenance: 'direct',
      } };
    }
    return msg;
  },

  /** 三级降级共享请求信号、草稿校验和查询服务。 */
  async replyByAI(text: string, savedPhotos: string[], pet: Pet, token = new RequestToken(), historyMessages?: ChatMessage[]) {
    this._abort = token;
    this.setData({ aiThinking: true });
    this.scrollToBottom();
    const referenceDate = today();
    const history = (historyMessages || []).filter((m) => m.kind === 'text' && m.text)
      .slice(-8).map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text! }));
    const cfg = getModelConfig(); // 请求全程使用同一个配置快照
    const source = this.data.messages.slice().reverse().find((m: ChatMessage) => m.role === 'user' && m.text === text);
    const originalText = source?.sourceText !== undefined ? source.sourceText : text;
    try {
      const res = await runAgent(cfg, text, { pet, history, photos: savedPhotos, abortToken: token });
      this.assertActive(token, pet.id);
      const msgs: ChatMessage[] = res.drafts.map((d) => this.toMessage({ kind: 'draft', draft: d, sourceText: originalText, sourcePhotos: savedPhotos }, false, 'tool'));
      if (res.reply || res.refs.length) msgs.push(this.toMessage({ kind: res.refs.length ? 'query' : 'text', text: res.reply || '', refs: res.refs }, false, 'tool'));
      if (!msgs.length) msgs.push(this.toMessage({ kind: 'text', text: '我在呢，继续说～' }, false, 'tool'));
      this.appendMessages(msgs);
    } catch (err: any) {
      if (err instanceof AbortedError || !this.isActive(token, pet.id)) return;
      try {
        const out = await chatWithModel(cfg, text, {
          petName: pet.name, species: pet.species, today: referenceDate, history,
          records: getRecords(pet.id).slice(0, 20).map((r) => ({ date: r.date, text: r.text, tags: r.tags })),
        }, token);
        this.assertActive(token, pet.id);
        const msgs: ChatMessage[] = [];
        if (out.draft) {
          const draft = validateDraft(out.draft, { text, petId: pet.id, photos: savedPhotos }, referenceDate);
          msgs.push(this.toMessage({ kind: 'draft', draft, sourceText: originalText, sourcePhotos: savedPhotos }, false, 'model'));
        }
        const historical = isHistoryQuery(text);
        const querying = !!out.query || historical;
        if (querying) {
          const options = resolveQueryOptions(text, out.query || {}, referenceDate);
          if (!options.eventType && !options.keyword && !/记录|日记/.test(text)) throw new Error('请补充要查询的事件关键词');
          const result = queryRecords({ ...options, petId: pet.id });
          msgs.push(this.toMessage({ kind: 'query', text: result.summary, refs: result.refs }, false, 'model'));
        }
        if (out.draft) msgs.push(this.toMessage({ kind: 'text', text: '已整理为待确认草稿，点击「保存这条」后才会记进时光册。' }, false, 'model'));
        else if (!historical && out.reply) msgs.push(this.toMessage({ kind: 'text', text: out.reply }, false, 'model'));
        if (!msgs.length) msgs.push(this.toMessage({ kind: 'text', text: '我在呢，继续说～' }, false, 'model'));
        this.appendMessages(msgs);
      } catch (error: any) {
        if (error instanceof AbortedError || !this.isActive(token, pet.id)) return;
        const notice = this.toMessage({ kind: 'text', text: `模型调用失败（工具：${err.message || '未知错误'}；JSON：${error.message || '未知错误'}），本次先用本地演示规则应答。` }, true, 'local');
        notice.retry = true;
        notice.sourceText = text;
        notice.sourcePhotos = savedPhotos.slice();
        this.appendMessages([notice].concat(respond({ text, photos: savedPhotos, petId: pet.id, petName: pet.name })
          .map((o) => this.toMessage({ ...o, sourceText: originalText, sourcePhotos: savedPhotos }, true, 'local'))));
      }
    } finally {
      // 旧请求迟到，不能清掉后续新请求的思考状态和取消句柄。
      if (this._abort === token) {
        this._abort = null;
        this.setData({ aiThinking: false });
      }
    }
  },

  onStop() {
    this.cancelGeneration(true);
  },

  /** 重试保留原请求照片，并且不重复向模型发送最后一条用户消息。 */
  onRetry(e: WechatMiniprogram.TouchEvent) {
    const { text, id } = e.currentTarget.dataset;
    const pet = this.data.currentPet;
    if (!pet || !text || this.data.aiThinking) return;
    const idx = id ? this.data.messages.findIndex((m) => m.id === id && m.retry)
      : this.data.messages.map((m) => m.retry && m.sourceText === text).lastIndexOf(true);
    if (idx < 0) return;
    const newestUser = this.data.messages.map((m) => m.role).lastIndexOf('user');
    if (idx < newestUser) {
      Toast({ context: this, selector: '#t-toast', message: '这条之后已有新对话，请重新发送想问的内容' });
      return;
    }
    const notice = this.data.messages[idx];
    const before = this.data.messages.slice(0, idx);
    const lastUser = before.map((m) => m.role).lastIndexOf('user');
    const sourceMessage = lastUser >= 0 ? before[lastUser] : null;
    const photos = notice.sourcePhotos || sourceMessage?.photos || [];
    const historyMessages = sourceMessage?.text === text ? before.slice(0, lastUser) : before;
    // 用新的结果替换本次失败后的演示内容，保留用户原消息。
    this.setData({ messages: before });
    this.persist();
    this.replyByAI(text, photos, pet, new RequestToken(), historyMessages);
  },

  appendMessages(msgs: ChatMessage[]) {
    const messages = this.data.messages.concat(msgs);
    this.setData({ messages });
    this.persist();
    this.scrollToBottom();
  },

  persist() {
    const pet = this.data.currentPet;
    if (pet) saveMessages(pet.id, this.data.messages);
  },

  scrollToBottom() {
    this.setData({ scrollTo: '' });
    setTimeout(() => {
      if (this.data.aiThinking) {
        this.setData({ scrollTo: 'ai-thinking' });
        return;
      }
      const last = this.data.messages[this.data.messages.length - 1];
      if (last) this.setData({ scrollTo: `m-${last.id}` });
    }, 80);
  },

  /* ---------- 待保存卡片 ---------- */

  findDraft(key: string): number {
    return this.data.messages.findIndex((m) => m.draft && m.draft.key === key);
  },

  async onCardSave(e: WechatMiniprogram.CustomEvent) {
    const { key } = e.detail;
    const idx = this.findDraft(key);
    if (idx < 0) return;
    const draft = this.data.messages[idx].draft!;
    const mode = this.data.messages[idx].mode || 'manual';
    if (this._savingDrafts?.[key]) return;
    if (draft.status !== 'pending' && draft.status !== 'failed') return;
    if (!isValidDate(draft.date)) {
      Toast({ context: this, selector: '#t-toast', message: '先点选一下发生日期吧', theme: 'warning' });
      return;
    }
    try {
      this._savingDrafts = { ...this._savingDrafts, [key]: true };
      const scope = JSON.stringify(getCloudSession());
      const currentPetId = this.data.currentPet?.id;
      const savedPhotos = await persistPhotos(draft.photos);
      if (scope !== JSON.stringify(getCloudSession())) throw new Error('家庭空间已切换，请重试');
      const rec = await addRecord({
        petId: draft.petId,
        date: draft.date,
        text: draft.text,
        tags: draft.tags,
        photos: savedPhotos,
        rawInput: draft.rawInput || { text: draft.text, photos: draft.photos, provenance: 'legacy' },
        mode,
        clientId: key,
      });
      if (scope === JSON.stringify(getCloudSession()) && currentPetId === this.data.currentPet?.id && this.data.messages[idx]?.draft?.key === key) {
        this.updateDraft(idx, { status: 'saved', recordId: rec.id });
      }
    } catch (err: any) {
      if (this.data.messages[idx]?.draft?.key === key) this.updateDraft(idx, { status: 'failed' });
      Toast({ context: this, selector: '#t-toast', message: err.message || '保存失败，请重试', theme: 'error' });
    } finally {
      delete this._savingDrafts[key];
    }
  },

  onCardEdit(e: WechatMiniprogram.CustomEvent) {
    const { key } = e.detail;
    if (this._savingDrafts?.[key]) return;
    const idx = this.findDraft(key);
    if (idx < 0) return;
    if (this.data.messages[idx].draft!.status === 'saved') return;
    this.setData({ editorVisible: true, editorKey: key, editorValue: { ...this.data.messages[idx].draft } });
  },

  onCardDiscard(e: WechatMiniprogram.CustomEvent) {
    if (this._savingDrafts?.[e.detail.key]) return;
    const idx = this.findDraft(e.detail.key);
    if (idx < 0) return;
    if (this.data.messages[idx].draft!.status === 'saved') return;
    this.updateDraft(idx, { status: 'discarded' });
  },

  onCardSetDate(e: WechatMiniprogram.CustomEvent) {
    const { key, date } = e.detail;
    if (this._savingDrafts?.[key]) return;
    const idx = this.findDraft(key);
    if (idx < 0) return;
    if (!isValidDate(date) || this.data.messages[idx].draft!.status === 'saved') return;
    this.updateDraft(idx, { date });
  },

  onCardViewRecord(e: WechatMiniprogram.CustomEvent) {
    wx.navigateTo({ url: `/pages/diary/diary?id=${e.detail.recordId}` });
  },

  updateDraft(idx: number, patch: Record<string, unknown>) {
    const draft = { ...this.data.messages[idx].draft, ...patch };
    this.setData({ [`messages[${idx}].draft`]: draft });
    this.persist();
  },

  /* ---------- 编辑面板 ---------- */

  onEditorClose() {
    this.setData({ editorVisible: false });
  },

  onEditorConfirm(e: WechatMiniprogram.CustomEvent) {
    if (this._savingDrafts?.[this.data.editorKey]) return;
    const { petId, date, text, photos } = e.detail;
    const idx = this.findDraft(this.data.editorKey);
    if (idx < 0) {
      this.setData({ editorVisible: false });
      return;
    }
    const old = this.data.messages[idx].draft!;
    if (old.status === 'saved' || !isValidDate(date)) return;
    const tags = text !== old.text ? extractTags(text) : old.tags;
    this.updateDraft(idx, { petId, date, text, photos, tags, status: 'pending' });
    this.setData({ editorVisible: false });
  },

  /* ---------- 手动“记一下” / 快捷入口 / 引用 ---------- */

  onManualDraft(e: WechatMiniprogram.TouchEvent) {
    const { text } = e.currentTarget.dataset;
    const pet = this.data.currentPet;
    if (!pet || !text) return;
    const msg: ChatMessage = {
      id: uid(),
      role: 'ai',
      kind: 'draft',
      demo: true,
      mode: 'local',
      time: Date.now(),
      draft: { key: '', petId: pet.id, date: null, text, tags: extractTags(text), photos: [], status: 'pending', rawInput: { text, photos: [], provenance: 'direct' } },
    };
    msg.draft!.key = msg.id;
    this.appendMessages([msg]);
  },

  onQuick(e: WechatMiniprogram.TouchEvent) {
    const { mode } = e.currentTarget.dataset;
    this.setData({
      placeholder: mode === 'record' ? '说说发生的小事，比如：今天给咪咪洗了澡' : '比如：上次什么时候洗澡？',
      focusFlag: true,
    });
    setTimeout(() => this.setData({ focusFlag: false }), 300);
  },

  onOpenRef(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/diary/diary?id=${e.currentTarget.dataset.id}` });
  },

  onPreviewPhoto(e: WechatMiniprogram.TouchEvent) {
    const { urls, current } = e.currentTarget.dataset;
    wx.previewImage({ urls, current });
  },

  /* ---------- 宠物切换 ---------- */

  onSwitchPet() {
    const pets = this.data.pets;
    if (!pets.length) return;
    ActionSheet.show({
      theme: 'list',
      selector: '#t-action-sheet',
      context: this,
      items: pets.map((p) => ({ label: `${petEmoji(p.species)} ${p.name}` })).concat([{ label: '＋ 添加宠物' }]),
    });
  },

  onPetSelected(e: WechatMiniprogram.CustomEvent) {
    const { index } = e.detail;
    if (index === this.data.pets.length) {
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    const pet = this.data.pets[index];
    if (!pet || pet.id === this.data.currentPet?.id) return;
    this.cancelGeneration(true);
    setCurrentPet(pet.id);
    this.setData({
      currentPet: pet,
      petAvatar: petEmoji(pet.species),
      messages: getMessages(pet.id),
      inputValue: '', attachments: [], editorVisible: false, editorKey: '', editorValue: {},
    });
    this.scrollToBottom();
  },

  goAddPet() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
