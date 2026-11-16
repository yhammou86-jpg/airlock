#!/usr/bin/env node
/**
 * Create a cloud pairing room on the relay and print everything you need.
 *
 *   npm run pair                       # relay http://localhost:8788, web http://localhost:5173
 *   npm run pair -- --relay https://airlock-relay.fly.dev --web https://airlock.vercel.app
 *   npm run pair -- --json             # machine readable
 *
 * The six digit code is single use and expires after 10 minutes. Either scan /
 * type it in the dashboard's "Cloud relay" tab, or open the printed deep link.
 */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const relay = String(arg('relay', process.env.AIRLOCK_RELAY || 'http://localhost:8788')).replace(/\/+$/, '');
const web = String(arg('web', process.env.AIRLOCK_WEB || 'http://localhost:5173')).replace(/\/+$/, '');
const name = String(arg('name', 'Android device'));
const json = !!arg('json', false);

let res;
try {
  res = await fetch(`${relay}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
} catch (err) {
  console.error(`Could not reach the relay at ${relay}.`);
  console.error('Start it with `npm run relay`, or pass --relay https://your-relay.example.');
  process.exit(1);
}
if (!res.ok) {
  console.error(`Relay refused the pairing request: HTTP ${res.status}`);
  process.exit(1);
}

const { code, room, token, expiresAt } = await res.json();
const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
const deepLink = `${web}/?relay=${encodeURIComponent(relay)}&code=${code}`;
const agentCommand = `node apps/agent/agent.mjs --cloud ${relay} --room ${room} --token ${token} --name "${name}"`;

if (json) {
  console.log(JSON.stringify({ code, room, token, relay, web, deepLink, expiresAt, agentCommand }, null, 2));
  process.exit(0);
}

console.log('');
console.log('  Airlock cloud pairing room');
console.log('  ─────────────────────────────────────────────────────────');
console.log(`  pairing code   ${code}   (single use, ${minutes} min)`);
console.log(`  room           ${room}`);
console.log(`  relay          ${relay}`);
console.log('');
console.log('  Open the dashboard with the code pre-filled:');
console.log(`  ${deepLink}`);
console.log('');
console.log('  Or start a demo device in this room:');
console.log(`  ${agentCommand}`);
console.log('');
