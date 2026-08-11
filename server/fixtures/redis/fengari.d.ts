// fengari ships no types. Only what fixtures/redis/mockRedis.ts calls is declared — a stub for
// the whole Lua C API would be a large surface nothing here reads, and it would go stale
// silently. `never` on the state parameter is deliberate: fengari's lua_State is opaque, and
// nothing in this repo should be reaching into one.

declare module "fengari" {
  export const lua: {
    LUA_OK: number;
    LUA_TNIL: number;
    LUA_TBOOLEAN: number;
    LUA_TNUMBER: number;
    LUA_TSTRING: number;
    LUA_TTABLE: number;
    lua_newtable(L: never): void;
    lua_pushstring(L: never, s: Uint8Array): void;
    lua_pushinteger(L: never, n: number): void;
    lua_pushboolean(L: never, b: boolean): void;
    lua_pushjsclosure(L: never, fn: (L: never) => number, n: number): void;
    lua_settable(L: never, idx: number): void;
    lua_setglobal(L: never, name: Uint8Array): void;
    lua_rawseti(L: never, idx: number, n: number): void;
    lua_rawgeti(L: never, idx: number, n: number): number;
    lua_rawlen(L: never, idx: number): number;
    lua_gettop(L: never): number;
    lua_type(L: never, idx: number): number;
    lua_toboolean(L: never, idx: number): boolean;
    lua_tonumber(L: never, idx: number): number;
    lua_tostring(L: never, idx: number): Uint8Array;
    lua_pop(L: never, n: number): void;
    lua_pcall(L: never, nargs: number, nresults: number, errfunc: number): number;
  };
  export const lauxlib: {
    luaL_newstate(): never;
    luaL_loadstring(L: never, s: Uint8Array): number;
  };
  export const lualib: {
    luaL_openlibs(L: never): void;
  };
  export function to_luastring(s: string): Uint8Array;
  export function to_jsstring(s: Uint8Array): string;
}
