import type { DeviceCapabilities } from "@alpiplan/device-capabilities";

declare module "nuxt/schema" {
  interface RuntimeConfig {
    authCookie: string;
  }
  interface PublicRuntimeConfig {
    demoEmail: string;
    legalName: string;
    websiteUrl: string;
    supportEmail: string;
  }
  interface PageMeta {
    /** Route ohne Login (z. B. /login) */
    public?: boolean;
  }
}

declare module "#app" {
  interface NuxtApp {
    $device: DeviceCapabilities;
  }
}

declare module "vue" {
  interface ComponentCustomProperties {
    $device: DeviceCapabilities;
  }
}

export {};
