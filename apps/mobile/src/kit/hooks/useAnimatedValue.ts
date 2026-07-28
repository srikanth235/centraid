// A stable `Animated.Value` that is safe to read during render.
//
// The familiar RN idiom is `useRef(new Animated.Value(x)).current`, but that has
// two problems: it allocates a throwaway `Animated.Value` on *every* render, and
// reading `.current` during render is exactly what the React compiler forbids
// (a ref read during render can silently produce a stale UI). `useMemo` keeps
// one legal render-time value for each initial position.

import { useMemo } from 'react';
import { Animated } from 'react-native';

export function useAnimatedValue(initial: number): Animated.Value {
  return useMemo(() => new Animated.Value(initial), [initial]);
}
