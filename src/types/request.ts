import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * The request the plugin carries from a route down to consumer code.
 *
 * Every hook, `validate` and `getTenantId` receive it; **nothing inside `src/lib/` ever reads a
 * property off it**. It is an opaque token that the HTTP layer produces and consumer code
 * consumes, and the engines only forward — which is why the engines, the schema builders and
 * the write pipeline hold no dependency on a web framework at all, only on this name.
 *
 * That is the point of the alias: it is the single seam where the plugin's core meets Fastify.
 * A second HTTP adapter — or a core published apart from one — changes this file and nothing
 * else, and `.dependency-cruiser.mjs` keeps it that way by refusing a `fastify` import anywhere
 * under `src/lib/` or `src/types/` but here.
 *
 * It is a plain alias rather than a generic parameter on `ITable`: that type appears bare in
 * over a hundred places, and threading `<Req>` through all of them — plus `DbTables`, plus
 * every `*Params` — would change the public type surface today for a benefit that only
 * materialises once the core ships as its own package. See
 * [ADR 0018](../../docs/adr/0018-one-seam-to-the-http-framework.md).
 */
export type ApiRequest = FastifyRequest;

/** The reply, which only the HTTP layer's own options need to name. */
export type ApiReply = FastifyReply;
