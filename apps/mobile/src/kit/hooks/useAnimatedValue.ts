import { useMemo } from "react";
import { Animated } from "react-native";

export function useAnimatedValue(initial: number): Animated.Value {
  return useMemo(() => new Animated.Value(initial), [initial]);
}
