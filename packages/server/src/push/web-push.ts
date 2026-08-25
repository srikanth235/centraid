import webPush from "web-push";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { endpointHostIsPublicSync } from "./endpoint-guard.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Generate once and keep the self-hoster's VAPID identity in mode-0600 gateway.db. */
export function webPushVapidKeys(database: GatewayDatabase): VapidKeys {
  const present = database.db
    .prepare(
      "SELECT public_key AS publicKey, private_key AS privateKey FROM web_push_vapid WHERE singleton = 1"
    )
    .get() as VapidKeys | undefined;
  if (present)
    return {
      publicKey: present.publicKey,
      privateKey: present.privateKey,
    };
  const generated = webPush.generateVAPIDKeys();
  database.run(
    `INSERT INTO web_push_vapid
      (singleton, public_key, private_key, created_at)
     VALUES (1, ?, ?, ?)`,
    generated.publicKey,
    generated.privateKey,
    new Date().toISOString()
  );
  return generated;
}

export interface WebPushSender {
  sendWake: (deviceIds: ReadonlySet<string>) => Promise<void>;
  publicKey: () => string;
}

export function createWebPushSender(database: GatewayDatabase): WebPushSender {
  const keys = webPushVapidKeys(database);
  const vapidDetails = {
    subject: "https://centraid.dev",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  return {
    publicKey: () => keys.publicKey,
    async sendWake(deviceIds): Promise<void> {
      if (deviceIds.size === 0) return;
      const rows = database.db
        .prepare(
          `SELECT endpoint, p256dh, auth
             FROM web_push_registrations
            WHERE device_id IN (${[...deviceIds].map(() => "?").join(",")})`
        )
        .all(...deviceIds) as Array<{
        endpoint: string;
        p256dh: string;
        auth: string;
      }>;
      await Promise.all(
        rows.map(async (row) => {
          try {
            // Issue #865: rows persisted before the registration guard (or by
            // an older build) never get a wake POST when the endpoint is an
            // obvious non-https or reserved-range IP-literal target.
            if (!endpointHostIsPublicSync(row.endpoint)) return;
            await webPush.sendNotification(
              {
                endpoint: row.endpoint,
                keys: { auth: row.auth, p256dh: row.p256dh },
              },
              JSON.stringify({ centraid: "replica-wake" }),
              {
                TTL: 60,
                urgency: "normal",
                topic: "centraid-replica-wake",
                vapidDetails,
              }
            );
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              database.run(
                "DELETE FROM web_push_registrations WHERE endpoint = ?",
                row.endpoint
              );
          }
        })
      );
    },
  };
}
