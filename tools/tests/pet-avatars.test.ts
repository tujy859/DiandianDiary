jest.mock('../../utils/repository', () => ({ savePet: jest.fn((input) => Promise.resolve(require('../../utils/store').savePet(input))) }));
import * as store from '../../utils/store';
import { petAvatar, avatarIdFor } from '../../utils/pet-avatars';
jest.mock('tdesign-miniprogram/dialog/index', () => ({ __esModule: true, default: {} }), { virtual: true });
jest.mock('tdesign-miniprogram/toast/index', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
let definition: any;
beforeAll(() => {
  (global as any).Page = (options: any) => { definition = options; };
  require('../../pages/mine/mine.ts');
});
beforeEach(() => (wx as any).clearStorageSync());
function page() {
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  instance.setData = (patch: any) => {
    for (const [key, value] of Object.entries(patch)) {
      const [parent, child] = key.split('.');
      if (child) instance.data[parent][child] = value;
      else instance.data[parent] = value;
    }
  };
  return instance;
}
test('编辑时选择英长、保存后重新进入表单仍保持所选头像', async () => {
  const pet = store.savePet({ name: '点点', species: '猫' });
  const instance = page(); instance.reload();
  instance.onEditPet({ currentTarget: { dataset: { id: pet.id } } });
  instance.onSelectAvatar({ currentTarget: { dataset: { id: 'cat-british-longhair-gray' } } });
  instance.onSelectSpecies({ currentTarget: { dataset: { value: '猫' } } });
  expect(instance.data.form.avatarId).toBe('cat-british-longhair-gray');
  await instance.onSavePet();
  expect(store.getPets()[0].avatarId).toBe('cat-british-longhair-gray');
  instance.onEditPet({ currentTarget: { dataset: { id: pet.id } } });
  expect(instance.data.form.avatarId).toBe('cat-british-longhair-gray');
  expect(instance.data.pets[0].avatar).toBe('/assets/pets/cat-british-longhair-gray.png');
});
test('切换物种不会继续保存猫头像，旧宠物和无效 ID 都有兼容的默认头像', () => {
  const instance = page(); instance.onAddPet();
  instance.onSelectAvatar({ currentTarget: { dataset: { id: 'cat-british-longhair-gray' } } });
  instance.onSelectSpecies({ currentTarget: { dataset: { value: '狗' } } });
  expect(instance.data.form.avatarId).toBe('dog-cream');
  instance.onSelectAvatar({ currentTarget: { dataset: { id: 'cat-cream-orange' } } });
  expect(instance.data.form.avatarId).toBe('dog-cream');
  expect(petAvatar({ species: '猫' })).toBe('/assets/pets/cat-cream-orange.png');
  expect(avatarIdFor({ species: '狗', avatarId: '../../file' })).toBe('dog-cream');
});

test('没有内置头像选择时显示已上传照片，显式选择内置头像后使用新选择', () => {
  expect(petAvatar({ species: '猫', avatar: 'https://signed.example/cat' })).toBe('https://signed.example/cat');
  expect(petAvatar({ species: '猫', avatar: 'https://signed.example/cat', avatarId: 'cat-british-longhair-gray' })).toBe('/assets/pets/cat-british-longhair-gray.png');
});
