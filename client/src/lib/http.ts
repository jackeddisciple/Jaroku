// One authenticated HTTP request, for the handful of surfaces that are not the socket.
//
// WHY THERE IS AN HTTP SURFACE AT ALL. Almost everything in this app is a WebSocket command. Four
// things cannot be: the credential exchange (a browser cannot put a header on a WebSocket), the
// Secrets group (elevation rides on a header too), a checkout (the answer is a URL the browser must
// navigate to), and the workspace's own export and deletion (what an export produces is a FILE a
// browser downloads, and a download is a request with a URL).
//
// WHY IT IS ONE FUNCTION. Two of those four have to attach the workspace to the query string,
// because the routes resolve their tenant through the same resolver `/v1/ws-ticket` uses and take
// it from `?workspace=`. Forgetting that is not a compile error — it is a request that succeeds
// against whichever workspace the server picks as the default, which for an EXPORT would mean
// handing somebody an archive of a workspace they did not ask about. So the scoping is here, once,
// rather than at each call site.
//
// The elevation header is deliberately NOT here: it is the Secrets surface's own credential, held
// in memory by `lib/secrets.ts` for reasons that file states at length, and it is passed in per
// call by the wrapper there.
//
// THE ORIGIN COMES FROM `auth.ts` AND USED TO BE COMPUTED HERE, and the difference was a real bug
// with a very confusing shape. This file's own version read `VITE_JAROKU_WS` and fell back to
// `ws://localhost:4317` — and never asked `hostConfig`, which is the only source that knows which
// port the desktop shell's backend actually got. So on any launch where 4317 was taken, the socket
// and the whole sign-in exchange went to the right port while the Secrets group, the checkout, the
// export and the workspace deletion went to 4317 — which is either nothing at all, or, far worse,
// somebody else's server holding that port. A window that signed in, connected, streamed a run,
// and then failed at four specific surfaces for no visible reason.
//
// One origin, one function, resolved per call. See `apiBase`.

import { AuthFailure, apiBase, storedToken, storedWorkspace } from "./auth.ts";

export interface RequestOptions {
  /** Extra headers for this one call. The Secrets surface's elevation token arrives this way. */
  headers?: Record<string, string>;
  /**
   * Whether to put this tab's workspace on the query string. Default true.
   *
   * The auth routes are the exception and they do not use this helper at all: a session request is
   * about a PERSON, and scoping it to a workspace would describe it wrongly.
   */
  scoped?: boolean;
}

/**
 * A request, with whatever this tab has to prove.
 *
 * Failures arrive as `AuthFailure`, the same shape `lib/auth.ts` throws, so the app's one
 * retry-versus-stop rule applies unchanged — status 0 and retryable is "could not reach the
 * server", a 401/403 is "stop", a 5xx or 429 is "try again".
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const token = storedToken();
  const workspace = opts.scoped === false ? null : storedWorkspace();
  const url = `${apiBase()}${path}${
    workspace ? `${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}` : ""
  }`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new AuthFailure((err as Error).message || "could not reach the server", 0, true);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

  let message = text.slice(0, 300);
  let code = "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    message = parsed?.error?.message ?? message;
    code = parsed?.error?.code ?? "";
  } catch {
    /* a body that is not our envelope; the status line says enough */
  }
  const failure = new AuthFailure(message || res.statusText, res.status, res.status >= 500 || res.status === 429);
  (failure as AuthFailure & { code?: string }).code = code;
  throw failure;
}

/** The error code the server sent, when it sent one. Lets a caller branch without parsing text. */
export function failureCode(err: unknown): string {
  return (err as { code?: string })?.code ?? "";
}
