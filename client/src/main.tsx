import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { onDeepLink } from "./lib/deepLink.ts";
import { onBackendStatus } from "./lib/hostBackend.ts";
import { useHostStore } from "./store/hostStore.ts";
import { useUiStore } from "./store/uiStore.ts";
import { hydrateSession } from "./lib/auth.ts";

// `jaroku://` links, subscribed to here rather than inside a component.
//
// A COMPONENT WOULD BE WRONG FOR THIS ONE, and the reason is the case the shell holds a queue
// for: a link that started the application arrives before React has mounted anything, and the
// shell keeps it until something asks. Whatever asks has to exist for the whole life of the page,
// or a remount would drain a queue and then unsubscribe from the event that follows it. This
// module is that thing, and it is also the reason `onDeepLink` is idempotent about being called
// once — it is called once.
//
// IT ACTS ON ONE ACTION AND LOGS THE REST. What a link MEANS is mostly a specification's own
// business — redeeming a magic link and finishing an OAuth round trip are the auth spec's — and
// `parseDeepLink` has already done the part that belongs here: proved the scheme, matched the
// action against a list, and refused everything it did not recognise. `billing` is the exception,
// because its meaning is entirely about this window: somebody left for a payment page and needs to
// be looking at the screen that says whether it worked. In a browser this call does nothing at all
// and returns a no-op.
onDeepLink((link) => {
  console.log(`[jaroku] deep link: ${link.action}${link.path.map((s) => `/${s}`).join("")}`);

  // THE CHECKOUT'S RETURN LEG, and the only action this file acts on rather than logs.
  //
  // Somebody paid in the system browser, a Jaroku-owned page redirected here, and the operating
  // system woke this window. What they need is to be looking at the screen that will tell them
  // whether it worked — so the panel opens on Billing, which polls
  // `GET /v1/billing/subscription` until the webhook has landed.
  //
  // BOTH HALVES OPEN THE SAME SCREEN, and `canceled` is not a special case worth branching on: the
  // honest thing to show somebody who backed out of a payment form is their plan, unchanged, which
  // is what that screen says. A separate "no changes made" state would be a second surface saying
  // less.
  //
  // NOTHING IS BELIEVED FROM THE LINK ITSELF. Its arrival means somebody came back, not that a
  // payment settled — any program on this machine can open a `jaroku://` URL. The tier moves when
  // the webhook says so and the poll agrees, which is why there is no `setTier` here.
  if (link.action === "billing") {
    useUiStore.getState().openWorkspacePanel("billing");
  }
});

// WHAT THE HOST SAYS ABOUT ITS BACKEND, subscribed here for the same reason and one more.
//
// The reason it shares: the shell settles its status during startup, which is before React has
// mounted anything, so a subscriber that lived inside a component would miss the status on
// exactly the launches that failed early — and those are the launches this exists for.
//
// The reason of its own: this is also where the socket URL gets corrected. The shell re-resolves
// the backend's port when a restart finds the old one taken, every status carries the current
// one, and `onBackendStatus` applies it. A subscription that unmounted would be a page still
// pointed at a port nothing is listening on.
onBackendStatus((status) => {
  useHostStore.getState().setStatus(status);
  console.log(`[jaroku] backend ${status.phase}${status.message ? `: ${status.message}` : ""}`);
});

// THE SESSION IS LOADED BEFORE THE FIRST RENDER, and this is the only reason `main.tsx` is not
// three lines any more.
//
// In a browser this resolves without doing anything: `localStorage` is synchronous and there is
// nothing to wait for. Under a host with a credential store it is one round trip, and it has to
// happen HERE rather than inside a component: `sessionStore`'s bootstrap reads the token while
// deciding whether to connect, and reading it a millisecond early would show the sign-in screen
// to somebody who is signed in and then never re-read. A promise chain rather than a top-level
// `await`, so the entry module needs nothing of the bundler's output target.
//
// `.finally` and not `.then`: a credential store that refuses to answer must not cost the whole
// application. The app renders, the session is absent, and the sign-in screen — which is the
// truthful state — is what appears.
void hydrateSession().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
