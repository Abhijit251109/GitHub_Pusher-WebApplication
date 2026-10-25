import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const templateActivity = path.join(root, 'native', 'android', 'app', 'src', 'main', 'java', 'com', 'githubprojectpusher', 'app', 'MainActivity.java');

/** Apply the deep-link callback handler to Capacitor's generated Android project. */
export function configureAndroidOAuth(androidDir = path.join(root, 'android')) {
  const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  const activityPath = path.join(androidDir, 'app', 'src', 'main', 'java', 'com', 'githubprojectpusher', 'app', 'MainActivity.java');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Android manifest not found at ${manifestPath}. Run the Capacitor Android setup first.`);
  }
  if (!fs.existsSync(templateActivity)) {
    throw new Error(`OAuth activity template not found at ${templateActivity}.`);
  }

  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const activityMatch = manifest.match(/<activity\b(?=[^>]*android:name="[^"]*MainActivity")[^>]*>[\s\S]*?<\/activity>/);
  if (!activityMatch) {
    throw new Error('Could not find the MainActivity entry in android/app/src/main/AndroidManifest.xml.');
  }

  let activity = activityMatch[0];
  if (!activity.includes('android:launchMode=')) {
    activity = activity.replace('<activity', '<activity android:launchMode="singleTask"');
  } else if (!/android:launchMode="singleTask"/.test(activity)) {
    activity = activity.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
  }

  if (!activity.includes('android:scheme="com.githubprojectpusher.app"')) {
    const deepLinkFilter = `\n            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="com.githubprojectpusher.app" android:host="auth" android:path="/callback" />\n            </intent-filter>`;
    activity = activity.replace('</activity>', `${deepLinkFilter}\n        </activity>`);
  }
  manifest = manifest.replace(activityMatch[0], activity);
  fs.writeFileSync(manifestPath, manifest);

  fs.mkdirSync(path.dirname(activityPath), { recursive: true });
  fs.copyFileSync(templateActivity, activityPath);
  console.log('Android OAuth deep-link callback configured.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureAndroidOAuth(process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'android'));
}
