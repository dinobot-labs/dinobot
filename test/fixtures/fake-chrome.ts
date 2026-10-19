#!/usr/bin/env bun
// Stands in for Chrome in browser-session tests: writes DevToolsActivePort and answers Storage.getCookies.
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!profile) process.exit(2);
if (process.env.FAKE_CHROME_LOG) await Bun.write(process.env.FAKE_CHROME_LOG, `${profile}\n${process.argv.at(-1)}\n`);
let polls = 0;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request, server) {
		return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
	},
	websocket: {
		message(socket, message) {
			const { id } = JSON.parse(String(message)) as { id: number };
			polls++;
			const cookies =
				polls >= 2
					? [
							{ name: "session", value: "elsewhere", domain: ".other.example" },
							{ name: "session", value: "tok-123", domain: ".example.com" },
						]
					: [];
			socket.send(JSON.stringify({ id, result: { cookies } }));
		},
	},
});
const silent = process.env.FAKE_CHROME_HANG
	? Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {
					if (process.env.FAKE_CHROME_LOG) void Bun.write(`${process.env.FAKE_CHROME_LOG}.handshake`, "");
				},
				data() {},
			},
		})
	: undefined;
await Bun.write(`${profile}/DevToolsActivePort`, `${silent?.port ?? server.port}\n/devtools/browser/fake\n`);
if (process.env.FAKE_CHROME_EXIT) setTimeout(() => process.exit(0), 50);

export {};
