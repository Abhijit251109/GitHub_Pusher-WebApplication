import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.githubprojectpusher.app',
  appName: 'GitHub Project Pusher',
  webDir: 'public',
  server: {
    url: process.env.GPP_APP_URL || 'https://github-pusher-g3ac.onrender.com',
    cleartext: process.env.GPP_APP_URL?.startsWith('http://') ?? false
  }
};

export default config;
