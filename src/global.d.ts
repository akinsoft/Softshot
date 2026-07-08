import type { SoftshotApi } from "./shared";

declare global {
  interface Window {
    softshot: SoftshotApi;
  }
}

export {};
