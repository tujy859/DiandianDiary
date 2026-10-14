import ActionSheet from 'tdesign-miniprogram/action-sheet/index';
import type { Pet } from './store';
import { petAvatar } from './pet-avatars';

export function showPetPicker(context: any, pets: Pet[]) {
  if (!pets.length) return;
  ActionSheet.show({ theme: 'list', selector: '#t-action-sheet', context,
    items: pets.map(p => ({ label: p.name, icon: petAvatar(p) })).concat([{ label: '添加宠物', icon: 'add' }]),
  });
}
