// NOTE — the quiet sentence that explains the block group above it (#765).
//
// It is tertiary ink at the body rung, never small type: the note is read
// once and it has to be readable, so what recedes is its COLOUR, not its size.
// Copy is the caller's.

import React, { useMemo } from "react";

import { useTheme } from "../theme";
import { Text } from "./NativeText";
import { styles } from "./NoteBlock.styles";

export interface NoteBlockProps {
  text: string;
}

export default function NoteBlock({ text }: NoteBlockProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ color: colors.textFaint }), [colors]);
  return <Text style={[styles.text, ink]}>{text}</Text>;
}
