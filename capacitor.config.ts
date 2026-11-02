import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.oleksandrkliuiev.mnemo',
  appName: 'Mnemo',
  webDir: 'dist',
  ios: {
    // The web app handles safe areas itself (viewport-fit=cover + env(safe-area-inset-*)).
    contentInset: 'never',
    scrollEnabled: true,
  },
}

export default config
