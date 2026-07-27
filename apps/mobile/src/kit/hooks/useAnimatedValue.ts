// A stable `Animated.Value` that is safe to read during render.
//
// The familiar RN idiom is `useRef(new Animated.Value(x)).current`, but that has
// two problems: it allocates a throwaway `Animated.Value` on *every* render, and
// reading `.current` during render is exactly what the React compiler forbids
// (a ref read during render can silently produce a stale UI). `useState`'s lazy
// initialiser gives the same "construct once, stable identity" guarantee while
// being a legal render-time read — the setter is never called, so the value can
// never change and can never trigger a re-render.

import { useState } from 'react';
import { Animated } from 'react-native';

export function useAnimatedValue(initial: number): Animated.Value {
  const [value] = useState(() => new Animated.Value(initial));
  return value;
}
