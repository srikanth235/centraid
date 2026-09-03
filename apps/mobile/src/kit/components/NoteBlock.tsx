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
