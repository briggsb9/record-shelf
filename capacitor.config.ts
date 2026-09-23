import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.recordshelf.player",
  appName: "Record Shelf",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
};

export default config;
