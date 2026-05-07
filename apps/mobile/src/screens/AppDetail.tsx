import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { apps as BUILTIN_APPS } from '@centraid/design-tokens';
import type { AppMetaResolved } from '@centraid/design-tokens';
import AppHeader from '../components/AppHeader';
import { colors, spacing, t } from '../theme';
import type { RootScreenProps } from '../navigation';

import TodosApp from '../apps/todos';
import HabitsApp from '../apps/habits';
import JournalApp from '../apps/journal';
import FocusApp from '../apps/focus';
import PlantsApp from '../apps/plants';
import HydrateApp from '../apps/hydrate';
import GiftsApp from '../apps/gifts';
import MoodApp from '../apps/mood';

export interface AppComponentProps {
  app: AppMetaResolved;
}

const REGISTRY: Record<string, React.ComponentType<AppComponentProps>> = {
  focus: FocusApp,
  gifts: GiftsApp,
  habits: HabitsApp,
  hydrate: HydrateApp,
  journal: JournalApp,
  mood: MoodApp,
  plants: PlantsApp,
  todos: TodosApp,
};

export default function AppDetailScreen({
  navigation,
  route,
}: RootScreenProps<'AppDetail'>): React.JSX.Element {
  const { appId } = route.params;
  const app = BUILTIN_APPS.find((a) => a.id === appId);
  const Component = REGISTRY[appId];

  if (!app || !Component) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <AppHeader
          title="Not found"
          color={colors.ink3}
          iconKey="X"
          onBack={() => navigation.goBack()}
        />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>That app isn't available on mobile yet.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppHeader
        title={app.name}
        subtitle={app.desc}
        color={app.color}
        iconKey={app.iconKey}
        onBack={() => navigation.goBack()}
      />
      <Component app={app} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: spacing[5] },
  emptyText: { ...t('body'), color: colors.ink3 },
  safe: { backgroundColor: colors.bg, flex: 1 },
});
