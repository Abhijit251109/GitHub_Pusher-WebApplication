import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const androidDir = path.join(root, 'android');
function run(command, args, cwd = root) {
  console.log(`> ${command} ${args.join(' ')}`);
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map(value => `"${String(value).replaceAll('"', '""')}"`).join(' ');
    execFileSync(commandLine, { cwd, stdio: 'inherit', shell: true });
    return;
  }
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: false });
}
if (!fs.existsSync(androidDir)) run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'cap', 'add', 'android']);
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'cap', 'sync', 'android']);
const gradleBat = path.join(androidDir, 'gradlew.bat');
const gradlew = path.join(androidDir, 'gradlew');
if (process.platform === 'win32') {
  if (fs.existsSync(gradleBat)) run(gradleBat, ['assembleDebug'], androidDir);
  else run('gradle.bat', ['assembleDebug'], androidDir);
} else if (fs.existsSync(gradlew)) run('sh', [gradlew, 'assembleDebug'], androidDir);
else run('gradle', ['assembleDebug'], androidDir);
