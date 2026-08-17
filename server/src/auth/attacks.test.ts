// Token-level attacks, against the whole stack rather than a repository.
//
// `tenancy.test.ts` asks whether a store can be talked into crossing a boundary. This asks the
// question one layer out, where the attacker actually is: two real accounts, two real
// workspaces, a real HTTP surface and a real WebSocket relay, and every credential-shaped way
// one might reach the other.
//
// It is exported rather than run directly, and `tenancy.test.ts` invokes it, because the spec
// makes that suite the gate for every later session — a second script somebody can forget to
// run is not a gate. Same reason the coverage assertion lives there.
//
// EVERY FAILURE IN THIS FILE IS ONE PERSON READING ANOTHER PERSON'S DATA.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import type { Db } from "../db/db.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { DbTicketStore } from "../db/repositories/tickets.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { TraceStore } from "../store.ts";
import { Router } from "../http/router.ts";
import { WsRelay, type ForwardedCommand } from "../wsRelay.ts";
import { JwksClient } from "./jwks.ts";
import { TokenVerifier } from "./verifier.ts";
import { LocalIssuer } from "./localIssuer.ts";
import { sessionRoutes } from "./session.ts";
import { ContextResolver } from "./resolve.ts";
import { resolveSocketAuth } from "./socketAuth.ts";
import { resolveOriginPolicy } from "./origin.ts";
import { DEFAULT_AUDIENCE, LOCAL_ISSUER, type AuthConfig } from "./config.ts";
import type { Run } from "../types.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A live stack, torn down at the end. */
interface Stack {
  base: string;
  wsBase: string;
  relay: WsRelay;
  http: Server;
  identity: IdentityRepository;
  tickets: DbTicketStore;
  resolver: ContextResolver;
  issuer: LocalIssuer;
  commands: { cmd: string; workspaceId: string }[];
  close: () => Promise<void>;
}

export async function attackSuite(
  db: Db,
  check: (ok: boolean, msg: string) => void,
  label: string,
): Promise<void> {
  console.log("\n  · token-level attacks");

  const keyDir = mkdtempSync(join(tmpdir(), "jaroku-attacks-"));
  const stack = await buildStack(db, keyDir);
  const sys = systemContext(newRequestId());
  // Lowercased. The issuer normalises an email before deriving `sub` from it, so a fixture
  // built from a mixed-case label looks the subject up under a spelling that was never
  // stored — and finds it anyway on SQLite, where `users.external_id` is COLLATE NOCASE,
  // while missing on Postgres, where it is not. A fixture that only works on one driver is
  // the exact thing running this suite twice exists to catch.
  const suffix = `${label}-${Math.random().toString(36).slice(2, 7)}`.toLowerCase();

  // Two real accounts. Ada owns a team; Bob is in none of it.
  const adaEmail = `atk-ada-${suffix}@example.com`;
  const bobEmail = `atk-bob-${suffix}@example.com`;
  const adaToken = stack.issuer.mint({ email: adaEmail }).token;
  const bobToken = stack.issuer.mint({ email: bobEmail }).token;

  const adaSession = await post(stack.base, "/v1/auth/session", adaToken);
  const bobSession = await post(stack.base, "/v1/auth/session", bobToken);
  check(adaSession.status === 200 && bobSession.status === 200, "two real accounts sign in");

  const ada = await stack.identity.userByExternalId(sys, `local|${adaEmail}`);
  const bob = await stack.identity.userByExternalId(sys, `local|${bobEmail}`);
  const adaWs: string = adaSession.json.defaultWorkspaceId;
  const bobWs: string = bobSession.json.defaultWorkspaceId;
  check(adaWs !== bobWs, "...into different workspaces");

  // A run in Ada's workspace, so there is something for Bob to fail to see.
  const trace = new TraceStore(db);
  const adaCtx: TenantContext = systemContextFor(adaWs, newRequestId());
  const secretRun = `atk-run-${suffix}`;
  await trace.upsertRun(adaCtx, {
    id: secretRun, agent_id: "ada_secret", provider: "fake", model: "m", status: "completed",
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost: 0, tokens: 0, error: null,
  } as Run);

  // --- the token itself -------------------------------------------------------------------

  // Comfortably past, not exactly on the boundary: the verifier allows sixty seconds of clock
  // skew on purpose, so a token that expired sixty seconds ago is still valid — which is the
  // behaviour, and a fixture sitting on the line tests the fixture rather than the rule.
  const expired = stack.issuer.mint({ email: adaEmail, ttlS: -3600 }).token;
  check((await post(stack.base, "/v1/auth/session", expired)).status === 401, "an EXPIRED token is refused");
  check((await post(stack.base, "/v1/ws-ticket", expired)).status === 401, "...at the ticket endpoint too");

  const [h, p] = adaToken.split(".");
  const unsigned = `${h}.${p}.`;
  check((await post(stack.base, "/v1/ws-ticket", unsigned)).status === 401, "a token with its SIGNATURE STRIPPED is refused");

  const noneAlg = (() => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "x" })).toString("base64url");
    return `${header}.${p}.`;
  })();
  check((await post(stack.base, "/v1/ws-ticket", noneAlg)).status === 401, 'a token claiming alg "none" is refused');

  const tampered = (() => {
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
    payload["sub"] = `local|${bobEmail}`;
    return `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${adaToken.split(".")[2]}`;
  })();
  check(
    (await post(stack.base, "/v1/ws-ticket", tampered)).status === 401,
    "a token edited to name somebody else is refused",
  );

  check((await post(stack.base, "/v1/ws-ticket", undefined)).status === 401, "no token at all is refused");

  // --- the ticket -------------------------------------------------------------------------

  const cross = await post(stack.base, "/v1/ws-ticket", bobToken, { workspaceId: adaWs });
  check(cross.status === 403, `Bob cannot get a ticket for ADA'S workspace (${cross.status})`);
  const denials = await stack.identity.listAudit(adaCtx, 100);
  check(
    denials.some((r) => r.action === "workspace.access_denied" && r.actor_user_id === bob?.id),
    "...and the attempt is recorded as a security event, not a silent 404",
  );

  const bobsOwn = await post(stack.base, "/v1/ws-ticket", bobToken);
  check(bobsOwn.json.workspaceId === bobWs, "...while his own workspace is issued normally");

  // Replay. The whole reason a ticket may sit in a URL is that it is worth nothing twice.
  const replayable = await post(stack.base, "/v1/ws-ticket", adaToken);
  check((await connect(stack, replayable.json.ticket)).result === "open", "a ticket opens one socket");
  check(
    (await connect(stack, replayable.json.ticket)).result === "http 401",
    "REPLAYING the same ticket is refused",
  );

  const invented = await connect(stack, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  check(invented.result === "http 401", "an invented ticket is refused");
  check((await connect(stack, "")).result === "http 401", "a socket with no ticket at all is refused");

  // A ticket is a bearer credential for THIRTY SECONDS. One that has aged out is refused even
  // though nothing else about it changed.
  const stale = await stack.tickets.issue(adaCtx, { ttlS: -1 });
  check((await connect(stack, stale.ticket)).result === "http 401", "an expired ticket is refused");

  // --- what a socket can see ---------------------------------------------------------------

  const bobTicket = await post(stack.base, "/v1/ws-ticket", bobToken);
  const bobSocket = await open(stack, bobTicket.json.ticket);
  check(bobSocket !== null, "Bob opens a socket in his own workspace");
  if (bobSocket) {
    const history = await bobSocket.want((m) => m.channel === "history", "history");
    check(
      !JSON.stringify(history).includes(secretRun),
      "...and his history contains NONE of Ada's runs",
    );

    bobSocket.send({ cmd: "loadRun", runId: secretRun });
    const stolen = await bobSocket.want((m) => m.channel === "runSteps" && m.runId === secretRun, "loadRun");
    check(stolen.steps.length === 0, "...naming Ada's run by id gets him nothing");

    // The client controls what it sends, never which workspace it acts in.
    stack.commands.length = 0;
    bobSocket.send({ cmd: "run", input: "x", agentId: "ada_secret", workspaceId: adaWs } as never);
    await sleep(400);
    check(
      stack.commands.length === 1 && stack.commands[0]!.workspaceId === bobWs,
      `a FORGED workspaceId in the payload is ignored in favour of the context (${stack.commands[0]?.workspaceId === bobWs})`,
    );

    // Bob is an owner of his own personal workspace, so this is not a role test — it is that
    // the context, not the payload, is what every command is answered in.
    bobSocket.close();
  }

  // --- membership is a workspace's own business ---------------------------------------------
  //
  // These decide who can see a workspace AT ALL, so a cross-tenant bug in one of them does not
  // leak a row — it hands over the whole workspace. Ada is an owner, but only of hers.

  const bobCtx: TenantContext = { ...systemContextFor(bobWs, newRequestId()), role: "owner", actorUserId: bob!.id };
  const adaOwner: TenantContext = { ...adaCtx, role: "owner", actorUserId: ada!.id };

  const bobMembers = await stack.identity.listMembers(bobCtx);
  check(bobMembers.length === 1, "Bob's workspace has one member");
  const seenByAda = await stack.identity.listMembers(adaOwner);
  check(
    !seenByAda.some((m) => m.user_id === bob!.id),
    "listMembers under Ada's context shows NONE of Bob's members",
  );

  // An owner's context is an owner of ONE workspace. Pointing its mutations at another
  // workspace's user must do nothing at all.
  const promoted = await stack.identity.setMemberRole(adaOwner, bob!.id, "owner");
  check(!promoted.ok, "Ada cannot promote a user who is not in HER workspace");
  check((await stack.identity.listMembers(bobCtx))[0]?.role === "owner", "...and Bob's own role is untouched");

  const evicted = await stack.identity.removeMember(adaOwner, bob!.id);
  check(!evicted.ok, "...nor remove him from his own workspace");
  check((await stack.identity.listMembers(bobCtx)).length === 1, "...which still has its member");

  // Invites, all four operations, across the boundary.
  const invited = await stack.identity.createInvite(adaOwner, { email: `guest-${suffix}@example.com`, role: "member" });
  check("token" in invited, "Ada can invite somebody to her OWN workspace");
  check(
    (await stack.identity.listInvites(bobCtx)).length === 0,
    "...and it does not appear among Bob's invites",
  );
  check((await stack.identity.listInvites(adaOwner)).length === 1, "...only among hers");

  if ("token" in invited) {
    // The invite token names Ada's workspace. Bob revoking it from his own context must miss.
    check(
      !(await stack.identity.revokeInvite(bobCtx, invited.invite.id)),
      "Bob cannot revoke an invitation belonging to Ada's workspace",
    );
    check((await stack.identity.listInvites(adaOwner)).length === 1, "...and it is still live");

    // And accepting it makes you a member of ADA'S workspace, not of whoever's you like.
    const guestToken = stack.issuer.mint({ email: `guest-${suffix}@example.com` }).token;
    const guestSession = await post(stack.base, "/v1/auth/session", guestToken);
    const accepted = await post(stack.base, "/v1/invites/accept", guestToken, { token: invited.token });
    check(accepted.status === 200, `an invited address accepts over HTTP (${accepted.status})`);
    check(accepted.json?.workspace?.id === adaWs, "...joining the workspace the invite named");

    // The accepter had no socket in Ada's workspace before this — they could not have. That
    // is the whole reason accepting is an HTTP route rather than a command.
    const beforeJoin = guestSession.json.workspaces.length;
    check(accepted.json.workspaces.length === beforeJoin + 1, "...and their workspace list grows by exactly one");

    const replayedInvite = await post(stack.base, "/v1/invites/accept", bobToken, { token: invited.token });
    check(replayedInvite.status === 403, "REPLAYING an accepted invitation is refused");

    const stolen = await stack.identity.createInvite(adaOwner, { email: `other-${suffix}@example.com`, role: "member" });
    if ("token" in stolen) {
      const wrongAccount = await post(stack.base, "/v1/invites/accept", bobToken, { token: stolen.token });
      check(wrongAccount.status === 403, "an invitation cannot be redeemed by an account it was not sent to");
    }
  }

  // The invite token is `<workspace_id>.<secret>`, and the workspace id in it authorises
  // NOTHING — it selects which rows to search so the query can be scoped, which is what lets
  // the table keep an RLS policy a non-member reads through. Repointing a real secret at
  // another workspace must therefore find nothing rather than join that one.
  const swapTarget = await stack.identity.createInvite(adaOwner, { email: `swap-${suffix}@example.com`, role: "member" });
  if ("token" in swapTarget) {
    const repointed = `${bobWs}.${swapTarget.token.split(".")[1]}`;
    const joined = await stack.identity.acceptInvite(sys, repointed, {
      id: bob!.id,
      email: `swap-${suffix}@example.com`,
    });
    check(!joined.ok, "an invite secret repointed at ANOTHER workspace joins nothing");
    check(
      (await stack.identity.listMembers(bobCtx)).length === 1,
      "...and that workspace's membership is unchanged",
    );
  }

  // A ticket redeemed always yields the workspace it was ISSUED for, whoever presents it.
  const forWs = await stack.tickets.issue(adaOwner);
  const redeemed = await stack.tickets.consume(forWs.ticket);
  check(redeemed?.workspaceId === adaWs, "a redeemed ticket names the workspace it was issued for and no other");

  // --- a socket must not outlive the membership --------------------------------------------

  const team = await stack.identity.createWorkspace(sys, { name: `atk team ${suffix}`, ownerUserId: ada!.id });
  const ownerCtx: TenantContext = { ...systemContextFor(team.id, newRequestId()), role: "owner", actorUserId: ada!.id };
  await stack.identity.addMember(ownerCtx, bob!.id, "member");
  stack.resolver.invalidate(team.id, bob!.id);

  const teamTicket = await post(stack.base, "/v1/ws-ticket", bobToken, { workspaceId: team.id });
  check(teamTicket.status === 200, "once invited, Bob CAN get a ticket for the team");
  const teamSocket = await open(stack, teamTicket.json.ticket);
  check(teamSocket !== null, "...and open a socket with it");

  if (teamSocket) {
    // A member may not manage the workspace's third-party connections.
    teamSocket.send({ cmd: "addMcpServer", endpoint: "https://mcp.example/x" });
    const refused = await teamSocket.want((m) => m.channel === "mcp" && m.type === "error", "mcp refusal");
    check(/member/.test(refused.message), "a member's socket is refused an admin command");

    // --- DEMOTION, MID-SESSION, ON THE SAME SOCKET -----------------------------------------
    //
    // The capability check reads the socket's LIVE context rather than the one it connected
    // with, and that mechanism is tested elsewhere. This is the behaviour that mechanism
    // exists for, which is a different question: somebody who HOLDS a privileged capability,
    // is demoted while their tab is open, and immediately does the privileged thing.
    //
    // The failure it rules out is the plausible one — a demotion that arrives as a
    // NOTIFICATION. The client is told its role changed, the server keeps judging commands
    // against the role captured at the handshake, and a just-demoted admin goes on connecting
    // third-party servers to the workspace for as long as they leave the tab open. Nothing
    // about the socket would look wrong, and the audit log would show an admin doing admin
    // things.
    //
    // Promote first, then connect a FRESH socket, so its handshake resolves the admin role
    // from a real membership row. That matters: demoting a socket that was only ever a member
    // proves nothing, because a server reading the stale handshake context would refuse the
    // command anyway and the test would pass for the opposite of the right reason. Here the
    // captured context IS admin, so a refusal can only come from reading the live one.
    await stack.identity.setMemberRole(ownerCtx, bob!.id, "admin");
    stack.resolver.invalidate(team.id, bob!.id);

    const adminTicket = await post(stack.base, "/v1/ws-ticket", bobToken, { workspaceId: team.id });
    const adminSocket = await open(stack, adminTicket.json.ticket);
    check(adminSocket !== null, "promoted to admin, Bob opens a socket that HANDSHAKES as admin");

    if (adminSocket) {
      stack.commands.length = 0;
      adminSocket.send({ cmd: "addMcpServer", endpoint: "https://mcp.example/allowed" });
      await sleep(400);
      check(
        stack.commands.some((c) => c.cmd === "addMcpServer"),
        "...and holds the privileged capability on it",
      );

      // Now take it away, with that socket still open and still holding an admin handshake.
      await stack.identity.setMemberRole(ownerCtx, bob!.id, "member");
      stack.resolver.invalidate(team.id, bob!.id);
      await stack.relay.revalidateAll();
      await sleep(300);

      const demotedTo = adminSocket.inbox.find(
        (m) => m.channel === "session" && m.type === "role_changed" && m.role === "member",
      );
      check(!!demotedTo, "a DEMOTION to member reaches the open socket");
      check(
        adminSocket.ws.readyState === WebSocket.OPEN,
        "...and does not close it — the connection is still legitimately theirs",
      );

      // The whole point. Same socket, same command, immediately after the demotion.
      stack.commands.length = 0;
      const beforeRefusal = adminSocket.inbox.length;
      adminSocket.send({ cmd: "addMcpServer", endpoint: "https://mcp.example/denied" });
      // Caught rather than thrown. The regression this guards against — enforcement reading
      // the handshake context instead of the live one — produces NO refusal at all, and a
      // suite that dies on a timeout reports "timeout" where it should report which
      // security property just stopped holding.
      const afterDemotion = await adminSocket
        .want((m) => m.channel === "mcp" && m.type === "error", "refusal after demotion", beforeRefusal)
        .catch(() => null);
      check(
        !!afterDemotion && /member/.test(afterDemotion.message) && /mcp:manage/.test(afterDemotion.message),
        "A DEMOTED ADMIN IS REFUSED THAT EXACT COMMAND ON THE STILL-OPEN SOCKET" +
          (afterDemotion ? "" : " — NO REFUSAL ARRIVED: the demotion is a notification, not enforcement"),
      );
      await sleep(300);
      check(
        stack.commands.length === 0,
        `...and it NEVER REACHED THE APP (${stack.commands.length}) — a refusal that forwards first has already connected the server`,
      );

      // The demotion is narrow: it removes what admin added and nothing a member holds. A
      // demotion that quietly took the product away with the privilege would be its own bug.
      stack.commands.length = 0;
      adminSocket.send({ cmd: "run", input: "x", agentId: "still_allowed" });
      await sleep(400);
      check(
        stack.commands.some((c) => c.cmd === "run"),
        "...while the same socket still does what a member may",
      );
      adminSocket.close();
    }

    // Now revoke, with the socket still open. This is the case nothing else catches: every
    // HTTP request re-checks, and a socket is checked once at the upgrade.
    await stack.identity.removeMember(ownerCtx, bob!.id);
    await stack.tickets.revoke(team.id, bob!.id);
    await stack.relay.revalidateAll();
    await sleep(500);

    const revoked = teamSocket.inbox.find((m) => m.channel === "session" && m.type === "revoked");
    check(!!revoked, "a REVOKED membership closes the socket that was authorised by it");
    check(teamSocket.ws.readyState !== WebSocket.OPEN, "...and the connection is actually gone");
  }

  // ...and a ticket minted just before the revocation is dead too, rather than good for
  // another thirty seconds.
  const doomed = await stack.tickets.issue({ ...ownerCtx, actorUserId: bob!.id, role: "member" });
  await stack.tickets.revoke(team.id, bob!.id);
  check((await connect(stack, doomed.ticket)).result === "http 401", "a ticket outstanding at revocation is killed too");

  const after = await post(stack.base, "/v1/ws-ticket", bobToken, { workspaceId: team.id });
  check(after.status === 403, "...and no new ticket can be had for a workspace he was removed from");

  await stack.close();
  rmSync(keyDir, { recursive: true, force: true });
}

// --- the stack ------------------------------------------------------------------------------

async function buildStack(db: Db, keyDir: string): Promise<Stack> {
  const issuer = new LocalIssuer(join(keyDir, "devauth.json"), DEFAULT_AUDIENCE, () => {});
  const jwksHttp = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(issuer.jwks()));
  });
  await new Promise<void>((r) => jwksHttp.listen(0, "127.0.0.1", r));
  const jwksUrl = `http://127.0.0.1:${(jwksHttp.address() as AddressInfo).port}/jwks.json`;

  const config: AuthConfig = { mode: "local", issuer: LOCAL_ISSUER, audience: DEFAULT_AUDIENCE, jwksUrl };
  const identity = new IdentityRepository(db);
  const tickets = new DbTicketStore(db);
  const resolver = new ContextResolver({ identity, log: () => {} });
  const verifier = new TokenVerifier(config, new JwksClient({ url: jwksUrl }));

  const router = new Router({ log: () => {} });
  for (const route of sessionRoutes({ config, verifier, identity, localIssuer: issuer, tickets, resolver, log: () => {} })) {
    if (route.method === "GET") router.get(route.path, route.handler);
    else router.post(route.path, route.handler);
  }

  const store = new TraceStore(db);
  await store.init();
  const commands: { cmd: string; workspaceId: string }[] = [];
  // Port 0 would be cleaner, but WsRelay owns its own listen(). A high fixed port, and the
  // suite is the only thing on it.
  const port = 4600 + Math.floor(Math.random() * 80);
  const relay = new WsRelay({
    port,
    store,
    router,
    clientHtmlPath: "/dev/null",
    originPolicy: resolveOriginPolicy({}, () => {}),
    contextFor: resolveSocketAuth({
      tickets,
      devContext: () => systemContextFor("00000000-0000-4000-8000-000000000001", newRequestId()),
      env: {},
      log: () => {},
    }),
    revalidate: async (session) => {
      const ctx = systemContext(newRequestId());
      const ws = await identity.workspaceById(ctx, session.context.workspaceId);
      if (!ws) return { ok: false, reason: "workspace_gone" };
      if (!session.context.actorUserId) return { ok: true, role: session.context.role };
      const role = await resolver.stillAMember(session.context, ctx.requestId);
      return role ? { ok: true, role } : { ok: false, reason: "revoked" };
    },
    listAgents: async () => [],
    listMcpServers: async () => [],
    listProviders: () => ({ providers: [], ownKeyForPlatform: false, models: [] }),
    listDeployments: async () => ({ deployments: [], railwayConfigured: false }),
    onCommand: (cmd: ForwardedCommand, ctx: TenantContext) => {
      commands.push({ cmd: cmd.cmd, workspaceId: ctx.workspaceId });
    },
  });
  await sleep(200);

  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    relay,
    http: jwksHttp,
    identity,
    tickets,
    resolver,
    issuer,
    commands,
    close: async () => {
      await relay.close();
      await new Promise<void>((r) => jwksHttp.close(() => r()));
    },
  };
}

async function post(base: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion is about the status */
  }
  return { status: res.status, json };
}

/** Connect, and report what happened: "open", or the HTTP status of the refusal. */
function connect(stack: Stack, ticket: string): Promise<{ result: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${stack.wsBase}/?ticket=${encodeURIComponent(ticket)}`);
    const done = (result: string): void => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve({ result });
    };
    ws.on("open", () => done("open"));
    ws.on("unexpected-response", (_r, res) => done(`http ${res.statusCode}`));
    ws.on("error", () => done("error"));
    setTimeout(() => done("timeout"), 3000);
  });
}

interface Socket {
  ws: WebSocket;
  inbox: any[];
  send: (o: unknown) => void;
  close: () => void;
  /**
   * The first message matching `pred`, waiting for it to arrive.
   *
   * `from` skips everything already in the inbox, which matters whenever the same assertion is
   * made twice on one socket: an "mcp error" search that starts at zero keeps finding the
   * FIRST refusal, so a test that demotes somebody and re-asks would pass on a server that
   * never answered the second question at all.
   */
  want: (pred: (m: any) => boolean, label: string, from?: number) => Promise<any>;
}

/** Connect and keep the socket, for the assertions that need to talk on it. */
async function open(stack: Stack, ticket: string): Promise<Socket | null> {
  const ws = new WebSocket(`${stack.wsBase}/?ticket=${encodeURIComponent(ticket)}`);
  const inbox: any[] = [];
  ws.on("message", (d) => {
    try {
      inbox.push(JSON.parse(d.toString()));
    } catch {
      /* ignore */
    }
  });
  const opened = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("unexpected-response", () => resolve(false));
    ws.once("error", () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  if (!opened) return null;
  return {
    ws,
    inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    want: async (pred, label, from = 0) => {
      for (let i = 0; i < 80; i++) {
        const hit = inbox.slice(from).find(pred);
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`timeout: ${label}`);
    },
  };
}
