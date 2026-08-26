// The three web pages, and the two rules about them that are easy to break and hard to notice.
//
// RULE ONE: THE PRICING PAGE SELLS NOTHING. Every call to action on it downloads the app — Free,
// Pro and Team alike — and a visitor who wants Pro upgrades from inside, where there is a workspace
// for a subscription to belong to. The failure this prevents is not a security hole; it is somebody
// adding a Stripe button here in six months because it looks like an obvious improvement, and
// thereby creating a SECOND place that has to get webhook linking, workspace association and every
// edge case right. The in-app flow already handles all of it correctly. Two of them would not stay
// correct.
//
// RULE TWO: THE RETURN PAGES GO TO THE APP AND NOWHERE ELSE. They exist because Stripe redirects a
// browser and will not accept a `jaroku://` URL as a success_url — so the hop is browser, to a page
// we own, to the deep link. If one of those pages ever stopped redirecting, the flow would end with
// somebody sitting in a browser tab wondering whether they had been charged, which is precisely the
// state the pages were introduced to prevent.
//
// AND THE SUCCESS PAGE MUST NOT CONGRATULATE ANYBODY. Arriving there means the payment form was
// submitted, not that the subscription is active: the webhook settles that and travels
// independently of the redirect. "Welcome to Pro" on that page would be a lie a noticeable fraction
// of the time, and the app's own confirming-state exists because of it.
//
// A SUITE RATHER THAN A REVIEW COMMENT, because these are three files nobody opens between releases
// — exactly the shape of thing ADR-028 says a structural audit is for.
//
//   npm run test:checkout-surfaces

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web");
const read = (...p: string[]): string => readFileSync(join(WEB, ...p), "utf8");

/** Markup with the comments taken out. Every one of these files argues with itself at length. */
function markup(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, " ");
}

console.log("\nthe pricing page is discovery, not a checkout");
{
  const raw = read("pricing.html");
  const html = markup(raw);

  check(raw.length > 2000, "read the pricing page");

  // NOTHING THAT COULD START A PAYMENT. Checked against the markup rather than the whole file, so
  // the header above can explain at length why none of this is here without failing its own rule.
  for (const forbidden of ["stripe", "checkout.jaroku.dev", "/v1/billing", "buy", "subscribe now"]) {
    check(
      !html.toLowerCase().includes(forbidden),
      `no "${forbidden}" anywhere in the pricing markup`,
    );
  }
  check(!/<script/i.test(html), "and no script at all — there is nothing for one to do");
  check(!/<form/i.test(html), "nor a form, which is the other way a page starts taking money");

  // Every link is a download or a mailto. A link somewhere else is the thing this asserts against:
  // it would be the second entry point arriving without anybody deciding to add one.
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
  check(hrefs.length >= 4, `found the page's links (${hrefs.length})`);
  const strays = hrefs.filter(
    (h) => !h.startsWith("mailto:") && !h.startsWith("https://jaroku.dev/download") && !h.startsWith("#"),
  );
  check(strays.length === 0, `every CTA is a download or a mailto (strays: ${strays.join(", ") || "none"})`);

  // All three tiers are present and all three are reachable. A page that quietly dropped Team
  // would still pass every assertion above.
  for (const tier of ["Free", "Pro", "Team"]) {
    check(html.includes(`>${tier}</div>`), `the ${tier} tier has a card`);
  }
  check(
    (html.match(/https:\/\/jaroku\.dev\/download/g) ?? []).length >= 2,
    "Free and Pro both lead to a download",
  );
  check(/mailto:contact@jaroku\.dev/.test(html), "and Team leads to a conversation");

  // -------------------------------------------------------------------------------------------
  // AND EVERY FEATURE IT SELLS IS ONE THE PRODUCT GATES.
  //
  // Three rows here named `TierEntitlements` flags that gate nothing — Batch approvals, the
  // Policy engine, Evals as a CI gate — because the surfaces they describe are other
  // specifications and are not built. That is the only commercial claim in this repository the
  // code contradicted, and the codebase already knew: `entitlementGate.ts` says so in as many
  // words, right above the enum this checks against.
  //
  // THE DECLARATION ORDER IS NOT THE BUG. Declaring a flag and wiring it when its surface lands
  // is right, and `perAgentAccessGrants` is the proof — declared in v0.3.4, wired in v0.3.8, at
  // which point its row here became true. What went wrong is that the marketing shipped ahead of
  // the flag rather than behind it, and a prospective customer has no way to tell which side of
  // that a row is on.
  //
  // SO THE GATE IS AGAINST `EntitlementKind` RATHER THAN AGAINST `PlanFeatures`. A flag on
  // `PlanFeatures` is a declaration; a member of `EntitlementKind` is a check somebody can be
  // refused by, which is what makes a row here a thing the customer actually receives. The
  // rows are matched by NAME because the two tables are written in different vocabularies — one
  // sells and one enforces — and that mapping is the only place the two meet.
  // -------------------------------------------------------------------------------------------
  {
    const gateSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "entitlementGate.ts"), "utf8");
    const kinds = new Set(
      // `[A-Za-z0-9]` and not `[A-Za-z]`: two of the ten kinds end in a digit, and a character
      // class that dropped them made this audit pass over the exact rows it exists to check.
      [...(/export type EntitlementKind =([\s\S]*?);/.exec(gateSource)?.[1] ?? "").matchAll(/"([A-Za-z0-9]+)"/g)]
        .map((m) => m[1]!),
    );
    check(kinds.size >= 10, `read the entitlement kinds (${kinds.size})`);

    /** Which check each sold row is delivered by. A row with no entry has nothing behind it. */
    const SOLD: Record<string, string> = {
      "GitHub push": "githubPhase1",
      "GitHub sync (bidirectional)": "githubPhase2",
      "Per-agent Access grants": "perAgentAccessGrants",
    };

    // The Features group's rows, read out of the page rather than remembered — a row added below
    // without an entry above is exactly the failure this exists for.
    const featuresBlock = /Features<\/th><\/tr>([\s\S]*?)<tr class="group"/.exec(html)?.[1] ?? "";
    const sold = [...featuresBlock.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]!.trim());
    check(sold.length >= 3, `found the features the page sells (${sold.length}): ${sold.join(", ")}`);

    const ungated = sold.filter((row) => {
      const kind = SOLD[row];
      return kind === undefined || !kinds.has(kind);
    });
    check(
      ungated.length === 0,
      `every feature sold is one a workspace can be refused for${ungated.length ? ` — UNGATED: ${ungated.join(", ")}` : ""}`,
    );

    // And the three that were removed stay removed until they are real. Named individually
    // because their absence is the fix and a regression would restore them one at a time.
    for (const gone of ["Batch approvals", "Policy engine", "Evals as a CI gate"]) {
      check(!html.includes(gone), `"${gone}" is not sold — it gates nothing and is not built`);
    }
  }
}

console.log("\nthe return pages land the browser back in the app");
{
  for (const [file, path] of [["success.html", "success"], ["canceled.html", "canceled"]] as const) {
    const raw = read("checkout", file);
    const html = markup(raw);
    check(html.includes(`jaroku://billing/${path}`), `${file} redirects to jaroku://billing/${path}`);
    // THE MANUAL BUTTON IS NOT OPTIONAL. An OS may ask before handing a custom scheme to an
    // application, and somebody who dismisses that prompt has no other way back.
    check(/<a[^>]+href="jaroku:\/\/billing\//.test(html), `...and offers it as a link, not only as a redirect`);
    check(/location\.href/.test(html), `...as well as going there on its own`);
    check(!/<form/i.test(html), `${file} collects nothing`);
  }
}

console.log("\nthe success page does not claim more than it knows");
{
  const html = markup(read("checkout", "success.html")).toLowerCase();
  check(html.includes("payment received"), "it says the payment was received");
  check(
    !html.includes("welcome to pro") && !html.includes("you are now on") && !html.includes("upgraded"),
    "and does NOT congratulate anybody on a tier — the webhook decides that, not this redirect",
  );
  check(html.includes("confirm"), "it says the app is confirming, which is what the app then does");
  // The one route for somebody who does not have the app at all. A dead deep link is the only
  // other thing that page could offer them.
  check(html.includes("download"), "and somebody without the app is sent to the download page");
}

console.log("\nthe session id is checked before it becomes part of a launch URL");
{
  const raw = read("checkout", "success.html");
  check(/session_id/.test(raw), "the page carries the session id through");
  // VALIDATED, because this value lands in a URL that starts a local application. Stripe's ids are
  // `cs_` and alphanumerics; anything else is not one, and the link is built without it rather
  // than with whatever a stranger put in the query string.
  check(/cs_/.test(raw) && /test\(/.test(raw), "...against a pattern rather than trusting the query string");
  check(/encodeURIComponent/.test(raw), "...and encodes it when appending");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
