// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AskTypingProps {
  /** No props — a self-contained animated indicator. */
  _?: never;
}

/** The three-dot "assistant is thinking" indicator. */
export function AskTyping(_props: AskTypingProps) {
  return (
    <div className="kit-ask-typing">
      <i />
      <i />
      <i />
    </div>
  );
}
