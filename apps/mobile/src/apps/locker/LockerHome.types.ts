export interface AuthResult {
  ok: boolean;
  configured: boolean;
  authenticated?: boolean;
  sessionToken?: string;
  itemToken?: string;
  credentialId?: string;
  retryAfterMs?: number;
  code?: string;
  message?: string;
}

export interface LockerRow {
  item_id: string;
  type: string;
  title: string;
  subtitle: string;
  favorite?: boolean;
  severity?: string;
}

export interface LockerItem extends LockerRow {
  username?: string | null;
  password?: string | null;
  url?: string | null;
  otp_seed?: string | null;
  notes?: string | null;
  cardholder?: string | null;
  card_number?: string | null;
  expiry?: string | null;
  cvv?: string | null;
  brand?: string | null;
  content?: string | null;
  fullname?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  network?: string | null;
}

export type ScreenState =
  | { kind: "loading" }
  | { kind: "locked"; configured: boolean; message?: string }
  | { kind: "ready"; items: LockerRow[]; refreshing: boolean }
  | { kind: "empty" }
  | { kind: "offline"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export interface ItemsResult {
  items?: LockerRow[];
  authRequired?: boolean;
  configured?: boolean;
  vaultDenied?: { message?: string };
}

export interface VisibleField {
  label: string;
  secret: boolean;
  value: string;
}

export function visibleFields(item: LockerItem): VisibleField[] {
  const fields: Array<{
    key: keyof LockerItem;
    label: string;
    secret?: boolean;
  }> = [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
    { key: "url", label: "Website" },
    { key: "otp_seed", label: "One-time-code seed", secret: true },
    { key: "notes", label: "Notes" },
    { key: "cardholder", label: "Cardholder" },
    { key: "card_number", label: "Card number", secret: true },
    { key: "expiry", label: "Expiry" },
    { key: "cvv", label: "CVV", secret: true },
    { key: "brand", label: "Brand" },
    { key: "content", label: "Secure note", secret: true },
    { key: "fullname", label: "Full name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "address", label: "Address" },
    { key: "network", label: "Network" },
  ];
  return fields.flatMap(({ key, label, secret = false }) => {
    const value = item[key];
    return typeof value === "string" && value.length > 0
      ? [{ label, secret, value }]
      : [];
  });
}
