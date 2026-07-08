import type { SoftshotApi } from "./shared.js";

type SoftshotGlobal = typeof globalThis & {
  softshot: SoftshotApi;
};

export function getSoftshotApi(): SoftshotApi {
  return (globalThis as SoftshotGlobal).softshot;
}
