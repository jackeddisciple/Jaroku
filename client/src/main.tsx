import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { onDeepLink } from "./lib/deepLink.ts";

// `jaroku://` links, subscribed to here rather than inside a component.
//
// A COMPONENT WOULD BE WRONG FOR THIS ONE, and the reason is the case the shell holds a queue
// for: a link that started the application arrives before React has mounted anything, and the
// shell keeps it until something asks. Whatever asks has to exist for the whole life of the page,
// or a remount would drain a queue and then unsubscribe from the event that follows it. This
// module is that thing, and it is also the reason `onDeepLink` is idempotent about being called
// once — it is called once.
//
// AND IT ONLY LOGS, DELIBERATELY. What a link MEANS — redeeming a magic link, finishing an OAuth
// round trip — is the auth specification's, and `parseDeepLink` has already done the part that
// belongs here: proved the scheme, matched the action against a list, and refused everything it
// did not recognise. In a browser this call does nothing at all and returns a no-op.
onDeepLink((link) => {
  console.log(`[jaroku] deep link: ${link.action}${link.path.map((s) => `/${s}`).join("")}`);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
