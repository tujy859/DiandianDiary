/** 聊天页草稿保存协调；共享原 Page 实例，不另建状态副本。 */
import Dialog from 'tdesign-miniprogram/dialog/index';
import Toast from 'tdesign-miniprogram/toast/index';
import { getCloudSession, getCloudSessionEpoch, persistPhotos } from './store';
import { isValidDate } from './date';
import { addRecord, cloudFileIds } from './repository';
import { CloudError } from './cloud';
import { TraceHandle, beginTrace, traceError } from './debug-trace';
import { diarySaveFeedback } from './save-feedback';
import { SaveViewState, SaveProgress, saveProgressView } from './save-progress';

export const chatSaveMethods = {
  findDraft(this: any, key: string): number {
    return this.data.messages.findIndex((m) => m.draft && m.draft.key === key);
  },

  setSaveView(this: any, key: string, state?: SaveViewState) {
    const saveStates = { ...this.data.saveStates };
    if (state) saveStates[key] = state; else delete saveStates[key];
    this.setData({ saveStates });
  },

  backfillPhotoIds(this: any, localPaths: string[], cloudIds: string[]) {
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

  async onCardSave(this: any, e: WechatMiniprogram.CustomEvent) {
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
    const saveStartedAt = Date.now();
    const epoch = getCloudSessionEpoch();
    const currentPetId = this.data.currentPet?.id;
    const current = () => !this._disposed && epoch === getCloudSessionEpoch()
      && currentPetId === this.data.currentPet?.id && this.findDraft(key) >= 0;
    let progress: SaveProgress = { stage: 'local' };
    const onProgress = (next: SaveProgress) => {
      progress = next;
      if (current()) this.setSaveView(key, saveProgressView(next));
    };
    trace?.emit('save.start', { date: draft.date });
    try {
      this._savingDrafts = { ...this._savingDrafts, [key]: true };
      this.clearTopicTimer();
      onProgress(progress);
      const scope = JSON.stringify(getCloudSession());
      // 会话同步后照片以云端 fileId 为准（photoIds），本地路径才需要落盘
      const photoInputs = draft.photos.map((path, i) => draft.photoIds?.[i] || path);
      let savedPhotos: string[];
      try { savedPhotos = await persistPhotos(photoInputs); }
      catch (_) { throw new CloudError('PHOTO_READ', '照片读取失败'); }
      if (scope !== JSON.stringify(getCloudSession()) || epoch !== getCloudSessionEpoch()) throw new CloudError('SESSION_CHANGED', '家庭空间已切换，请重试');
      const rec = await addRecord({
        petId: draft.petId,
        date: draft.date,
        text: draft.text,
        tags: draft.tags,
        photos: savedPhotos,
        rawInput: draft.rawInput || { text: draft.text, photos: draft.photoIds || draft.photos, provenance: 'legacy' },
        mode,
        clientId: key,
        observe: trace?.emit,
        onProgress,
      });
      trace?.emit('save.finish', { status: 'saved', durationMs: Date.now() - saveStartedAt });
      trace?.finish('saved', { date: rec.date, records: [{ id: rec.id, date: rec.date }] });
      // 保存成功 = 照片才正式上云：回填云端 fileId，这条聊天在别的设备也能显示同一张图
      if (current()) {
        const cloudIds = cloudFileIds(savedPhotos);
        if (cloudIds.some(Boolean)) this.backfillPhotoIds(savedPhotos, cloudIds);
        this.updateDraft(this.findDraft(key), { status: 'saved', recordId: rec.id });
        this.setSaveView(key);
        if (cloudIds.some(Boolean)) this.persist(); // 让会话带着云端照片再同步一次
      }
    } catch (err: any) {
      trace?.emit('save.finish', { status: 'save_failed', durationMs: Date.now() - saveStartedAt, error: traceError(err) });
      trace?.finish('save_failed', { error: traceError(err) });
      if (current()) {
        const feedback = diarySaveFeedback(err, progress.stage);
        this.updateDraft(this.findDraft(key), { status: 'failed' });
        this.setSaveView(key, { busy: false, stage: progress.stage, label: feedback.title, detail: feedback.message, failureTitle: feedback.title });
        if (this._visible) Dialog.alert({ context: this, selector: '#t-dialog', title: feedback.title, content: feedback.message, confirmBtn: '知道了' });
      }
    } finally {
      delete this._savingDrafts[key];
      if (!this._disposed && !current()) this.setSaveView(key);
      this.refreshTopicBoundary();
    }
  }
};
