export interface HomeStatusFacts {
  total: number;
  capped: boolean;
  settled: boolean;
  gatewayName: string | undefined;
  offline: boolean;
}

const count = (n: number): string => n.toLocaleString();

function thingsClause(facts: HomeStatusFacts): string {
  if (!facts.settled) return "Counting what is in this vault…";
  const noun = facts.total === 1 && !facts.capped ? "thing" : "things";
  const lead = facts.capped ? "At least " : "";
  return `${lead}${count(facts.total)} ${noun} in this vault.`;
}

export function statusSentence(facts: HomeStatusFacts): string {
  const things = thingsClause(facts);
  if (!facts.gatewayName)
    return `${things} No gateway is paired with this phone.`;
  if (facts.offline)
    return `${things} Offline — changes sync when ${facts.gatewayName} is back.`;
  return `${things} Backups run on ${facts.gatewayName}.`;
}
