import { expect, test } from "bun:test";
import { nativeBuildFiles } from "../script/build.ts";
test("host staging selects platform-correct addon and executable", () => {
 expect(nativeBuildFiles("win32","x64")).toEqual({packageName:"@oh-my-pi/pi-natives-win32-x64",executable:"dinobot.exe",baseline:"pi_natives.win32-x64-baseline.node"});
 expect(nativeBuildFiles("linux","x64").baseline).toBe("pi_natives.linux-x64-baseline.node");
 expect(nativeBuildFiles("darwin","arm64").baseline).toBe("pi_natives.darwin-arm64.node");
 expect(()=>nativeBuildFiles("freebsd","x64")).toThrow();
});
