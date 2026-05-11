// Single source of truth for screen routes + their params.
// Each screen imports its own typed props off this list.

import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Home: undefined;
  AppDetail: { appId: string };
  Settings: undefined;
  MobileFallback: undefined;
};

export type RootScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;

declare global {
  // Makes `useNavigation()` infer the right list everywhere.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
