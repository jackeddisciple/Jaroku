// Generate the issuer signing key a hosted deployment shares across its replicas.
//
//   npm --prefix server run auth:key
//
// It prints one base64 line and nothing else, so it can be piped straight into a secret store:
//
//   flyctl secrets set JAROKU_AUTH_SIGNING_KEY="$(npm --prefix server run --silent auth:key)"
//
// IT IS NOT WRITTEN TO DISK, deliberately. A key that lands in a file is a key that gets committed,
// backed up, or left in a shell's history; the only copy that should exist is the one in the secret
// store, and re-running this makes a different key rather than recovering that one. Rotating it
// signs out every open session — which is the correct blast radius for a signing key and the reason
// nothing here does it automatically.

import { LocalIssuer } from "./localIssuer.ts";

console.log(LocalIssuer.generateKeyMaterial());
