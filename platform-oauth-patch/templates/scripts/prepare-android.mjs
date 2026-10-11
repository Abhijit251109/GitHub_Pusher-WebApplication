import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configureAndroidOAuth } from './configure-android-oauth.mjs';

const root = process.cwd();
const androidDir = path.join(root, 'android');
const capacitorCli = path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');

function run(command, args, cwd = root) {
  console.log(`> ${command} ${args.join(' ')}`);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    execFileSync(command, args, { cwd, stdio: 'inherit', shell: true });
    return;
  }
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

if (!fs.existsSync(androidDir)) run(process.execPath, [capacitorCli, 'add', 'android']);
run(process.execPath, [capacitorCli, 'sync', 'android']);
configureAndroidOAuth(androidDir);
