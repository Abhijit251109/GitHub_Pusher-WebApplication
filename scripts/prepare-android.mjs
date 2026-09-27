import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const androidDir = path.join(root, 'android');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args) {
  console.log(`> ${npx} ${args.join(' ')}`);
  execFileSync(npx, args, { cwd: root, stdio: 'inherit', shell: false });
}

if (!fs.existsSync(androidDir)) run(['--no-install', 'cap', 'add', 'android']);
run(['--no-install', 'cap', 'sync', 'android']);
