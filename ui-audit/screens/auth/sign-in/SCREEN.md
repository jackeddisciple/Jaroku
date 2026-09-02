# SCREEN — Sign in

| | |
|---|---|
| **Screen ID** | `AUTH-01` |
| **Screen name** | Sign in |
| **Route / path** | none — rendered by `App.tsx` when `sessionStore` has no session |
| **Parent area** | Authentication |
| **Purpose** | Establish a session before any workspace data is fetched |
| **Primary user goal** | Get into the workspace |

## Entry points

- Launching the app with no stored session
- Signing out from the sidebar's user chip
- A session token expiring (adds a notice — see the `expired-session` state)

## Exit points

- **Sign in** → the workspace shell, or account onboarding for a user who has not completed it
- Terms of Service / Privacy Policy links (open externally via `lib/openExternal.ts`)

## Main content regions

1. A centred **wordmark** at `BRAND.screen` (26px) on a dotted canvas
2. `Welcome to Jaroku` at the `display` type step, with a two-line subtitle
3. A single elevated card holding the whole form
4. A footer line of legal links

## Data displayed

The card opens with a paragraph naming exactly what this issuer is:

> This server is running its own local issuer. The token it mints is real and is verified exactly
> the way a provider's is — but there is no password, so anyone who can reach this port can sign in
> as anyone. **Development only.**

This is the dev/local issuer. The auth methods available are fetched from `GET /v1/auth/methods`
(`lib/signIn.ts`), so a build with a real provider configured shows a different card.

## Interactive elements

| Element | Type | Notes |
|---|---|---|
| `you@example.com` | text input | required; autofocused |
| `Your name (optional)` | text input | becomes `users.display_name`, and the window title |
| `Sign in` | filled primary button | disabled-looking until the email field validates |
| Terms of Service · Privacy Policy | links | the only underlined text on the screen |

## Required permissions / plan restrictions

None. This screen exists before either concept applies.

## State list

| State | Screenshot | Notes |
|---|---|---|
| default | `default.png` | Clean first paint |
| filled | `filled.png` | Email entered; the button reads as enabled |
| expired session | `expired-session.png` | Adds a notice above the form — *the session token has expired* |
| submitting | — | `NOT CURRENTLY OBSERVABLE` — the local issuer answers in ~1ms |
| error | — | `IMPLEMENTED / NOT CURRENTLY OBSERVABLE` — `lib/signIn.ts` handles a failed mint |

## Interaction list

| Trigger | Response | State change | Navigation |
|---|---|---|---|
| Type an email | field fills | local | — |
| Click `Sign in` | `POST /v1/auth/dev-login` → `POST /v1/auth/session` → `POST /v1/ws-ticket` | session created, socket opens | to the shell |
| Click a legal link | opens in the OS browser | none | leaves the app |

## Related screens

- [`../../onboarding/account-onboarding/`](../../onboarding/account-onboarding/) — where a new user goes next
- [`../../workspace/shell/`](../../workspace/shell/) — where a returning user goes next

## Screenshot index

| File | State |
|---|---|
| `default.png` | Clean sign-in, no session |
| `filled.png` | Email entered |
| `expired-session.png` | After a token expiry |

## Implementation references

| Concern | File |
|---|---|
| Screen | `client/src/components/auth/AuthFlow.tsx` |
| Sign-in mechanics | `client/src/lib/signIn.ts`, `lib/signInTiming.ts` |
| Session store | `client/src/store/sessionStore.ts` |
| Token storage | `client/src/lib/sessionVault.ts` → OS credential store via `src-tauri/src/secrets.rs` |
| Server | `server/src/auth/` — `POST /v1/auth/dev-login`, `/v1/auth/session`, `/v1/auth/methods` |

---

## Observed defect

A **"Sign out" tooltip survives the sidebar that owned it.** After clicking sign-out, the sidebar
unmounts but its tooltip is still painted at the bottom-left of the sign-in screen. Reproduced
twice. Visible in `default.png` at (470, 1119).
