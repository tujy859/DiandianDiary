/** 仅用于当前页面的保存反馈，不写入草稿或会话。 */
export type SaveStage = 'local' | 'read' | 'authorize' | 'upload' | 'confirm' | 'photo-done' | 'save' | 'refresh';
export interface SaveProgress { stage: SaveStage; photoIndex?: number; photoTotal?: number }
export type SaveProgressObserver = (progress: SaveProgress) => void;
export function notifySaveProgress(observer: SaveProgressObserver | undefined, progress: SaveProgress) {
  try { observer?.(progress); } catch (_) { /* 反馈不能改变业务保存结果。 */ }
}
export interface SaveViewState { busy: boolean; label: string; detail: string; stage?: SaveStage; failureTitle?: string }

/** 原生 loading 标题空间有限；完整说明放在记录卡或错误弹窗。 */
export function saveLoadingTitle(progress: SaveProgress): string {
  return ({ local: '准备保存…', read: '读取照片…', authorize: '准备上传…', upload: '上传照片…',
    confirm: '云端确认…', 'photo-done': '照片已就绪', save: '保存日记…', refresh: '确认显示…' })[progress.stage];
}

export function saveProgressView(progress: SaveProgress): SaveViewState {
  const number = Number.isInteger(progress.photoIndex) && progress.photoTotal > 0
    ? `第 ${progress.photoIndex + 1} / ${progress.photoTotal} 张照片` : '照片';
  const labels: Record<SaveStage, string> = {
    local: '正在准备保存', read: `正在读取${number}`, authorize: `正在准备上传${number}`,
    upload: `正在上传${number}`, confirm: `正在云端确认${number}`,
    'photo-done': `${number}已就绪`, save: progress.photoTotal ? '照片已就绪，正在保存日记' : '正在保存日记', refresh: '日记已写入，正在确认显示',
  };
  return { busy: true, stage: progress.stage, label: labels[progress.stage],
    detail: progress.stage === 'confirm' ? '照片已上传，正在由云端校验。日记尚未保存。'
      : progress.stage === 'save' ? '正在写入时光册，请稍候。'
      : progress.stage === 'refresh' ? '即将完成，请稍候。'
      : '完成后会显示“已记入时光册”，请稍候。' };
}
