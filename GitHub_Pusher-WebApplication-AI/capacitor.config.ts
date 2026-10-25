import 'dotenv/config';
import type { CapacitorConfig } from '@capacitor/cli';

const appUrl = process.env.GPP_APP_URL || process.env.PUBLIC_BASE_URL || 'https://github-pusher-g3ac.onrender.com';

const config: CapacitorConfig = {
  appId: 'com.githubprojectpusher.app',
  appName: 'GitHub Pusher Studio',
  webDir: 'public',
  server: {
    url: appUrl,
    cleartext: appUrl.startsWith('http://')
  },
  android: {
    // Lets the hosted frontend identify the native wrapper without needing a JS bundler.
    appendUserAgent: 'GitHubProjectPusherAndroid'
  }
};

export default config;
