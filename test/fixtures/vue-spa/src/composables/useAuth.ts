import { useUserStore } from '@/stores/user';

export function useAuth() {
  useUserStore();
  return {};
}
