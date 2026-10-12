import ActionSheet from 'tdesign-miniprogram/action-sheet/index';
import Toast from 'tdesign-miniprogram/toast/index';
import {
  getPets, getCurrentPet, setCurrentPet, petEmoji,
  getMessages, saveMessages, addRecord, persistPhotos, uid,
  getModelConfig, getRecords,
  Pet, ChatMessage,
} from '../../utils/store';
import { respond, extractTags, answerQuery, findRuleByTag } from '../../utils/intent';
import { chatWithModel, isModelReady } from '../../utils/llm';
import { runAgent, AbortedError } from '../../utils/agent';
import { today, parseDateWords } from '../../utils/date';

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

  _abort: null as null | { aborted: boolean },

  tabbarHeight(): number {
    const app: any = getApp();
    return (app && app.globalData && app.globalData.tabbarHeight) || 60;
  },

  onShow() {
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
    if (this.data.keyboardHeight) this.setData({ keyboardHeight: 0 });
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
    const remain = 9 - this.data.attachments.length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      success: (res) => {
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
    const text = this.data.inputValue.trim();
    const photos = this.data.attachments.slice();
    const pet = this.data.currentPet;
    if (!pet || (!text && !photos.length) || this.data.aiThinking) return;

    let savedPhotos: string[] = [];
    if (photos.length) {
      wx.showLoading({ title: '处理照片…', mask: true });
      try {
        savedPhotos = await persistPhotos(photos);
      } catch (e) {
        wx.hideLoading();
        Toast({ context: this, selector: '#t-toast', message: '照片处理失败，请重试', theme: 'error' });
        return;
      }
      wx.hideLoading();
    }

    const userMsg: ChatMessage = { id: uid(), role: 'user', kind: 'text', text, photos: savedPhotos, time: Date.now() };
    this.setData({
      messages: this.data.messages.concat(userMsg),
      inputValue: '',
      attachments: [],
      placeholder: '说点什么，比如：今天给咪咪洗澡了',
    });
    this.persist();

    if (text && this.data.modelOn) {
      await this.replyByAI(text, savedPhotos, pet);
    } else {
      const outputs = respond({ text, photos: savedPhotos, petId: pet.id, petName: pet.name });
      this.appendMessages(outputs.map((o) => this.toMessage(o, true, 'local')));
    }
  },

  toMessage(o: any, demo: boolean, mode: string): ChatMessage {
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
      msg.draft = { ...o.draft, key: msg.id, status: 'pending' };
    }
    return msg;
  },

  /** 三级降级：工具调用 → JSON 模式 → 本地演示规则 */
  async replyByAI(text: string, savedPhotos: string[], pet: Pet) {
    this._abort = { aborted: false };
    this.setData({ aiThinking: true });
    this.scrollToBottom();
    const history = this.data.messages
      .filter((m) => m.kind === 'text' && m.text)
      .slice(-8)
      .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text! }));

    try {
      const res = await runAgent(getModelConfig(), text, { pet, history, photos: savedPhotos, abortToken: this._abort! });
      if (this._abort && this._abort.aborted) throw new AbortedError();
      const msgs: ChatMessage[] = res.drafts.map((d) => this.toMessage({ kind: 'draft', draft: d }, false, 'tool'));
      if (res.reply || res.refs.length) {
        msgs.push(this.toMessage({ kind: 'text', text: res.reply || '', refs: res.refs }, false, 'tool'));
      }
      if (!msgs.length) msgs.push(this.toMessage({ kind: 'text', text: '我在呢，继续说～' }, false, 'tool'));
      this.appendMessages(msgs);
    } catch (err: any) {
      if (err instanceof AbortedError) {
        this.appendMessages([this.toMessage({ kind: 'text', text: '已停止生成。' }, false, 'local')]);
        return;
      }
      // 降级一：JSON 模式
      try {
        const records = getRecords(pet.id).slice(0, 20).map((r) => ({ date: r.date, text: r.text, tags: r.tags }));
        const out = await chatWithModel(getModelConfig(), text, {
          petName: pet.name,
          species: pet.species,
          today: today(),
          history,
          records,
        });
        const msgs: ChatMessage[] = [];
        if (out.draft) {
          msgs.push(
            this.toMessage(
              {
                kind: 'draft',
                draft: {
                  petId: pet.id,
                  date: out.draft.date || parseDateWords(text),
                  text: out.draft.text || text,
                  tags: out.draft.tags.length ? out.draft.tags : extractTags(text),
                  photos: savedPhotos,
                },
              },
              false,
              'model',
            ),
          );
        }
        if (out.queryTag) {
          const q = answerQuery({ text, photos: savedPhotos, petId: pet.id, petName: pet.name }, findRuleByTag(out.queryTag));
          msgs.push(this.toMessage(q, false, 'model'));
        }
        if (out.reply) msgs.push(this.toMessage({ kind: 'text', text: out.reply }, false, 'model'));
        if (!msgs.length) msgs.push(this.toMessage({ kind: 'text', text: '我在呢，继续说～' }, false, 'model'));
        this.appendMessages(msgs);
      } catch (e2: any) {
        // 降级二：本地演示规则 + 明确告知
        const reason = (e2 && e2.message) || '未知错误';
        const notice = this.toMessage({ kind: 'text', text: `模型调用失败（${reason}），本次先用本地演示规则应答。` }, true, 'local');
        const outputs = respond({ text, photos: savedPhotos, petId: pet.id, petName: pet.name });
        notice.retry = true;
        notice.sourceText = text;
        this.appendMessages([notice].concat(outputs.map((o) => this.toMessage(o, true, 'local'))));
      }
    } finally {
      this.setData({ aiThinking: false });
      this._abort = null;
    }
  },

  onStop() {
    if (this._abort) this._abort.aborted = true;
    this.setData({ aiThinking: false });
  },

  /** 重试上一条失败的消息 */
  onRetry(e: WechatMiniprogram.TouchEvent) {
    const { text } = e.currentTarget.dataset;
    const pet = this.data.currentPet;
    if (!pet || !text || this.data.aiThinking) return;
    const idx = this.data.messages.findIndex((m) => m.retry && m.sourceText === text);
    if (idx >= 0) {
      const messages = this.data.messages.slice(0, idx);
      messages.push({ ...this.data.messages[idx], retry: false });
      this.setData({ messages });
    }
    this.replyByAI(text, [], pet);
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

  onCardSave(e: WechatMiniprogram.CustomEvent) {
    const { key } = e.detail;
    const idx = this.findDraft(key);
    if (idx < 0) return;
    const draft = this.data.messages[idx].draft!;
    if (!draft.date) {
      Toast({ context: this, selector: '#t-toast', message: '先点选一下发生日期吧', theme: 'warning' });
      return;
    }
    try {
      const rec = addRecord({
        petId: draft.petId,
        date: draft.date,
        text: draft.text,
        tags: draft.tags,
        photos: draft.photos,
      });
      this.updateDraft(idx, { status: 'saved', recordId: rec.id });
    } catch (err) {
      this.updateDraft(idx, { status: 'failed' });
    }
  },

  onCardEdit(e: WechatMiniprogram.CustomEvent) {
    const { key } = e.detail;
    const idx = this.findDraft(key);
    if (idx < 0) return;
    this.setData({ editorVisible: true, editorKey: key, editorValue: { ...this.data.messages[idx].draft } });
  },

  onCardDiscard(e: WechatMiniprogram.CustomEvent) {
    const idx = this.findDraft(e.detail.key);
    if (idx < 0) return;
    this.updateDraft(idx, { status: 'discarded' });
  },

  onCardSetDate(e: WechatMiniprogram.CustomEvent) {
    const { key, date } = e.detail;
    const idx = this.findDraft(key);
    if (idx < 0) return;
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
    const { petId, date, text, photos } = e.detail;
    const idx = this.findDraft(this.data.editorKey);
    if (idx < 0) {
      this.setData({ editorVisible: false });
      return;
    }
    const old = this.data.messages[idx].draft!;
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
      draft: { key: '', petId: pet.id, date: null, text, tags: extractTags(text), photos: [], status: 'pending' },
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
    setCurrentPet(pet.id);
    this.setData({
      currentPet: pet,
      petAvatar: petEmoji(pet.species),
      messages: getMessages(pet.id),
    });
    this.scrollToBottom();
  },

  goAddPet() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
