/** DSH custom desktop: host-side slash command and prefix cache keepalive. */
import { installCacheKeepalive } from './cache-keepalive.mjs';

export const name = 'custom-desktop';
export const inject = ['llm', 'commands'];

export function apply(ctx) {
  installCacheKeepalive(ctx);
}
