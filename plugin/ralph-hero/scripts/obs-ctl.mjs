#!/usr/bin/env node
// obs-ctl.mjs — OBS WebSocket v5 controller for record-demo skill
// Usage: node obs-ctl.mjs <status|start|stop> [--port 4455]

import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const globalModules = '/Users/dubiel/.local/share/mise/installs/node/22.22.1/lib/node_modules';

const { default: OBSWebSocket } = await import(
  pathToFileURL(`${globalModules}/obs-websocket-js/dist/json.js`).href
);

const command = process.argv[2];
const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? process.argv[portIdx + 1] : '4455';

if (!['status', 'start', 'stop'].includes(command)) {
  console.error('Usage: obs-ctl.mjs <status|start|stop> [--port PORT]');
  process.exit(1);
}

const obs = new OBSWebSocket();

try {
  await obs.connect(`ws://localhost:${port}`);

  if (command === 'status') {
    const status = await obs.call('GetRecordStatus');
    console.log(JSON.stringify(status, null, 2));
  } else if (command === 'start') {
    await obs.call('StartRecord');
    console.log('Recording started.');
  } else if (command === 'stop') {
    const result = await obs.call('StopRecord');
    console.log('Recording stopped.');
    if (result?.outputPath) console.log('Saved to:', result.outputPath);
  }

  await obs.disconnect();
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
