/** 仅用于当前页面的保存反馈，不写入草稿或会话。 */
export type SaveStage = 'local' | 'read' | 'authorize' | 'upload' | 'confirm' | 'photo-done' | 'save' | 'refresh';
export interface SaveProgress { stage: SaveStage; photoIndex?: number; photoTotal?: number }
export type SaveProgressObserver = (progress: SaveProgress) => void;
export function notifySaveProgress(observer: SaveProgressObserver | undefined, progress: SaveProgress) {
  try { observer?.(progress); } catch (_) { /* 反馈不能改变业务保存结果。 */ }
}
export interface SaveViewState { busy: boolean; label: string; detail: string; stage?: SaveStage; failureTitle?: string }

/** 日记编辑沿用同一份简短阶段文案，详细故障仍由错误弹窗说明。 */
export function saveLoadingTitle(progress: SaveProgress): string {
  return saveProgressView(progress).label.replace(/^正在/, '');
}

export function saveProgressView(progress: SaveProgress): SaveViewState {
  const count = Number.isInteger(progress.photoIndex) && progress.photoIndex >= 0
    && Number.isInteger(progress.photoTotal) && progress.photoTotal > 1 && progress.photoIndex < progress.photoTotal
    ? ` ${progress.photoIndex + 1}/${progress.photoTotal}` : '';
  // 保留原阶段给日志与失败分类，界面合并短暂的准备 / 校验步骤，不显示技术细节或模拟百分比。
  const label = progress.stage === 'upload' ? `正在上传照片${count}…` : '正在保存日记…';
  return { busy: true, stage: progress.stage, label, detail: '' };
}
