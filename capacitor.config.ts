import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.githubprojectpusher.app',
  appName: 'GitHub Project Pusher',
  webDir: 'public',
  server: {
    url: process.env.GPP_APP_URL || 'http://10.0.2.2:4173',
    cleartext: process.env.GPP_APP_URL?.startsWith('http://') ?? false
  }
};

export default config;
