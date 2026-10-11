// A provider key was just saved, rotated or revoked: tell every open app in the workspace now.
//
// WHETHER RUN CAN START IS DECIDED IN THE CLIENT, from the provider snapshot — and a socket otherwise
// receives that snapshot only when it connects. So a key added in Secrets left Run sending people
// straight back to Secrets until they restarted the app. index.ts calls this from the Secrets routes'
// `store` and `revoke`, which every write path (add, import, rotate, revoke) goes through.
//
// CAUGHT, because the write has already happened: a broadcast that failed must not turn a stored
// key into an error on screen.

import { PROVIDER_ENV_KEY } from "./providers.ts";

const PROVIDER_KEY_NAMES = new Set<string>(Object.values(PROVIDER_ENV_KEY));

export function providerKeyAnnouncer<C>(
  broadcast: (ctx: C) => Promise<void>,
  warn: (line: string) => void = console.warn,
): (ctx: C, name: string) => Promise<void> {
  return async (ctx, name) => {
    if (!PROVIDER_KEY_NAMES.has(name)) return;
    await broadcast(ctx).catch((err: unknown) => warn(`[providers] could not announce a change to ${name}: ${(err as Error).message}`));
  };
}
