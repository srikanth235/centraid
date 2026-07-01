// Node worker_threads — `parentPort.postMessage` doesn't take a targetOrigin
// (that's only for window.postMessage). Silence the unicorn rule that assumes
// browser context.
/* eslint-disable unicorn/require-post-message-target-origin -- grandfathered pre-existing suppression (#247) */
import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';

try {
  const png = new Resvg(workerData.svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  parentPort.postMessage({ png });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
