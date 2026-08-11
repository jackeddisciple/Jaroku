// A Redis the queue suites can run against on a machine with no Redis.
//
// WHY THIS EXISTS. Every scenario that mattered most in Session 5 — the fair admit, the leases,
// the named semaphores, the purge — is enforced on the hosted path by a LUA SCRIPT, because that
// is the only way to make "rotate, check capacity, pop, reserve" one atomic step across worker
// processes. Those scripts are the load-bearing part of RedisQueueBackend, and every suite that
// would have exercised them printed "SKIPPED: no JAROKU_REDIS_URL" instead. Redis has no Windows
// build and this repo's dev path deliberately requires nothing installed, so in practice that
// meant the hosted backend shipped with the in-memory one's coverage and none of its own.
//
// THE SCRIPTS ARE NOT REIMPLEMENTED HERE. This runs the exact Lua source out of redisBackend.ts,
// in a real Lua VM (fengari, a Lua 5.3 interpreter in JavaScript — pure JS, no native build), with
// `redis.call` bound to the command table below. So a suite pointed at this is testing the script
// that ships, not a JavaScript paraphrase of it. Transliterating them would have tested only that
// two things written from the same idea agree, which is the one thing that was never in doubt.
//
// WHAT IT IS NOT. Not a Redis clone and not a substitute for running against a real one: it
// implements the sixteen commands these scripts and this backend actually issue, it is
// single-process, and it has no persistence, no clustering and no eviction. A real Redis is still
// what JAROKU_REDIS_URL points at, and every suite still runs against it in preference when one is
// reachable. This is the floor, not the ceiling — the same posture SqliteDb holds next to
// PostgresDb and FsObjectStore next to S3ObjectStore.
//
// ATOMICITY IS REAL HERE, for the same reason it is real in InMemoryQueueBackend: a script runs to
// completion inside one JavaScript turn with no `await` in it, so nothing can interleave — which is
// precisely the property Redis's own single-threaded script execution provides.

import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";

// --- the data model ------------------------------------------------------------------------

type StringEntry = { kind: "string"; value: string; expiresAtMs: number | null };
type ListEntry = { kind: "list"; value: string[] };
type ZSetEntry = { kind: "zset"; value: Map<string, number> };
type Entry = StringEntry | ListEntry | ZSetEntry;

/** A Redis reply, in the shapes ioredis hands back to JavaScript. */
export type Reply = string | number | null | Reply[];

export class MockRedisStore {
  private data = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.kind === "string" && e.expiresAtMs !== null && e.expiresAtMs <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private list(key: string, create: boolean): string[] | undefined {
    const e = this.live(key);
    if (e) return e.kind === "list" ? e.value : undefined;
    if (!create) return undefined;
    const fresh: ListEntry = { kind: "list", value: [] };
    this.data.set(key, fresh);
    return fresh.value;
  }

  private zset(key: string, create: boolean): Map<string, number> | undefined {
    const e = this.live(key);
    if (e) return e.kind === "zset" ? e.value : undefined;
    if (!create) return undefined;
    const fresh: ZSetEntry = { kind: "zset", value: new Map() };
    this.data.set(key, fresh);
    return fresh.value;
  }

  /** `-inf` / `+inf` / `(5` — the score-range syntax ZCOUNT and friends accept. */
  private bound(raw: string, whichEnd: "min" | "max"): { value: number; exclusive: boolean } {
    let s = String(raw);
    let exclusive = false;
    if (s.startsWith("(")) {
      exclusive = true;
      s = s.slice(1);
    }
    if (s === "-inf") return { value: -Infinity, exclusive };
    if (s === "+inf" || s === "inf") return { value: Infinity, exclusive };
    const n = Number(s);
    return { value: Number.isFinite(n) ? n : whichEnd === "min" ? -Infinity : Infinity, exclusive };
  }

  private inRange(score: number, min: string, max: string): boolean {
    const lo = this.bound(min, "min");
    const hi = this.bound(max, "max");
    if (lo.exclusive ? score <= lo.value : score < lo.value) return false;
    if (hi.exclusive ? score >= hi.value : score > hi.value) return false;
    return true;
  }

  /** Empty containers are removed, the way Redis removes a key whose last element is gone. */
  private prune(key: string): void {
    const e = this.data.get(key);
    if (!e) return;
    if (e.kind === "list" && e.value.length === 0) this.data.delete(key);
    if (e.kind === "zset" && e.value.size === 0) this.data.delete(key);
  }

  /**
   * One command. `name` is case-insensitive, matching how Redis accepts it and how the Lua
   * scripts spell it.
   */
  call(name: string, args: string[]): Reply {
    const cmd = name.toUpperCase();
    switch (cmd) {
      case "PING":
        return "PONG";

      // --- lists ---------------------------------------------------------------------------
      case "RPUSH": {
        const list = this.list(args[0]!, true)!;
        list.push(...args.slice(1));
        return list.length;
      }
      case "LPUSH": {
        const list = this.list(args[0]!, true)!;
        list.unshift(...args.slice(1));
        return list.length;
      }
      case "LPOP": {
        const list = this.list(args[0]!, false);
        if (!list || list.length === 0) return null;
        const v = list.shift()!;
        this.prune(args[0]!);
        return v;
      }
      case "RPOP": {
        const list = this.list(args[0]!, false);
        if (!list || list.length === 0) return null;
        const v = list.pop()!;
        this.prune(args[0]!);
        return v;
      }
      case "RPOPLPUSH": {
        const src = this.list(args[0]!, false);
        if (!src || src.length === 0) return null;
        const v = src.pop()!;
        this.prune(args[0]!);
        this.list(args[1]!, true)!.unshift(v);
        return v;
      }
      case "LLEN":
        return this.list(args[0]!, false)?.length ?? 0;
      case "LRANGE": {
        const list = this.list(args[0]!, false) ?? [];
        const n = list.length;
        let start = Number(args[1]);
        let stop = Number(args[2]);
        if (start < 0) start = Math.max(0, n + start);
        if (stop < 0) stop = n + stop;
        if (start > stop || start >= n) return [];
        return list.slice(start, Math.min(stop, n - 1) + 1);
      }
      case "LREM": {
        // Redis LREM key count value: count > 0 removes from the head, count < 0 from the tail,
        // 0 removes every match. These scripts only ever pass 1.
        const list = this.list(args[0]!, false);
        if (!list) return 0;
        const count = Number(args[1]);
        const value = args[2]!;
        let removed = 0;
        const limit = count === 0 ? Infinity : Math.abs(count);
        if (count >= 0) {
          for (let i = 0; i < list.length && removed < limit; ) {
            if (list[i] === value) {
              list.splice(i, 1);
              removed++;
            } else i++;
          }
        } else {
          for (let i = list.length - 1; i >= 0 && removed < limit; i--) {
            if (list[i] === value) {
              list.splice(i, 1);
              removed++;
            }
          }
        }
        this.prune(args[0]!);
        return removed;
      }

      // --- strings -------------------------------------------------------------------------
      case "SET": {
        let expiresAtMs: number | null = null;
        for (let i = 2; i < args.length; i++) {
          const opt = args[i]!.toUpperCase();
          if (opt === "PX") expiresAtMs = Date.now() + Number(args[++i]);
          else if (opt === "EX") expiresAtMs = Date.now() + Number(args[++i]) * 1000;
        }
        this.data.set(args[0]!, { kind: "string", value: args[1]!, expiresAtMs });
        return "OK";
      }
      case "GET": {
        const e = this.live(args[0]!);
        return e && e.kind === "string" ? e.value : null;
      }
      case "DEL": {
        let n = 0;
        for (const key of args) if (this.data.delete(key)) n++;
        return n;
      }
      case "EXISTS": {
        let n = 0;
        for (const key of args) if (this.live(key)) n++;
        return n;
      }

      // --- sorted sets ---------------------------------------------------------------------
      case "ZADD": {
        const z = this.zset(args[0]!, true)!;
        let added = 0;
        for (let i = 1; i + 1 < args.length; i += 2) {
          const member = args[i + 1]!;
          if (!z.has(member)) added++;
          z.set(member, Number(args[i]));
        }
        return added;
      }
      case "ZREM": {
        const z = this.zset(args[0]!, false);
        if (!z) return 0;
        let n = 0;
        for (const member of args.slice(1)) if (z.delete(member)) n++;
        this.prune(args[0]!);
        return n;
      }
      case "ZSCORE": {
        const z = this.zset(args[0]!, false);
        const score = z?.get(args[1]!);
        // Redis replies with a bulk STRING for a score, which is why the Lua does tonumber().
        return score === undefined ? null : String(score);
      }
      case "ZCARD":
        return this.zset(args[0]!, false)?.size ?? 0;
      case "ZCOUNT": {
        const z = this.zset(args[0]!, false);
        if (!z) return 0;
        let n = 0;
        for (const score of z.values()) if (this.inRange(score, args[1]!, args[2]!)) n++;
        return n;
      }
      case "ZRANGEBYSCORE": {
        const z = this.zset(args[0]!, false);
        if (!z) return [];
        return [...z.entries()]
          .filter(([, score]) => this.inRange(score, args[1]!, args[2]!))
          .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
          .map(([member]) => member);
      }
      case "ZREMRANGEBYSCORE": {
        const z = this.zset(args[0]!, false);
        if (!z) return 0;
        let n = 0;
        for (const [member, score] of [...z]) {
          if (this.inRange(score, args[1]!, args[2]!)) {
            z.delete(member);
            n++;
          }
        }
        this.prune(args[0]!);
        return n;
      }

      default:
        throw new Error(
          `mockRedis does not implement ${cmd}. It covers exactly what redisBackend.ts and its ` +
            `Lua scripts issue — see the file header on why it is deliberately not a Redis clone.`,
        );
    }
  }
}

// --- running the real Lua ---------------------------------------------------------------

/** Push a JS value onto the Lua stack in the shape Redis's own reply conversion produces. */
function pushReply(L: never, reply: Reply): void {
  const S = L as never;
  if (reply === null) {
    lua.lua_pushboolean(S, false); // Redis maps a nil reply to Lua false
  } else if (typeof reply === "number") {
    lua.lua_pushinteger(S, reply);
  } else if (typeof reply === "string") {
    lua.lua_pushstring(S, to_luastring(reply));
  } else {
    lua.lua_newtable(S);
    reply.forEach((item, i) => {
      pushReply(S, item);
      lua.lua_rawseti(S, -2, i + 1);
    });
  }
}

/** Read the script's return value back out, in the shapes ioredis hands to JavaScript. */
function toJs(L: never, idx: number): Reply {
  const S = L as never;
  const t = lua.lua_type(S, idx);
  if (t === lua.LUA_TNIL) return null;
  if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(S, idx) ? 1 : null; // false -> nil reply
  if (t === lua.LUA_TNUMBER) return Math.floor(lua.lua_tonumber(S, idx)); // Redis truncates
  if (t === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(S, idx));
  if (t === lua.LUA_TTABLE) {
    const out: Reply[] = [];
    const n = lua.lua_rawlen(S, idx);
    for (let i = 1; i <= n; i++) {
      lua.lua_rawgeti(S, idx, i);
      out.push(toJs(S, lua.lua_gettop(S)));
      lua.lua_pop(S, 1);
    }
    return out;
  }
  return null;
}

function setGlobalArray(L: never, name: string, values: string[]): void {
  const S = L as never;
  lua.lua_newtable(S);
  values.forEach((v, i) => {
    lua.lua_pushstring(S, to_luastring(v));
    lua.lua_rawseti(S, -2, i + 1);
  });
  lua.lua_setglobal(S, to_luastring(name));
}

/**
 * A Lua interpreter bound to one store.
 *
 * ONE STATE, REUSED. Standing up a fresh lua_State and re-opening the standard libraries costs
 * tens of milliseconds, and a script runs on the millisecond path of every admit — a per-call
 * state made the fixture slow enough that leases with short TTLs expired between being taken and
 * being counted, which reads as a backend bug and is not one. Redis keeps one interpreter for the
 * life of the server; so does this.
 */
export class LuaEngine {
  private readonly L: never;

  constructor(store: MockRedisStore) {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);

    lua.lua_newtable(this.L);
    lua.lua_pushstring(this.L, to_luastring("call"));
    lua.lua_pushjsclosure(
      this.L,
      (inner: never) => {
        const top = lua.lua_gettop(inner);
        const args: string[] = [];
        for (let i = 1; i <= top; i++) {
          args.push(
            lua.lua_type(inner, i) === lua.LUA_TNUMBER
              ? String(lua.lua_tonumber(inner, i))
              : to_jsstring(lua.lua_tostring(inner, i)),
          );
        }
        const name = args.shift()!;
        pushReply(inner, store.call(name, args));
        return 1;
      },
      0,
    );
    lua.lua_settable(this.L, -3);
    lua.lua_setglobal(this.L, to_luastring("redis"));
  }

  /**
   * Run one script, synchronously and to completion.
   *
   * Synchronous is the point: there is no `await` anywhere inside, so no other command can
   * interleave with a script mid-flight — the same guarantee Redis gives by being
   * single-threaded, and the reason a script is the right place to put "rotate, check, pop,
   * reserve".
   */
  run(source: string, keys: string[], argv: string[]): Reply {
    setGlobalArray(this.L, "KEYS", keys);
    setGlobalArray(this.L, "ARGV", argv);
    if (lauxlib.luaL_loadstring(this.L, to_luastring(source)) !== lua.LUA_OK) {
      const err = to_jsstring(lua.lua_tostring(this.L, -1));
      lua.lua_pop(this.L, 1);
      throw new Error(`mockRedis: Lua would not compile: ${err}`);
    }
    if (lua.lua_pcall(this.L, 0, 1, 0) !== lua.LUA_OK) {
      const err = to_jsstring(lua.lua_tostring(this.L, -1));
      lua.lua_pop(this.L, 1);
      throw new Error(`mockRedis: Lua raised: ${err}`);
    }
    const reply = toJs(this.L, -1);
    lua.lua_pop(this.L, 1); // leave the stack as we found it, or it grows one slot per command
    return reply;
  }
}

// --- the client surface RedisQueueBackend and EventBridge actually use ---------------------

interface DefinedCommand {
  numberOfKeys: number;
  lua: string;
}

/**
 * Enough of ioredis to stand in for one connection.
 *
 * Deliberately structural rather than a subclass: RedisQueueBackend takes `Redis` and immediately
 * narrows it to the seven `defineCommand`-created methods plus five plain ones, so what it needs
 * is a shape, and pretending to be the whole of ioredis would be pretending.
 */
export class MockRedis {
  private commands = new Map<string, DefinedCommand>();
  /** Subscribers share one hub across every client built from the same one, so `duplicate()`
   *  produces a connection that genuinely hears what its sibling publishes. */
  private hub: Map<string, Set<(channel: string, message: string) => void>>;
  private listeners: Array<(channel: string, message: string) => void> = [];
  private subscribed = new Set<string>();
  private readonly lua: LuaEngine;

  constructor(
    readonly store: MockRedisStore = new MockRedisStore(),
    hub?: Map<string, Set<(channel: string, message: string) => void>>,
    lua?: LuaEngine,
  ) {
    this.hub = hub ?? new Map();
    this.lua = lua ?? new LuaEngine(store);
  }

  defineCommand(name: string, opts: DefinedCommand): void {
    this.commands.set(name, opts);
    (this as unknown as Record<string, unknown>)[name] = async (...args: unknown[]): Promise<Reply> => {
      const flat = args.map((a) => String(a));
      return this.lua.run(opts.lua, flat.slice(0, opts.numberOfKeys), flat.slice(opts.numberOfKeys));
    };
  }

  async ping(): Promise<string> {
    return "PONG";
  }
  async llen(key: string): Promise<number> {
    return this.store.call("LLEN", [key]) as number;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.store.call("LRANGE", [key, String(start), String(stop)]) as string[];
  }
  async zcount(key: string, min: string | number, max: string | number): Promise<number> {
    return this.store.call("ZCOUNT", [key, String(min), String(max)]) as number;
  }
  async zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]> {
    return this.store.call("ZRANGEBYSCORE", [key, String(min), String(max)]) as string[];
  }

  // --- pub/sub, for queue/eventBridge.ts ---------------------------------------------------

  async publish(channel: string, message: string): Promise<number> {
    const subs = this.hub.get(channel);
    if (!subs) return 0;
    // Asynchronous delivery, like a real broker: a publisher never runs its own subscriber's
    // handler inside its own call stack, and a bridge that only worked because it did would be
    // relying on something Redis does not promise.
    for (const fn of [...subs]) queueMicrotask(() => fn(channel, message));
    return subs.size;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribed.add(channel);
    let subs = this.hub.get(channel);
    if (!subs) {
      subs = new Set();
      this.hub.set(channel, subs);
    }
    for (const fn of this.listeners) subs.add(fn);
    return this.subscribed.size;
  }

  on(event: "message", listener: (channel: string, message: string) => void): this {
    if (event === "message") {
      this.listeners.push(listener);
      for (const channel of this.subscribed) this.hub.get(channel)?.add(listener);
    }
    return this;
  }

  /** A second connection onto the same data and the same pub/sub hub — what ioredis's own
   *  duplicate() is for, since a subscribed connection cannot issue ordinary commands. */
  duplicate(): MockRedis {
    return new MockRedis(this.store, this.hub, this.lua);
  }

  async quit(): Promise<string> {
    this.disconnect();
    return "OK";
  }

  disconnect(): void {
    for (const channel of this.subscribed) {
      const subs = this.hub.get(channel);
      if (subs) for (const fn of this.listeners) subs.delete(fn);
    }
    this.subscribed.clear();
    this.listeners = [];
  }
}
