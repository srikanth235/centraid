import React from "react";
import {
  Text as ReactNativeText,
  TextInput as ReactNativeTextInput,
} from "react-native";
import type { TextInputProps, TextProps } from "react-native";

import { DYNAMIC_TYPE } from "../theme/dynamic-type";

/**
 * The app-wide text boundary. React Native's `defaultProps` mutation is not a
 * reliable default under the new architecture, so every text primitive gets
 * the bounded Dynamic Type policy at render time while callers can still
 * override either prop for a deliberate local surface.
 */
export const Text = React.forwardRef<
  React.ElementRef<typeof ReactNativeText>,
  TextProps
>((props, ref) => {
  return <ReactNativeText ref={ref} {...DYNAMIC_TYPE} {...props} />;
});

export const TextInput = React.forwardRef<
  React.ElementRef<typeof ReactNativeTextInput>,
  TextInputProps
>((props, ref) => {
  return <ReactNativeTextInput ref={ref} {...DYNAMIC_TYPE} {...props} />;
});

Text.displayName = "DynamicText";
TextInput.displayName = "DynamicTextInput";
