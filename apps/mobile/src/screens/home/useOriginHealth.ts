import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { readCustodyStatus } from "../../kit/storage/custody-status";
import { readTransferQueue } from "../../kit/transfer/transfer-queue";
import { originHealthSignal } from "./origin-health";
import type { OriginHealthSignal } from "./origin-health";

export function useOriginHealth(): OriginHealthSignal {
  const { gatewayBase, online } = useReplica();
  const [signal, setSignal] = useState<OriginHealthSignal>({
    copy: "Checking uploads…",
    tone: "quiet",
  });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const queue = readTransferQueue(gatewayBase ?? "http://127.0.0.1");
      const publish = (
        custody?: Awaited<ReturnType<typeof readCustodyStatus>>
      ): void => {
        if (active)
          setSignal(
            originHealthSignal({
              custody,
              online,
              paired: gatewayBase !== undefined,
              queue,
            })
          );
      };
      publish();
      if (gatewayBase && online)
        void readCustodyStatus(gatewayBase).then(publish);
      return () => {
        active = false;
      };
    }, [gatewayBase, online])
  );

  return signal;
}
