// Forked gateway for the idle-CPU and request-latency perf probe. The gateway
// runs in THIS child process so its idle cost is isolated from vitest's own
// event loop — `process.cpuUsage()` cannot cross processes, so the previous
// in-vitest measurement could never see the gateway's background timers at all.
//
// The child self-reports CPU with `process.cpuUsage()` bracketing a real idle
// window (≥5 s, longer than the ~1 s idle-poll period the low-end audit flagged)
// and hands the deltas back over IPC. That is portable (darwin + Linux) and
// honest: it measures exactly the process whose idle timers we care about.
import { serve } from '../../../packages/gateway/dist/index.js';

const root = process.argv[2];
if (!root) throw new Error('gateway idle fixture needs a root directory');

const handle = await serve({
  paths: { vaultDir: `${root}/vault`, prefsFile: `${root}/prefs.json` },
});

process.send?.({ type: 'ready', url: handle.url, token: handle.token });

process.on('message', async (message) => {
  if (message?.type === 'measure-idle') {
    const windowMs = Number(message.windowMs ?? 5000);
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    // Let the gateway sit fully idle: no requests, just its own timers.
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const cpu = process.cpuUsage(cpuStart);
    const wallMs = performance.now() - wallStart;
    process.send?.({
      type: 'idle',
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      wallMs,
    });
    return;
  }
  if (message?.type === 'close') {
    await handle.close();
    process.exit(0);
  }
});
