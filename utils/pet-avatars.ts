import type { Pet } from './store';

export const AVATAR_OPTIONS = [
  { id: 'cat-cream-orange', label: '奶油橘猫', species: '猫', src: '/assets/pets/cat-cream-orange.png' },
  { id: 'cat-british-longhair-gray', label: '灰毛英长', species: '猫', src: '/assets/pets/cat-british-longhair-gray.png' },
  { id: 'dog-cream', label: '奶油小狗', species: '狗', src: '/assets/pets/dog-cream.png' },
  { id: 'other-paw', label: '小爪印', species: '其他', src: '/assets/pets/other-paw.png' },
];
export function avatarOptions(species: string) {
  return AVATAR_OPTIONS.filter(option => option.species === species);
}
export function avatarIdFor(pet: Pick<Pet, 'species' | 'avatarId'>): string {
  const choices = avatarOptions(pet.species);
  return choices.find(option => option.id === pet.avatarId)?.id || choices[0]?.id || 'other-paw';
}
export function petAvatar(pet: Pick<Pet, 'species' | 'avatarId' | 'avatar'>): string {
  if (!pet.avatarId && pet.avatar) return pet.avatar;
  return AVATAR_OPTIONS.find(option => option.id === avatarIdFor(pet))!.src;
}
