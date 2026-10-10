import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const gradleBat = path.join(androidDir, 'gradlew.bat');
const gradlew = path.join(androidDir, 'gradlew');
if (process.platform === 'win32' && fs.existsSync(gradleBat)) run(gradleBat, ['assembleDebug'], androidDir);
else if (fs.existsSync(gradlew)) run('sh', [gradlew, 'assembleDebug'], androidDir);
else run(process.platform === 'win32' ? 'gradle.bat' : 'gradle', ['assembleDebug'], androidDir);
