import { chatSessionMethods } from '../../utils/chat-page-session';
import { chatSaveMethods } from '../../utils/chat-page-save';
import { chatViewportMethods } from '../../utils/chat-page-viewport';
import { petAvatar } from '../../utils/pet-avatars';

import Toast from 'tdesign-miniprogram/toast/index';
import {
  getPets, getCurrentPet, setCurrentPet,
  persistPhotos, uid,
  getModelConfig, getRecords, getCloudSession, getCloudSessionEpoch, getCloudCacheRevision,
  Pet, ChatMessage,
} from '../../utils/store';
import { ChatSession, SessionIndex, MAX_MESSAGES, loadLocalSession, saveLocalSession, newSession, generateTitle, readSession } from '../../utils/chat-store';
import { extractTags } from '../../utils/intent';
import { chatWithModel } from '../../utils/llm';
import { runAgent, AbortedError } from '../../utils/agent';
import { today, isValidDate } from '../../utils/date';
import { RequestToken } from '../../utils/cancellation';
import { CloudError } from '../../utils/cloud';
import { isHistoryQuery, hasExplicitQuestion, queryRecords, resolveQueryOptions } from '../../utils/query';
import { validateDraft, validateDraftUpdate, dateCorrectionFallback, isDateCorrectionRequest, appendCorrection, draftUpdateReply, DraftUpdate } from '../../utils/draft';
import { unclaimedPhotos, buildHistory, buildDraftStates } from '../../utils/context';
import { refreshCloudIfStale } from '../../utils/repository';
import { getLayout } from '../../utils/layout';
import { isOffline } from '../../utils/network';
import { showPetPicker } from '../../utils/pet-picker';
import { guardReady } from '../../utils/onboard';
import { openAddPet } from '../../utils/pet-navigation';
import { isTestFamily } from '../../utils/new-user-test';
import { beginTrace, traceError, TraceHandle } from '../../utils/debug-trace';

import { SaveViewState } from '../../utils/save-progress';
import { getFlowRun, executeFlow, cancelFlowRun, FlowPage } from '../../utils/flow-test';

/** 欢迎态建议：按当前宠物生成，点一下就能直接开聊 */
function buildSuggestions(pet: Pet | null) {
    const name = pet ? pet.name : '小家伙';
    return [
        { emoji: '📝', text: `记一件${name}今天的小事` },
        { emoji: '🛁', text: `上次给${name}洗澡是什么时候` },
        { emoji: '💊', text: `${name}该驱虫了吗` },
        { emoji: '🩺', text: `回顾一下${name}最近的状态` },
    ];
}

function greetingText(now = new Date()) {
    const hour = now.getHours();
    if (hour < 6) return '夜深了，注意休息';
    if (hour < 11) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
}

Page({
  ...chatSessionMethods,
  ...chatSaveMethods,
  ...chatViewportMethods,
  data: {
    pets: [] as Pet[],
    currentPet: null as Pet | null,
    petAvatar: '',
    testFamily: false,
    flowRun: null as any, flowRunning: false,
    messages: [] as ChatMessage[],
    inputValue: '',
    attachments: [] as string[],
    placeholder: '说点什么，比如：今天给咪咪洗澡了',
    focusFlag: false,
    scrollTo: '',
    keyboardHeight: 0,
    /** 键盘是否弹起：用来收起快捷行与隐藏 tabBar */
    keyboardUp: false,
    /** iOS 上手动把输入台顶到键盘上沿的偏移（px），安卓/鸿蒙靠视口压缩，恒为 0 */
    keyboardOffset: 0,
    /** 是否交给系统自动避让（adjust-position），手动顶起时关闭避免重复避让 */
    adjustPosition: true,
    aiThinking: false,
    editorVisible: false,
    editorValue: {} as any,
    editorKey: '',
    tabbarHeight: 60,
    greeting: '你好',
    suggestions: buildSuggestions(null),
    /** 当前话题实际带入模型的上下文条数（输入区上方可见） */
    contextCount: 0,
    /** 会话目录（云端索引，只含标题/摘要/条数/时间） */
    sessions: [] as SessionIndex[],
    sessionListVisible: false,
    sessionId: '',
    sessionVersion: 0,
    /** 当前会话已满 100 条，提示开启新话题 */
    messageCapped: false,
    saveStates: {} as Record<string, SaveViewState>,
  },

  /** 当前会话：消息流与同步的载体，不直接参与渲染 */
  _session: null as ChatSession | null,
  /** 标题生成中：避免同一会话重复调用模型 */
  _titleBusy: false,
  _syncTail: Promise.resolve() as Promise<void>,
  _syncPending: 0,
  _visible: false,
  _disposed: false,
  _scopeEpoch: null as number | null,
  _idleTimer: null as ReturnType<typeof setTimeout> | null,
  /** 用户主动打开旧话题后，从打开时重新计时，避免刚打开就被自动移走。 */
  _resumedClientId: '',
  _resumedAt: 0,
  _abort: null as RequestToken | null,
  _offKeyboard: null as (() => void) | null,
  /** 最近一次系统上报的键盘高度，仅用于判断键盘是否还在 */
  _lastKeyboard: 0,
  /** 是否需要手动把输入台顶起：iOS 键盘弹起时视口不会被压缩，必须用键盘高度自己避让 */
  _manualLift: false,

  onLoad() {
    this._disposed = false;
    this._scopeEpoch = getCloudSessionEpoch();
    this.initViewport();
  },

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
    if (notice) this.appendMessages([this.toMessage({ kind: 'text', text: '已停止生成。' }, 'manual')]);
  },

  /** 用本机缓存渲染（切 tab 零等待）；后台刷新后只有数据真的变化才重渲染，且不打断翻阅位置 */
  renderFromStore(layout: { tabbarHeight: number }, scroll = false) {
    const pets = getPets();
    const currentPet = getCurrentPet();
    this._session = currentPet ? loadLocalSession(currentPet.id) : null;
    this.setData({
      pets,
      currentPet,
      petAvatar: currentPet ? petAvatar(currentPet) : '',
      messages: this._session ? this._session.messages : [],
      sessionId: this._session ? this._session.id : '',
      sessionVersion: this._session ? this._session.version : 0,
      messageCapped: !!(this._session && this._session.messages.length >= MAX_MESSAGES),
      tabbarHeight: layout.tabbarHeight,
      greeting: greetingText(),
      suggestions: buildSuggestions(currentPet),
    });
    this.syncContextCount();
    this.refreshTopicBoundary();
    if (scroll) this.scrollToBottom();
  },

  async onShow() {
    // 未登录或未配置模型：先走引导流程，本页不再渲染
    if (!guardReady()) return;
    this._scopeEpoch = getCloudSessionEpoch();
    this.setData({ testFamily: isTestFamily() });
    this._visible = true;
    const layout = getLayout(true);
    // 缓存优先渲染：本地数据毫秒级呈现，不再先清空等云端
    const revision = getCloudCacheRevision();
    this.renderFromStore(layout, true);
    const tabbar = this.getTabBar && this.getTabBar();
    if (tabbar) tabbar.setData({ selected: 1, hidden: false });
    if (!getCloudSession()) return;
    try {
      const refreshed = await refreshCloudIfStale();
      if (refreshed && getCloudCacheRevision() !== revision) this.renderFromStore(layout);
      // 后台拉取会话目录与当前会话最新内容（换设备后也能接着聊）
      await this.syncSessions();
    } catch (err: any) {
      if (!getCloudSession()?.familyId) {
        this.renderFromStore(layout);
        guardReady();
      }
      Toast({ context: this, selector: '#t-toast', message: err.message || '云端读取失败，请重新进入页面', theme: 'error' });
    }
    this.syncFlowState();
  },

  syncFlowState() {
    const run = getFlowRun();
    this.setData({ flowRun: run && run.familyId === getCloudSession()?.familyId && run.petId === this.data.currentPet?.id ? run : null,
      flowRunning: !!run && run.status === 'running' && run.petId === this.data.currentPet?.id });
  },
  flowAdapter(): FlowPage {
    return {
      petId: () => this.data.currentPet?.id || '', visible: () => this._visible && !this._disposed,
      messages: () => this.data.messages, topicId: () => this._session?.clientId || '',
      send: async text => {
        const oldIds = new Set(this.data.messages.map(m => m.id));
        this.setData({ inputValue: text, attachments: [] }); this._flowAction = true;
        try { await this.onSend(); await this._syncTail; }
        finally { this._flowAction = false; }
        return this.data.messages.filter(m => !oldIds.has(m.id) && m.role === 'ai');
      },
      save: async key => {
        this._flowAction = true;
        try { await this.onCardSave({ detail: { key } }); await this._syncTail; }
        finally { this._flowAction = false; }
      },
      newTopic: () => { this._flowAction = true; try { this.onNewTopic(); } finally { this._flowAction = false; } },
      cancel: () => this.cancelGeneration(true), update: () => this.syncFlowState(),
    };
  },
  async onFlowNext() { try { await executeFlow(this.flowAdapter()); } catch (error: any) { this.setData({ flowRun: { ...this.data.flowRun, error: error.message } }); } },
  async onFlowAll() { try { await executeFlow(this.flowAdapter(), true); } catch (error: any) { this.setData({ flowRun: { ...this.data.flowRun, error: error.message } }); } },
  onFlowStop() { cancelFlowRun(); },
  onFlowReport() { wx.navigateTo({ url: '/pages/selftest/selftest?section=flow' }); },

  onHide() {
    if (this.data.flowRunning) cancelFlowRun();
    this._visible = false;
    this.clearTopicTimer();
    this.cancelGeneration(true);
    wx.hideKeyboard();
    this.collapseKeyboard();
    this.setData({ focusFlag: false });
  },

  onUnload() {
    if (this.data.flowRunning) cancelFlowRun();
    this._disposed = true;
    this._visible = false;
    this.clearTopicTimer();
    if (this._offKeyboard) { this._offKeyboard(); this._offKeyboard = null; }
    this.cancelGeneration();
  },

  preventBubble() {},

  /* ---------- 发送 ---------- */

  onInput(e: WechatMiniprogram.CustomEvent) {
    this.setData({ inputValue: e.detail.value });
    this.refreshTopicBoundary();
  },

  onChoosePhoto() {
    if (this.data.flowRunning) return;
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
    if (this.data.flowRunning) return;
    const { index } = e.currentTarget.dataset;
    const attachments = this.data.attachments.slice();
    attachments.splice(index, 1);
    this.setData({ attachments });
  },

  async onSend() {
    if (this.data.flowRunning && !this._flowAction) return;
    const originalText = this.data.inputValue;
    const text = originalText.trim();
    const photos = this.data.attachments.slice();
    const pet = this.data.currentPet;
    if (!pet || (!text && !photos.length) || this.data.aiThinking) return;
    // 离线时不走模型：避免生成一条永远同步不上去的半截对话
    if (isOffline()) {
      Toast({ context: this, selector: '#t-toast', message: '当前离线，联网后再聊吧', theme: 'warning' });
      return;
    }
    // 为本轮用户消息、记录卡和回复留空间，禁止云同步时静默丢掉最早 100 条以外的消息。
    if (this.data.messages.length > MAX_MESSAGES - 3) this.startNewSession();
    const token = new RequestToken();
    // 历史快照必须取在新会话开启之后，否则会把上一个话题带进来
    const historyMessages = this.data.messages.slice();
    this._abort = token;
    this.setData({ aiThinking: true }); // 照片处理阶段也锁定发送，防止连点重复提交
    this.clearTopicTimer();
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
      if (text) await this.replyByAI(text, savedPhotos, pet, token, historyMessages);
      // 只发照片：直接整理成一张照片日记待确认卡，日期交给用户点选
      else this.appendMessages([this.photoDraft(pet, savedPhotos)]);
    } catch (error) {
      if (this.isActive(token, pet.id)) Toast({ context: this, selector: '#t-toast', message: '照片处理失败，请重试', theme: 'error' });
    } finally {
      if (this._abort === token) {
        this._abort = null;
        this.setData({ aiThinking: false });
        wx.hideLoading();
        this.refreshTopicBoundary();
      }
    }
  },

  /** 只发照片：整理成照片日记待确认卡，日期由用户点选 */
  photoDraft(pet: Pet, photos: string[]): ChatMessage {
    const msg: ChatMessage = {
      id: uid(),
      role: 'ai',
      kind: 'draft',
      mode: 'manual',
      time: Date.now(),
      draft: {
        key: '',
        petId: pet.id,
        date: null,
        text: '',
        tags: ['照片'],
        photos,
        status: 'pending',
        rawInput: { text: '', photos: photos.slice(), provenance: 'direct' },
      },
    };
    msg.draft!.key = msg.id;
    return msg;
  },

  toMessage(o: any, mode: 'model' | 'tool' | 'manual'): ChatMessage {
    const msg: ChatMessage = {
      id: uid(),
      role: 'ai',
      kind: o.kind,
      text: o.text,
      refs: o.refs,
      action: o.action,
      sourceText: o.sourceText,
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

  /** 两级降级共享请求信号、草稿校验和查询服务：工具调用失败时降级为严格 JSON，再失败只给错误与重试。 */
  async replyByAI(text: string, savedPhotos: string[], pet: Pet, token = new RequestToken(), historyMessages?: ChatMessage[]) {
    const epoch = getCloudSessionEpoch(), owner = this;
    const scopedToken = { get aborted() { return token.aborted || epoch !== getCloudSessionEpoch() || owner.data.currentPet?.id !== pet.id; }, onAbort: token.onAbort };
    const flow = getFlowRun();
    const trace = beginTrace({ path: 'tool', date: today(), historyCount: (historyMessages || this.data.messages).length,
      runId: flow?.status === 'running' ? flow.id : undefined, step: flow?.status === 'running' ? flow.next : undefined });
    this._abort = token;
    this.setData({ aiThinking: true });
    this.clearTopicTimer();
    this.scrollToBottom();
    const referenceDate = today();
    // 首次云同步会将 id 从空值回填为正式 id；clientId 才是创建时就固定的话题身份。
    const requestTopicIdentity = this._session?.clientId || this.data.sessionId;
    const assertRequestContext = () => {
      this.assertActive(token, pet.id);
      if (scopedToken.aborted) throw new AbortedError();
      if ((this._session?.clientId || this.data.sessionId) !== requestTopicIdentity) {
        trace?.emit('request.invalidated', { status: 'topic_changed' });
        throw new AbortedError();
      }
    };
    // 对话历史与取证窗口都以最后一个话题分隔条为界
    const history = buildHistory(historyMessages || this.data.messages);
    const conversation = buildHistory(historyMessages || this.data.messages, Infinity, true);
    // 本条没附图时，从本会话的未认领照片池补齐（先发图、后说「记一下」也能带上图）
    const photoPool = savedPhotos.length ? savedPhotos : unclaimedPhotos(this.data.messages);
    const cfg = getModelConfig(); // 请求全程使用同一个配置快照
    const source = this.data.messages.slice().reverse().find((m: ChatMessage) => m.role === 'user' && m.text === text);
    const originalText = source?.sourceText !== undefined ? source.sourceText : text;
    const draftStatuses = buildDraftStates(this.data.messages, pet.id);
    try {
      const res = await runAgent(cfg, text, {
        pet, history, conversation, photos: photoPool, abortToken: scopedToken, originalText,
        // 记录卡实时状态：用户点了保存/不记录，模型立刻知道，不再反复提醒确认
        draftStatuses,
        onEvent: trace?.emit,
        // 历史话题只给标题目录，正文由模型判断后按需取回
        sessionIndex: this.data.sessions.filter((s) => s.id !== this.data.sessionId).slice(0, 10),
        readSession: async (id: string, offset: number, limit: number) => {
          const petId = pet.id;
          const session = await readSession(petId, id);
          this.assertActive(token, pet.id);
          const rows = buildHistory(session.messages, Infinity);
          return JSON.stringify({ messages: rows.slice(offset, offset + limit), total: rows.length,
            nextOffset: offset + limit < rows.length ? offset + limit : null });
        },
      });
      assertRequestContext();
      let updateReply = '';
      if (res.draftUpdates?.length) {
        updateReply = this.applyModelDraftUpdate(res.draftUpdates[0], pet.id, trace);
      }
      const msgs: ChatMessage[] = res.drafts.map((d) => {
        if (d.rawInput?.text === text) d.rawInput.text = originalText;
        return this.toMessage({ kind: 'draft', draft: d, sourceText: originalText, sourcePhotos: savedPhotos }, 'tool');
      });
      if (trace) { if (!this._draftTraces) this._draftTraces = {}; msgs.forEach(m => { this._draftTraces[m.id] = trace; }); }
      if (updateReply) msgs.push(this.toMessage({ kind: 'text', text: updateReply }, 'tool'));
      if ((!updateReply || res.refs.length) && (res.reply || res.refs.length)) msgs.push(this.toMessage({ kind: res.refs.length ? 'query' : 'text', text: res.reply || '', refs: res.refs }, 'tool'));
      if (!msgs.length) msgs.push(this.toMessage({ kind: 'text', text: '我在呢，继续说～' }, 'tool'));
      this.appendMessages(msgs);
      trace?.finish('complete', { path: 'tool', drafts: res.drafts.length, refs: res.refs.map(r => r.recordId) });
    } catch (err: any) {
      if (err instanceof AbortedError || !this.isActive(token, pet.id)) { trace?.finish('cancelled'); return; }
      if (cfg.source === 'cloud' && err instanceof CloudError && !['UNSUPPORTED_TOOLS', 'EMPTY'].includes(err.code)) {
        trace?.finish('failed', { path: 'tool', error: traceError(err) });
        const notice = this.toMessage({ kind: 'text', text: `${err.message}。可检查配置后重试。` }, 'model');
        notice.retry = true;
        notice.sourceText = text;
        notice.sourcePhotos = savedPhotos.slice();
        this.appendMessages([notice]);
        return;
      }
      trace?.emit('fallback.json', { path: 'json', error: traceError(err) });
      try {
        const out = await chatWithModel(cfg, text, {
          petName: pet.name, species: pet.species, today: referenceDate, history, draftStatuses,
          records: getRecords(pet.id).slice(0, 20).map((r) => ({ date: r.date, text: r.text, tags: r.tags })),
        }, scopedToken);
        assertRequestContext();
        const msgs: ChatMessage[] = [];
        let correctionReply = '';
        if (out.update) {
          try {
            const update = validateDraftUpdate(out.update, draftStatuses, { text, originalText, petId: pet.id,
              userHistory: conversation.filter(m => m.role === 'user') }, referenceDate);
            correctionReply = this.applyModelDraftUpdate(update, pet.id, trace);
          } catch (error: any) { correctionReply = `草稿尚未修改：${error.message}。`; }
        } else if (!out.draft || (draftStatuses.length && isDateCorrectionRequest(text))) {
          const correction = dateCorrectionFallback(text, draftStatuses, pet.id, conversation.filter(m => m.role === 'user'), referenceDate, originalText);
          if (correction) correctionReply = correction.update
            ? this.applyModelDraftUpdate(correction.update, pet.id, trace) : correction.reply;
        }
        if (out.draft && !correctionReply) {
          const draft = validateDraft(out.draft, { text, originalText, petId: pet.id, photos: photoPool,
            userHistory: conversation.filter((m) => m.role === 'user') }, referenceDate);
          if (draft.rawInput.text === text) draft.rawInput.text = originalText;
          msgs.push(this.toMessage({ kind: 'draft', draft, sourceText: originalText, sourcePhotos: savedPhotos }, 'model'));
          trace?.emit('draft.validated', { path: 'json', date: draft.date, proposedDate: out.draft.date });
          if (trace) { if (!this._draftTraces) this._draftTraces = {}; this._draftTraces[msgs[msgs.length - 1].id] = trace; }
        }
        const historical = isHistoryQuery(text);
        const querying = (!correctionReply || (!!out.query && hasExplicitQuestion(text))) && (!!out.query || historical) && (!out.draft || hasExplicitQuestion(text));
        if (querying) {
          const options = out.query || resolveQueryOptions(text, {}, referenceDate);
          if (!out.query && !options.eventType && !options.keyword && !/记录|日记/.test(text)) throw new Error('请补充要查询的事件关键词');
          const result = queryRecords({ ...options, petId: pet.id });
          trace?.emit('query.result', { path: 'json', ...options, matched: result.totalMatched, records: result.records.map(r => ({ id: r.id, date: r.date })) });
          msgs.push(this.toMessage({ kind: 'query', text: result.summary, refs: result.refs }, 'model'));
        }
        if (correctionReply) msgs.push(this.toMessage({ kind: 'text', text: correctionReply }, 'model'));
        else if (!out.draft && !querying && out.reply) msgs.push(this.toMessage({ kind: 'text', text: out.reply }, 'model'));
        if (!msgs.length) msgs.push(this.toMessage({ kind: 'text', text: '我在呢，继续说～' }, 'model'));
        this.appendMessages(msgs);
        trace?.finish('complete', { path: 'json', drafts: out.draft ? 1 : 0, refs: msgs.flatMap(m => (m.refs || []).map(r => r.recordId)) });
      } catch (error: any) {
        if (error instanceof AbortedError || !this.isActive(token, pet.id)) { trace?.finish('cancelled'); return; }
        trace?.finish('failed', { path: 'json', error: traceError(error) });
        // 联网与模型是使用的前提，失败时只给错误和重试，不做无模型的兜底应答
        const notice = this.toMessage({
          kind: 'text',
          text: `模型调用失败（工具：${err.message || '未知错误'}；JSON：${error.message || '未知错误'}）。请检查网络和模型配置后重试。`,
        }, 'model');
        notice.retry = true;
        notice.sourceText = text;
        notice.sourcePhotos = savedPhotos.slice();
        this.appendMessages([notice]);
      }
    } finally {
      // 旧请求迟到，不能清掉后续新请求的思考状态和取消句柄。
      if (this._abort === token) {
        this._abort = null;
        this.setData({ aiThinking: false });
        this.refreshTopicBoundary();
      }
    }
  },

  applyModelDraftUpdate(update: DraftUpdate, petId: string, trace?: TraceHandle): string {
    const states = buildDraftStates(this.data.messages, petId);
    const current = states.find(row => row.key === update.key);
    if (this._savingDrafts?.[update.key] || !current || current.status !== 'pending'
      || ['key', 'petId', 'date', 'text', 'status'].some(field => current[field] !== update.expected[field])
      || JSON.stringify(current.tags) !== JSON.stringify(update.expected.tags)) {
      return '草稿状态已变化，本次更正未应用。请核对当前卡片后再试。';
    }
    // 日期方案已基于用户消息校验，应用时只允许已验证字段，不采纳任意模型 patch。
    const patch = update.patch;
    if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !['date', 'text', 'tags'].includes(key))
      || (patch.date !== undefined && (!isValidDate(patch.date) || patch.date > today()))
      || (patch.text !== undefined && (typeof patch.text !== 'string' || !patch.text.trim()))
      || (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some(tag => typeof tag !== 'string')))) {
      return '草稿更正内容无效，尚未修改。';
    }
    const idx = this.findDraft(update.key);
    const old = this.data.messages[idx].draft!;
    let rawInput;
    try { rawInput = appendCorrection(old.rawInput, old, update.correction); }
    catch (error: any) { return `草稿尚未修改：${error.message}。`; }
    try { this.updateDraft(idx, { ...patch, rawInput }); }
    catch (_) {
      this.setData({ [`messages[${idx}].draft`]: old });
      return '本机未能保存草稿更正，尚未修改，请稍后重试。';
    }
    this.setSaveView(update.key);
    trace?.emit('draft.update_applied', { tool: 'update_draft_record', date: this.data.messages[idx].draft!.date, status: 'pending' });
    return draftUpdateReply(this.data.messages[idx].draft!, patch);
  },

  onStop() {
    if (this.data.flowRunning) cancelFlowRun();
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
    this.syncContextCount();
    this.replyByAI(text, photos, pet, new RequestToken(), historyMessages);
  },

  appendMessages(msgs: ChatMessage[]) {
    const messages = this.data.messages.concat(msgs);
    this.setData({ messages, messageCapped: messages.length >= MAX_MESSAGES });
    this.persist();
    this.syncContextCount();
    this.scrollToBottom();
    this.maybeGenerateTitle();
    this.refreshTopicBoundary();
  },

  /** 会话标题：第一句说完就由模型生成一次，之后不再改（失败也不影响聊天） */
  async maybeGenerateTitle() {
    if (this._disposed) return;
    const epoch = getCloudSessionEpoch();
    const petId = this.data.currentPet?.id;
    if (!petId || this._titleBusy) return;
    const session = this._session;
    if (!session || session.title) return;
    const userTexts = session.messages.filter((m) => m.role === 'user' && m.text).map((m) => m.text!);
    if (!userTexts.length) return;
    this._titleBusy = true;
    try {
      const title = await generateTitle(getModelConfig(), userTexts);
      if (this._disposed || epoch !== getCloudSessionEpoch()) return;
      // 等待期间同步可能已用服务端返回的新对象替换 _session，标题要落在最新对象上
      const current = this._session;
      if (!title || !current || current.clientId !== session.clientId || current.title || this.data.currentPet?.id !== petId) return;
      current.title = title;
      current.version = this.data.sessionVersion;
      saveLocalSession(petId, current);
      await this.syncSession(current);
      this.refreshSessionIndex();
    } catch (e) { /* 标题失败不影响聊天 */ } finally {
      this._titleBusy = false;
    }
  },

  persist() {
    if (this._disposed || (this._scopeEpoch !== null && this._scopeEpoch !== getCloudSessionEpoch())) return;
    const pet = this.data.currentPet;
    if (!pet) return;
    if (!this._session) this._session = newSession();
    this._session.messages = this.data.messages;
    this._session.version = this.data.sessionVersion;
    saveLocalSession(pet.id, this._session);
    this.syncSession(); // 写入本机后立即同步云端，失败由 syncSession 提示
  },

  scrollToBottom() {
    this.setData({ scrollTo: '' });
    setTimeout(() => {
      if (this.data.aiThinking) {
        this.setData({ scrollTo: 'ai-thinking' });
        return;
      }
      // 分隔条不在界面上渲染，锚点要落在最后一条可见消息上
      const msgs = this.data.messages;
      let last;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].kind !== 'divider') { last = msgs[i]; break; }
      }
      if (last) this.setData({ scrollTo: `m-${last.id}` });
    }, 80);
  },

  onCardEdit(e: WechatMiniprogram.CustomEvent) {
    const { key } = e.detail;
    if (this._savingDrafts?.[key]) return;
    const idx = this.findDraft(key);
    if (idx < 0) return;
    if (this.data.messages[idx].draft!.status === 'saved') return;
    this.clearTopicTimer();
    this.setData({ editorVisible: true, editorKey: key, editorValue: { ...this.data.messages[idx].draft } });
  },

  onCardDiscard(e: WechatMiniprogram.CustomEvent) {
    if (this._savingDrafts?.[e.detail.key]) return;
    const idx = this.findDraft(e.detail.key);
    if (idx < 0) return;
    if (this.data.messages[idx].draft!.status === 'saved') return;
    this.updateDraft(idx, { status: 'discarded' });
    this.setSaveView(e.detail.key);
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
    this.refreshTopicBoundary();
  },

  onEditorConfirm(e: WechatMiniprogram.CustomEvent) {
    if (this._savingDrafts?.[this.data.editorKey]) return;
    const { petId, date, text, photos } = e.detail;
    const idx = this.findDraft(this.data.editorKey);
    if (idx < 0) {
      this.setData({ editorVisible: false });
      this.refreshTopicBoundary();
      return;
    }
    const old = this.data.messages[idx].draft!;
    if (old.status === 'saved' || !isValidDate(date)) return;
    const tags = text !== old.text ? extractTags(text) : old.tags;
    // 编辑后重新按照片路径对齐 fileId，避免删除/替换图片后仍保存旧照片。
    const photoIds = photos.map((path: string) => {
      const oldIndex = old.photos.indexOf(path);
      return oldIndex >= 0 ? old.photoIds?.[oldIndex] || '' : '';
    });
    this.updateDraft(idx, { petId, date, text, photos, photoIds, tags, status: 'pending' });
    this.setSaveView(old.key);
    this.setData({ editorVisible: false });
    this.refreshTopicBoundary();
  },

  /* ---------- 手动“记一下” / 快捷入口 / 引用 ---------- */

  onManualDraft(e: WechatMiniprogram.TouchEvent) {
    const { text } = e.currentTarget.dataset;
    const pet = this.data.currentPet;
    if (!pet || !text) return;
    // 手动「记一下」同样带上本会话内未被认领的照片
    const pool = unclaimedPhotos(this.data.messages);
    const msg: ChatMessage = {
      id: uid(),
      role: 'ai',
      kind: 'draft',
      mode: 'manual',
      time: Date.now(),
      draft: { key: '', petId: pet.id, date: null, text, tags: extractTags(text), photos: pool, status: 'pending', rawInput: { text, photos: pool.slice(), provenance: 'direct' } },
    };
    msg.draft!.key = msg.id;
    this.appendMessages([msg]);
  },

  onQuick(e: WechatMiniprogram.TouchEvent) {
    if (this.data.flowRunning) return;
    const { mode, prompt } = e.currentTarget.dataset;
    this.setData({
      ...(prompt ? { inputValue: String(prompt).replace('{pet}', this.data.currentPet?.name || '小家伙') } : {}),
      placeholder: mode === 'record' ? '说说发生的小事，比如：今天给咪咪洗了澡' : '比如：上次什么时候洗澡？',
      focusFlag: true,
    });
  },

  /** 欢迎态建议卡：直接替用户发出去，少一步输入 */
  onSuggest(e: WechatMiniprogram.TouchEvent) {
    const text = e.currentTarget.dataset.text;
    if (!text || this.data.aiThinking) return;
    this.setData({ inputValue: text, focusFlag: false });
    this.onSend();
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
    if (this.data.flowRunning) return;
    const pets = this.data.pets;
    if (!pets.length) return;
    /*
     * 先收键盘、复位输入台偏移与 tabBar，再弹窗：
     * 否则弹窗会在"键盘正在收起、dock 的 margin-bottom 还在复位"的过渡布局上弹出，
     * 位置和时光册页的弹窗不一致。
     */
    wx.hideKeyboard();
    this.setData({ focusFlag: false });
    this.collapseKeyboard();
    showPetPicker(this, pets);
  },

  onPetSelected(e: WechatMiniprogram.CustomEvent) {
    const { index } = e.detail;
    if (index === this.data.pets.length) {
      openAddPet();
      return;
    }
    const pet = this.data.pets[index];
    if (!pet || pet.id === this.data.currentPet?.id) return;
    this.cancelGeneration(true);
    // 放下当前会话：顺手补上标题与摘要
    const leavingPetId = this.data.currentPet?.id;
    if (leavingPetId && this._session) this.finalizeSession(leavingPetId, this._session);
    setCurrentPet(pet.id);
    this._session = loadLocalSession(pet.id);
    this.setData({
      currentPet: pet,
      petAvatar: petAvatar(pet),
      messages: this._session ? this._session.messages : [],
      sessionId: this._session ? this._session.id : '',
      sessionVersion: this._session ? this._session.version : 0,
      messageCapped: !!(this._session && this._session.messages.length >= MAX_MESSAGES),
      suggestions: buildSuggestions(pet),
      inputValue: '', attachments: [], editorVisible: false, editorKey: '', editorValue: {},
    });
    this.syncContextCount();
    this.scrollToBottom();
    this.refreshTopicBoundary();
    this.syncSessions(); // 切换宠物后拉取该宠物的会话目录与最新内容
  },

  goAddPet() {
    openAddPet();
  },
});
