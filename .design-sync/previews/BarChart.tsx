import { BarChart } from '@centraid/blueprint-kit-ds';

const spend = [
  { label: 'Groceries', value: 412 },
  { label: 'Rent', value: 1850 },
  { label: 'Transit', value: 96 },
  { label: 'Dining', value: 268 },
  { label: 'Utilities', value: 184 },
];

const weekly = [
  { label: 'Mon', value: 42 },
  { label: 'Tue', value: 88 },
  { label: 'Wed', value: 61 },
  { label: 'Thu', value: 74 },
  { label: 'Fri', value: 120 },
  { label: 'Sat', value: 95 },
  { label: 'Sun', value: 38, muted: true },
];

export function SpendByCategory() {
  return <BarChart items={spend} width={480} height={150} label="Spend by category" />;
}

export function WeeklyPartial() {
  return <BarChart items={weekly} width={480} height={150} label="Receipts this week" />;
}
