/*
 * 宠物切换面板：聊聊 / 时光册共用。
 * 之前两页各写一份 ActionSheet.show，参数虽然一致，但宿主页面环境不同
 * （聊聊有键盘、根节点有 tap 捕获），容易出现表现不一致，这里统一收敛。
 */
import ActionSheet from 'tdesign-miniprogram/action-sheet/index';
import { petEmoji, Pet } from './store';

const PICKER_SELECTOR = '#t-action-sheet';

/**
 * 弹出宠物切换面板
 * @param context 页面实例（this）
 * @param pets    宠物列表，为空时不弹
 */
export function showPetPicker(context: any, pets: Pet[]): void {
  if (!pets || !pets.length) return;
  ActionSheet.show({
    theme: 'list',
    selector: PICKER_SELECTOR,
    context,
    items: pets.map((p) => ({ label: `${petEmoji(p.species)} ${p.name}` })).concat([{ label: '＋ 添加宠物' }]),
  });
}
