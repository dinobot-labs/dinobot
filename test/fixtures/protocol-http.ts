import { afterEach } from "bun:test";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); });
/** Local HTTP transport only; no private backend or upstream network. */
export function protocolHttp(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const target = request.headers.get("x-fixture-url");
  if (!target) return new Response("missing fixture URL", {status:400});
  const headers = new Headers(request.headers); headers.delete("x-fixture-url");
  return handler(new Request(target, {method:request.method, headers, ...(request.method !== "GET" && request.method !== "HEAD" ? {body:await request.arrayBuffer()} : {})}));
 }});
 servers.push(server);
 return (async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const headers = new Headers(request.headers); headers.set("x-fixture-url", request.url);
  return fetch(server.url, {method:request.method, headers, signal:request.signal, ...(request.method !== "GET" && request.method !== "HEAD" ? {body:await request.arrayBuffer()} : {})});
 }) as typeof fetch;
}
