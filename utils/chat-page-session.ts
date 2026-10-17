/** 聊天页话题生命周期；共享原 Page 实例，不另建状态副本。 */
import Dialog from 'tdesign-miniprogram/dialog/index';
import Toast from 'tdesign-miniprogram/toast/index';
import { getCloudSession, getCloudSessionEpoch, getModelConfig } from './store';
import { ChatSession, MAX_MESSAGES, saveLocalSession, saveSessionSnapshot, newSession, pushSession, pullSession, listSessions, removeSession, generateSessionMeta, readSession } from './chat-store';
import { buildHistory, isDivider, makeDivider, SESSION_GAP_MS } from './context';

export const chatSessionMethods = {
  async syncSessions(this: any) {
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

  syncContextCount(this: any) {
    const contextCount = buildHistory(this.data.messages).length;
    if (contextCount !== this.data.contextCount) this.setData({ contextCount });
  },

  clearTopicTimer(this: any) {
    if (this._idleTimer !== null) clearTimeout(this._idleTimer);
    this._idleTimer = null;
  },

  refreshTopicBoundary(this: any) {
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

  startNewSession(this: any, auto = false) {
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

  async syncSession(this: any, session?: ChatSession, sessionPetId?: string) {
    if (this._disposed) return;
    const petId = sessionPetId || this.data.currentPet?.id;
    const target = session || this._session;
    const scope = JSON.stringify(getCloudSession());
    const epoch = getCloudSessionEpoch();
    if (!petId || !target || !getCloudSession()) return;
    target.dirty = true;
    target.localRevision = (target.localRevision || 0) + 1;
    if (this._session === target) saveLocalSession(petId, target);
    else saveSessionSnapshot(petId, target);
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
        target.dirty = target.localRevision !== snapshot.localRevision;
        if (this._disposed || getCloudSessionEpoch() !== epoch || JSON.stringify(getCloudSession()) !== scope) return;
        if (this._session?.clientId === target.clientId && this.data.currentPet?.id === petId) {
          this._session.id = saved.id;
          this._session.version = saved.version;
          this._session.dirty = this._session.localRevision !== snapshot.localRevision;
          this.setData({ sessionId: saved.id, sessionVersion: saved.version });
          saveLocalSession(petId, this._session);
        }
      } catch (err: any) {
        if (this._disposed || epoch !== getCloudSessionEpoch()) return;
        if (this._session?.clientId !== target.clientId || this.data.currentPet?.id !== petId) return;
        Toast({ context: this, selector: '#t-toast', message: String(err?.code) === 'CONFLICT'
          ? '话题存在冲突，本机内容已保留。点击话题目录中的当前话题，可另存为新话题' : err.message || '会话同步失败', theme: 'error' });
      }
    }).finally(() => { this._syncPending--; });
    this._syncTail = work;
    await work;
  },

  async finalizeSession(this: any, petId: string, session: ChatSession) {
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

  onNewTopic(this: any) {
    if (this.data.flowRunning && !this._flowAction) return;
    if (this.data.aiThinking) return;
    if (!this.data.messages.some((m) => !isDivider(m))) {
      Toast({ context: this, selector: '#t-toast', message: '已经是新话题啦，直接说就好' });
      return;
    }
    this.startNewSession();
  },

  onToggleSessionList(this: any) {
    if (this.data.flowRunning) return;
    this.setData({ sessionListVisible: !this.data.sessionListVisible });
  },

  async onOpenSession(this: any, e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset;
    const petId = this.data.currentPet?.id;
    if (!petId || !id) {
      this.setData({ sessionListVisible: false });
      return;
    }
    if ((id === this.data.sessionId || id === `local:${this._session?.clientId}`) && this._session?.dirty) {
      const active = this._session;
      const epoch = getCloudSessionEpoch();
      try {
        await Dialog.confirm({ context: this, selector: '#t-dialog', title: '保留为新话题？',
          content: '此话题有未同步内容。将本机内容另存为新话题，原云端话题保留。', confirmBtn: '另存新话题', cancelBtn: '继续保留本机' });
        if (this._disposed || this._session !== active || epoch !== getCloudSessionEpoch()) return;
        this._session = { ...newSession(), title: active.title, summary: active.summary, messages: active.messages };
        this.setData({ sessionId: '', sessionVersion: 0, sessionListVisible: false });
        this.persist();
      } catch (_) { /* 取消保留本机内容 */ }
      return;
    }
    if (id === this.data.sessionId) { this.setData({ sessionListVisible: false }); return; }
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

  onDeleteSession(this: any, e: WechatMiniprogram.TouchEvent) {
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

  async refreshSessionIndex(this: any) {
    if (this._disposed) return;
    const epoch = getCloudSessionEpoch();
    const petId = this.data.currentPet?.id;
    if (!petId) return;
    try {
      const sessions = await listSessions(petId);
      if (!this._disposed && epoch === getCloudSessionEpoch()) this.setData({ sessions });
    } catch (e) { /* 忽略 */ }
  }
};
