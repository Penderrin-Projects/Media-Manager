/**
 * Patch ssh2 library to use larger SSH channel window and packet sizes.
 * 
 * The ssh2 npm library hardcodes MAX_WINDOW=2MB and PACKET_SIZE=32KB in
 * lib/Channel.js. These tiny values cap SFTP throughput at ~10 MB/s on
 * fast connections because the SSH flow-control window stalls waiting for
 * adjustment ACKs. Native clients like FileZilla use 64MB+ windows.
 *
 * This postinstall script patches those constants to 8MB / 64KB,
 * which is enough to saturate a typical seedbox link.
 */

const fs = require('fs');
const path = require('path');

const channelPath = path.join(__dirname, 'node_modules', 'ssh2', 'lib', 'Channel.js');

if (!fs.existsSync(channelPath)) {
  console.log('[patch-ssh2] ssh2 Channel.js not found — skipping');
  process.exit(0);
}

let src = fs.readFileSync(channelPath, 'utf8');

const patches = [
  {
    name: 'PACKET_SIZE',
    from: "const PACKET_SIZE = 32 * 1024;",
    to:   "const PACKET_SIZE = 64 * 1024; // patched: 64KB (seedbox-safe max)",
  },
  {
    name: 'MAX_WINDOW',
    from: "const MAX_WINDOW = 2 * 1024 * 1024;",
    to:   "const MAX_WINDOW = 8 * 1024 * 1024; // patched: 8MB (optimal for WAN)",
  },
];

let applied = 0;
for (const p of patches) {
  if (src.includes(p.from)) {
    src = src.replace(p.from, p.to);
    applied++;
    console.log(`[patch-ssh2] Patched ${p.name}`);
  } else if (src.includes(p.to)) {
    console.log(`[patch-ssh2] ${p.name} already patched`);
  } else {
    console.log(`[patch-ssh2] WARNING: Could not find ${p.name} — ssh2 version may have changed`);
  }
}

if (applied > 0) {
  fs.writeFileSync(channelPath, src, 'utf8');
  console.log(`[patch-ssh2] Done — ${applied} patch(es) applied`);
} else {
  console.log('[patch-ssh2] No patches needed');
}
