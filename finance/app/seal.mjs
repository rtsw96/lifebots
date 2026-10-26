// Seal a snapshot for the approved devices. Run by finance/bot/app_sync.py:
//   echo '{"devices":[{"id":..,"pub":{"x":..,"y":..}}],"data":{...}}' | node seal.mjs
// Prints the sealed JSON. Plaintext only ever passes through this process's memory.
import { fingerprint, seal } from "./public/crypto.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { devices, data } = JSON.parse(input);
if (!Array.isArray(devices) || !devices.length) {
  console.error("seal: no approved devices");
  process.exit(2);
}
// The bot checks each key against the fingerprint the owner approved.
for (const d of devices) {
  if (d.fingerprint && (await fingerprint(d.pub)) !== d.fingerprint) {
    console.error(`seal: device ${d.id} key doesn't match its approved fingerprint`);
    process.exit(3);
  }
}
process.stdout.write(JSON.stringify(await seal(data, devices)));
