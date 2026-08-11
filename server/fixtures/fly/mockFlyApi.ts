// A fixture Fly Machines API, so FlyMachinesSandbox can be built and verified with no Fly
// account — the same reason fixtures/s3/mockS3.ts and fixtures/mcp/mockServer.ts exist, and the
// same rule: the fixtures and `npm run dev` must keep working with zero cloud dependencies.
//
// It checks the bearer token, refuses a machine spec whose image is not digest-pinned (the one
// invariant flySandbox.ts is not allowed to get wrong even against a fixture), and lets a test
// script the machine's exit — normal, OOM, or a signal — because that is precisely the part a
// real account cannot be scripted to produce on demand for a test suite.
//
// Usage:
//   npm run mock:fly                     # http://127.0.0.1:8935
//   MOCK_FLY_TOKEN=sekrit npm run mock:fly

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface MockMachine {
  id: string;
  instance_id: string;
  state: "started" | "stopped" | "destroyed";
  region: string;
  config: unknown;
  exit: { exit_code: number | null; oom_killed: boolean; signal: number | null } | null;
}

export interface MockFlyApi {
  url: string;
  machines: Map<string, MockMachine>;
  /** Script what the NEXT stop/signal on this machine reports as its exit. */
  setExit(id: string, exit: MockMachine["exit"]): void;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
}

export async function startMockFlyApi(opts: { token?: string } = {}): Promise<MockFlyApi> {
  const token = opts.token ?? process.env.MOCK_FLY_TOKEN ?? "fixture-fly-token";
  const machines = new Map<string, MockMachine>();
  const pendingExit = new Map<string, MockMachine["exit"]>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => send(res, 500, { error: String(err) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fixture-fly.invalid");
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });

    const parts = url.pathname.split("/").filter(Boolean); // ["apps", app, "machines", id?, tail?]
    if (parts[0] !== "apps" || parts[2] !== "machines") return send(res, 404, { error: "not found" });
    const app = parts[1]!;
    const id = parts[3];
    const tail = parts[4];

    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      const config = body.config as { image?: string } | undefined;
      const image = config?.image ?? "";
      if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) {
        return send(res, 422, { error: `image ${JSON.stringify(image)} is not pinned by digest` });
      }
      const machine: MockMachine = {
        id: randomUUID().replace(/-/g, "").slice(0, 14),
        instance_id: randomUUID(),
        state: "started",
        region: (body.region as string) ?? "sea",
        config,
        exit: null,
      };
      machines.set(machine.id, machine);
      return send(res, 200, machine);
    }

    if (!id) return send(res, 404, { error: "not found" });
    const machine = machines.get(id);
    if (!machine) return send(res, 404, { error: "machine not found" });

    if (req.method === "GET" && tail === "wait") {
      // A fixture boots instantly — nothing to actually wait for.
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && tail === "events") {
      const events = machine.exit ? [{ type: "exit", request: { exit_event: machine.exit } }] : [];
      return send(res, 200, events);
    }
    if (req.method === "GET" && !tail) {
      return send(res, 200, machine);
    }
    if (req.method === "POST" && tail === "signal") {
      const body = await readJson(req);
      const signal = body.signal === "SIGKILL" ? 9 : 15;
      machine.state = "stopped";
      machine.exit = pendingExit.get(id) ?? { exit_code: null, oom_killed: false, signal };
      pendingExit.delete(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && tail === "stop") {
      machine.state = "stopped";
      machine.exit = pendingExit.get(id) ?? { exit_code: 0, oom_killed: false, signal: null };
      pendingExit.delete(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && !tail) {
      machine.state = "destroyed";
      machines.delete(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    machines,
    setExit(id, exit) {
      pendingExit.set(id, exit);
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockFlyApi();
  console.log(`[mock-fly] listening on ${mock.url}`);
}
