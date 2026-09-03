import { useState } from "react";
import type { JSX } from "react";

import { formatUptime } from "../shell/routes/gatewayData.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";

export default function RestartGatewayScreen({
  gatewayLabel,
  uptimeMs,
  onRestart,
  onCancel,
}: {
  gatewayLabel: string;
  uptimeMs?: number;
  onRestart: () => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const result = await onRestart();
      if (!result.ok) setError(result.error ?? "Restart was refused.");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : String(caughtError)
      );
    } finally {
      setPending(false);
    }
  };

  const facts: PanelFact[] = [
    { key: "out of reach for", mono: true, value: "about 20 seconds" },
    {
      key: "running now",
      mono: true,
      value: uptimeMs === undefined ? "——" : `up ${formatUptime(uptimeMs)}`,
    },
    {
      key: "what it will not fix",
      mono: true,
      value: "a disk that is full",
      net: true,
    },
  ];
  if (error !== null) facts.push({ key: "refused", net: true, value: error });

  return (
    <>
      <PanelBlock
        action={{
          filled: true,
          label: pending ? "Restarting…" : "Restart it",
          onClick: () => void restart(),
        }}
        action2={{ label: "Not now", onClick: onCancel }}
        body="Nothing is written during a restart, and nothing in the vault is touched. Apps show “reconnecting” for about twenty seconds; anything mid-upload resumes from where it stopped."
        eyebrow="Restart"
        facts={facts}
        title="Every app reconnects on its own"
        {...(error === null ? {} : { tone: "net" as const })}
        wide
      />
      <NoteBlock>
        {`This restarts the daemon on ${gatewayLabel}, not the machine. Your records are on its disk either way — what stops and starts again is the process that reads them.`}
      </NoteBlock>
    </>
  );
}
