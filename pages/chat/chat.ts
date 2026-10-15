import { petAvatar } from '../../utils/pet-avatars';
import ActionSheet from 'tdesign-miniprogram/action-sheet/index';
import Dialog from 'tdesign-miniprogram/dialog/index';
import Toast from 'tdesign-miniprogram/toast/index';
import {
  getPets, getCurrentPet, setCurrentPet,
  persistPhotos, uid,
  getModelConfig, getRecords, getCloudSession, getCloudSessionEpoch, getCloudCacheRevision,
  Pet, ChatMessage,
} from '../../utils/store';
import {
  ChatSession, SessionIndex, MAX_MESSAGES,
  loadLocalSession, saveLocalSession, newSession, pushSession, pullSession, listSessions, removeSession,
  generateTitle, generateSessionMeta, readSession,
} from '../../utils/chat-store';
import { extractTags } from '../../utils/intent';
import { chatWithModel } from '../../utils/llm';
import { runAgent, AbortedError } from '../../utils/agent';
import { today, isValidDate } from '../../utils/date';
import { RequestToken } from '../../utils/cancellation';
import { CloudError } from '../../utils/cloud';
import { isHistoryQuery, hasExplicitQuestion, queryRecords, resolveQueryOptions } from '../../utils/query';
import { validateDraft } from '../../utils/draft';
import {
  SESSION_GAP_MS, unclaimedPhotos, buildHistory, isDivider, makeDivider,
} from '../../utils/context';
import { addRecord, refreshCloudIfStale, cloudFileIds } from '../../utils/repository';
import { getLayout } from '../../utils/layout';
import { isOffline } from '../../utils/network';
import { showPetPicker } from '../../utils/pet-picker';
import { guardReady } from '../../utils/onboard';
import { openAddPet } from '../../utils/pet-navigation';
import { isTestFamily } from '../../utils/new-user-test';
import { beginTrace, traceError, TraceHandle } from '../../utils/debug-trace';
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
    /*
     * 键盘避让分两条路：
     * - 安卓：键盘弹起时视口被压缩、100vh 变小，输入台在页面流底部自然落到键盘上沿，
     *   不依赖任何键盘高度接口，不上报高度的机型也一样工作。
     * - 其他平台（iOS/鸿蒙等）：视口不会被可靠压缩，键盘直接盖住页面底部，
     *   必须监听键盘高度，给输入台加 margin-bottom 手动顶起（_manualLift），
     *   同时关闭 adjust-position，防止系统自动推页面与手动顶起叠加。
     */
    try {
      const info = (wx as any).getDeviceInfo ? (wx as any).getDeviceInfo() : wx.getSystemInfoSync();
      const platform = (info && info.platform) || '';
      if (platform !== 'android') {
        this._manualLift = true;
        this.setData({ adjustPosition: false });
      }
    } catch (e) { /* 获取失败则保持视口压缩方案 */ }
    if (typeof wx.onKeyboardHeightChange === 'function') {
      const handler = (res: any) => this.setKeyboardHeight((res && res.height) || 0);
      wx.onKeyboardHeightChange(handler);
      this._offKeyboard = () => {
        if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(handler);
      };
    }
  },

  /** 键盘弹起时收起 tabBar，把底部整条让给输入台 */
  syncTabbarVisibility(hidden: boolean) {
    const tabbar: any = this.getTabBar && this.getTabBar();
    if (tabbar && tabbar.data.hidden !== hidden) tabbar.setData({ hidden });
  },

  /** 键盘高度变化：更新显隐状态；iOS 上同时算出输入台的顶起偏移 */
  setKeyboardHeight(height: number) {
    this._lastKeyboard = height || 0;
    const keyboardUp = this.data.focusFlag || this._lastKeyboard > 0;
    const keyboardOffset = this._manualLift && keyboardUp ? this._lastKeyboard : 0;
    if (
      keyboardUp !== this.data.keyboardUp ||
      this._lastKeyboard !== this.data.keyboardHeight ||
      keyboardOffset !== this.data.keyboardOffset
    ) {
      this.setData({ keyboardHeight: this._lastKeyboard, keyboardUp, keyboardOffset });
    }
    this.syncTabbarVisibility(keyboardUp);
    if (keyboardUp) setTimeout(() => this.scrollToBottom(), 80);
  },

  collapseKeyboard() {
    this._lastKeyboard = 0;
    this.setData({ keyboardHeight: 0, keyboardUp: false, keyboardOffset: 0 });
    this.syncTabbarVisibility(false);
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

  /** 后台同步：会话目录 + 当前会话的最新版本（本机有未同步改动时保留本机） */
  async syncSessions() {
    const petId = this.data.currentPet?.id;
    if (!petId) return;
    try {
      const sessions = await listSessions(petId);
      if (petId !== this.data.currentPet?.id) return;
      this.setData({ sessions });
    } catch (e) { /* 目录拉取失败不影响聊天 */ }
    if (!this._session || !this._session.id || this._syncPending || this.data.aiThinking) return;
    const active = this._session;
    try {
      const latest = await pullSession(petId, active);
      if (this._session !== active || this.data.currentPet?.id !== petId || this._syncPending || this.data.aiThinking) return;
      if (latest.version !== this.data.sessionVersion) {
        this._session = latest;
        saveLocalSession(petId, latest);
        this.setData({ messages: latest.messages, sessionVersion: latest.version });
        this.syncContextCount();
        this.refreshTopicBoundary();
      }
    } catch (e) { /* 当前会话拉取失败时保留本机缓存 */ }
  },

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

  onKeyboardHeight(e: WechatMiniprogram.CustomEvent) {
    this.setKeyboardHeight((e.detail && e.detail.height) || 0);
  },

  onFocus(e: WechatMiniprogram.CustomEvent) {
    this.refreshTopicBoundary();
    const h = (e.detail && e.detail.height) || this._lastKeyboard;
    this.setData({ focusFlag: true });
    this.setKeyboardHeight(h);
  },

  onBlur() {
    this.setData({ focusFlag: false });
    // 延迟一拍：安卓上 blur 与视口恢复不是同一帧，立即清零会闪一下
    setTimeout(() => { if (!this.data.focusFlag) this.collapseKeyboard(); }, 120);
  },

  onTapPageBlank() {
    if (this.data.focusFlag || this.data.keyboardUp) {
      wx.hideKeyboard();
      this.setData({ focusFlag: false });
      this.collapseKeyboard();
    }
  },

  preventBubble() {},

  /* ---------- 话题会话 ---------- */

  /** 当前实际带入模型的上下文条数，驱动输入区上方的可见提示 */
  syncContextCount() {
    const contextCount = buildHistory(this.data.messages).length;
    if (contextCount !== this.data.contextCount) this.setData({ contextCount });
  },

  clearTopicTimer() {
    if (this._idleTimer !== null) clearTimeout(this._idleTimer);
    this._idleTimer = null;
  },

  /** 恢复页面就检查，停留期间用单个定时器更新；发送按钮不再隐式切换超时话题。 */
  refreshTopicBoundary() {
    this.clearTopicTimer();
    if (!this._visible || !this.data.currentPet || this.data.aiThinking || this.data.flowRunning || this.data.editorVisible
      || Object.values(this._savingDrafts || {}).some(Boolean)) return;
    const last = this.data.messages.slice().reverse().find((m) => !isDivider(m));
    if (!last || !Number.isFinite(last.time)) return;
    const resumedAt = this._session?.clientId === this._resumedClientId ? this._resumedAt : 0;
    const remaining = Math.max(last.time, resumedAt) + SESSION_GAP_MS - Date.now();
    if (remaining <= 0) {
      this.startNewSession(true);
      return;
    }
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this.refreshTopicBoundary();
    }, remaining);
  },

  /** 开启新话题：旧会话先补上标题与摘要再同步（仍在目录里可翻阅），本机槽位留给新会话 */
  startNewSession(auto = false) {
    this.clearTopicTimer();
    const petId = this.data.currentPet?.id;
    const old = this._session;
    if (petId && old && this.data.messages.some((m) => !isDivider(m))) {
      old.messages = this.data.messages;
      old.version = this.data.sessionVersion;
      this.finalizeSession(petId, old); // 只推云端，不写回当前会话槽位
    }
    this._session = newSession();
    this._session.messages = [makeDivider(auto)];
    if (petId) saveLocalSession(petId, this._session);
    this.setData({ messages: this._session.messages, sessionId: '', sessionVersion: 0, messageCapped: false });
    this.syncContextCount();
    this.scrollToBottom();
  },

  /** 顺序同步到云端；版本冲突保留本机内容，交给用户重新打开话题。 */
  async syncSession(session?: ChatSession, sessionPetId?: string) {
    if (this._disposed) return;
    const petId = sessionPetId || this.data.currentPet?.id;
    const target = session || this._session;
    const scope = JSON.stringify(getCloudSession());
    const epoch = getCloudSessionEpoch();
    if (!petId || !target || !getCloudSession()) return;
    this._syncPending++;
    // 同一页面的保存按顺序执行，避免用户消息和 AI 回复同时以旧版本覆盖彼此。
    const work = this._syncTail.catch(() => {}).then(async () => {
      if (this._disposed || getCloudSessionEpoch() !== epoch || JSON.stringify(getCloudSession()) !== scope) return;
      const current = this._session;
      const active = current?.clientId === target.clientId && this.data.currentPet?.id === petId;
      const source = active ? current! : target;
      const snapshot = { ...source, messages: source.messages.slice() };
      try {
        const saved = await pushSession(petId, snapshot, false);
        target.id = saved.id;
        target.version = saved.version;
        if (this._disposed || getCloudSessionEpoch() !== epoch || JSON.stringify(getCloudSession()) !== scope) return;
        if (this._session?.clientId === target.clientId && this.data.currentPet?.id === petId) {
          this._session.id = saved.id;
          this._session.version = saved.version;
          this.setData({ sessionId: saved.id, sessionVersion: saved.version });
          saveLocalSession(petId, this._session);
        }
      } catch (err: any) {
        if (this._session?.clientId !== target.clientId || this.data.currentPet?.id !== petId) return;
        Toast({ context: this, selector: '#t-toast', message: String(err?.code) === 'CONFLICT'
          ? '另一台设备更新了话题，本机内容已保留，请重新打开话题后继续' : err.message || '会话同步失败', theme: 'error' });
      }
    }).finally(() => { this._syncPending--; });
    this._syncTail = work;
    await work;
  },

  /**
   * 会话收尾：生成标题与摘要后再同步到云端。
   * 只在「会话被放下」时调用（开新话题、切换宠物），不打断正在进行的聊天。
   */
  async finalizeSession(petId: string, session: ChatSession) {
    if (this._disposed || !session.messages.length) return;
    const epoch = getCloudSessionEpoch();
    const lines = session.messages
      .filter((m) => m.kind === 'text' && m.text)
      .slice(-40)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`);
    if (!lines.length) return;
    try {
      const meta = await generateSessionMeta(getModelConfig(), session, lines);
      if (this._disposed || epoch !== getCloudSessionEpoch()) return;
      if (!session.title && meta.title) session.title = meta.title;
      if (meta.summary) session.summary = meta.summary;
      // 只有当它还是当前会话时才写本机槽位，否则只推云端
      if (session === this._session) saveLocalSession(petId, session);
      await this.syncSession(session, petId);
      this.refreshSessionIndex();
    } catch (e) { /* 收尾失败不影响会话本身，摘要下次再补 */ }
  },

  onNewTopic() {
    if (this.data.flowRunning && !this._flowAction) return;
    if (this.data.aiThinking) return;
    if (!this.data.messages.some((m) => !isDivider(m))) {
      Toast({ context: this, selector: '#t-toast', message: '已经是新话题啦，直接说就好' });
      return;
    }
    this.startNewSession();
  },

  /* ---------- 会话目录 ---------- */

  onToggleSessionList() {
    if (this.data.flowRunning) return;
    this.setData({ sessionListVisible: !this.data.sessionListVisible });
  },

  async onOpenSession(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset;
    const petId = this.data.currentPet?.id;
    if (!petId || !id || id === this.data.sessionId) {
      this.setData({ sessionListVisible: false });
      return;
    }
    wx.showLoading({ title: '打开会话…', mask: true });
    this.clearTopicTimer();
    this.cancelGeneration();
    const active = this._session;
    try {
      const session = await readSession(petId, id);
      if (this._disposed) return;
      if (this.data.currentPet?.id !== petId || this._session !== active) return;
      saveLocalSession(petId, session);
      this._session = session;
      this._resumedClientId = session.clientId;
      this._resumedAt = Date.now();
      this.setData({
        messages: session.messages,
        sessionId: session.id,
        sessionVersion: session.version,
        sessionListVisible: false,
        messageCapped: session.messages.length >= MAX_MESSAGES,
      });
      this.syncContextCount();
      this.refreshTopicBoundary();
      this.scrollToBottom();
    } catch (err: any) {
      Toast({ context: this, selector: '#t-toast', message: err.message || '打开会话失败', theme: 'error' });
    } finally {
      wx.hideLoading();
      this.refreshTopicBoundary();
    }
  },

  onDeleteSession(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset;
    const petId = this.data.currentPet?.id;
    if (!petId || !id) return;
    Dialog.confirm({ context: this, selector: '#t-dialog', title: '删除这个会话？', content: '删除后无法恢复，已保存的日记不受影响。' })
      .then(async () => {
        await removeSession(petId, id);
        if (id === this.data.sessionId) {
          this.cancelGeneration();
          this._session = newSession();
          saveLocalSession(petId, this._session);
          this.setData({ messages: [], sessionId: '', sessionVersion: 0, messageCapped: false });
          this.syncContextCount();
          this.refreshTopicBoundary();
        }
        this.setData({ sessions: await listSessions(petId) });
      })
      .catch(() => {});
  },

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
    // 对话历史与取证窗口都以最后一个话题分隔条为界
    const history = buildHistory(historyMessages || this.data.messages);
    const conversation = buildHistory(historyMessages || this.data.messages, Infinity, true);
    // 本条没附图时，从本会话的未认领照片池补齐（先发图、后说「记一下」也能带上图）
    const photoPool = savedPhotos.length ? savedPhotos : unclaimedPhotos(this.data.messages);
    const cfg = getModelConfig(); // 请求全程使用同一个配置快照
    const source = this.data.messages.slice().reverse().find((m: ChatMessage) => m.role === 'user' && m.text === text);
    const originalText = source?.sourceText !== undefined ? source.sourceText : text;
    const draftStatuses = this.data.messages.filter((m) => m.kind === 'draft' && m.draft && m.draft.text)
      .slice(-10).map((m) => ({ text: m.draft!.text, status: m.draft!.status }));
    try {
      const res = await runAgent(cfg, text, {
        pet, history, conversation, photos: photoPool, abortToken: scopedToken,
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
      this.assertActive(token, pet.id);
      const msgs: ChatMessage[] = res.drafts.map((d) => {
        if (d.rawInput?.text === text) d.rawInput.text = originalText;
        return this.toMessage({ kind: 'draft', draft: d, sourceText: originalText, sourcePhotos: savedPhotos }, 'tool');
      });
      if (trace) { if (!this._draftTraces) this._draftTraces = {}; msgs.forEach(m => { this._draftTraces[m.id] = trace; }); }
      if (res.reply || res.refs.length) msgs.push(this.toMessage({ kind: res.refs.length ? 'query' : 'text', text: res.reply || '', refs: res.refs }, 'tool'));
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
        this.assertActive(token, pet.id);
        const msgs: ChatMessage[] = [];
        if (out.draft) {
          const draft = validateDraft(out.draft, { text, petId: pet.id, photos: photoPool,
            userHistory: conversation.filter((m) => m.role === 'user') }, referenceDate);
          if (draft.rawInput.text === text) draft.rawInput.text = originalText;
          msgs.push(this.toMessage({ kind: 'draft', draft, sourceText: originalText, sourcePhotos: savedPhotos }, 'model'));
          trace?.emit('draft.validated', { path: 'json', date: draft.date, proposedDate: out.draft.date });
          if (trace) { if (!this._draftTraces) this._draftTraces = {}; this._draftTraces[msgs[msgs.length - 1].id] = trace; }
        }
        const historical = isHistoryQuery(text);
        const querying = (!!out.query || historical) && (!out.draft || hasExplicitQuestion(text));
        if (querying) {
          const options = out.query || resolveQueryOptions(text, {}, referenceDate);
          if (!out.query && !options.eventType && !options.keyword && !/记录|日记/.test(text)) throw new Error('请补充要查询的事件关键词');
          const result = queryRecords({ ...options, petId: pet.id });
          trace?.emit('query.result', { path: 'json', ...options, matched: result.totalMatched, records: result.records.map(r => ({ id: r.id, date: r.date })) });
          msgs.push(this.toMessage({ kind: 'query', text: result.summary, refs: result.refs }, 'model'));
        }
        if (!out.draft && !querying && out.reply) msgs.push(this.toMessage({ kind: 'text', text: out.reply }, 'model'));
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

  async refreshSessionIndex() {
    if (this._disposed) return;
    const epoch = getCloudSessionEpoch();
    const petId = this.data.currentPet?.id;
    if (!petId) return;
    try {
      const sessions = await listSessions(petId);
      if (!this._disposed && epoch === getCloudSessionEpoch()) this.setData({ sessions });
    } catch (e) { /* 忽略 */ }
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

  /* ---------- 待保存卡片 ---------- */

  findDraft(key: string): number {
    return this.data.messages.findIndex((m) => m.draft && m.draft.key === key);
  },

  /**
   * 照片回填：本机路径照旧用于本机展示，同时记下已上传的 fileId，
   * 这样「保存到日记的那张图」会出现在跨设备的同一条聊天里。
   */
  backfillPhotoIds(localPaths: string[], cloudIds: string[]) {
    if (!this._session || localPaths.length !== cloudIds.length) return;
    const toId = (p: string) => {
      const i = localPaths.indexOf(p);
      if (i >= 0 && cloudIds[i]) return cloudIds[i];
      return p.indexOf('cloud://') === 0 ? p : '';
    };
    // 视图数组是本地真源：回填后同步给会话，随后的 persist 会带着 fileId 再同步一次
    this.data.messages.forEach((m) => {
      if (m.photos && m.photos.some(toId)) m.photoIds = m.photos.map(toId);
      const d = m.draft;
      if (!d) return;
      if (d.photos && d.photos.some(toId)) d.photoIds = d.photos.map(toId);
      if (d.rawInput && d.rawInput.photos) d.rawInput.photos = d.rawInput.photos.map(toId).filter(Boolean);
    });
    this._session.messages = this.data.messages;
  },

  async onCardSave(e: WechatMiniprogram.CustomEvent) {
    if (this.data.flowRunning && !this._flowAction) return;
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
    const trace: TraceHandle | undefined = this._draftTraces?.[key] || beginTrace({ path: 'manual' });
    trace?.emit('save.start', { date: draft.date });
    try {
      this._savingDrafts = { ...this._savingDrafts, [key]: true };
      this.clearTopicTimer();
      const scope = JSON.stringify(getCloudSession());
      const currentPetId = this.data.currentPet?.id;
      // 会话同步后照片以云端 fileId 为准（photoIds），本地路径才需要落盘
      const photoInputs = draft.photos.map((path, i) => draft.photoIds?.[i] || path);
      const savedPhotos = await persistPhotos(photoInputs);
      if (scope !== JSON.stringify(getCloudSession())) throw new Error('家庭空间已切换，请重试');
      const rec = await addRecord({
        petId: draft.petId,
        date: draft.date,
        text: draft.text,
        tags: draft.tags,
        photos: savedPhotos,
        rawInput: draft.rawInput || { text: draft.text, photos: draft.photoIds || draft.photos, provenance: 'legacy' },
        mode,
        clientId: key,
      });
      trace?.finish('saved', { date: rec.date, records: [{ id: rec.id, date: rec.date }] });
      // 保存成功 = 照片才正式上云：回填云端 fileId，这条聊天在别的设备也能显示同一张图
      const cloudIds = cloudFileIds(savedPhotos);
      if (cloudIds.some(Boolean)) this.backfillPhotoIds(savedPhotos, cloudIds);
      if (scope === JSON.stringify(getCloudSession()) && currentPetId === this.data.currentPet?.id && this.data.messages[idx]?.draft?.key === key) {
        this.updateDraft(idx, { status: 'saved', recordId: rec.id });
      }
      if (cloudIds.some(Boolean)) this.persist(); // 让会话带着云端照片再同步一次
    } catch (err: any) {
      trace?.finish('save_failed', { error: traceError(err) });
      if (this.data.messages[idx]?.draft?.key === key) this.updateDraft(idx, { status: 'failed' });
      Toast({ context: this, selector: '#t-toast', message: err.message || '保存失败，请重试', theme: 'error' });
    } finally {
      delete this._savingDrafts[key];
      this.refreshTopicBoundary();
    }
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
