import { LineChart } from '@centraid/blueprint-kit-ds';

// Daily vault balance, ten days trending upward.
const balance = [
  { x: 1, y: 2140 },
  { x: 2, y: 2205 },
  { x: 3, y: 2180 },
  { x: 4, y: 2310 },
  { x: 5, y: 2402 },
  { x: 6, y: 2388 },
  { x: 7, y: 2495 },
  { x: 8, y: 2570 },
  { x: 9, y: 2648 },
  { x: 10, y: 2790 },
];

// Daily step count — noisy, no clear trend.
const steps = [
  { x: 1, y: 8200 },
  { x: 2, y: 3100 },
  { x: 3, y: 11400 },
  { x: 4, y: 6700 },
  { x: 5, y: 9800 },
  { x: 6, y: 2400 },
  { x: 7, y: 12600 },
  { x: 8, y: 5200 },
  { x: 9, y: 10100 },
  { x: 10, y: 4300 },
];

export function BalanceTrend() {
  return <LineChart points={balance} width={480} height={140} label="Balance over 10 days" />;
}

export function StepsVolatile() {
  return <LineChart points={steps} width={480} height={140} label="Daily step count" />;
}
