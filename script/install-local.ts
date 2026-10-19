#!/usr/bin/env bun
/// <reference types="bun" />
import { buildHost } from "./build.ts";
import { installLocalArtifacts, localInstallPaths, preflightLocalInstall } from "./local-install.ts";

if (import.meta.main) {
	const { dist, bin } = localInstallPaths();
	buildHost(dist);
	const artifacts = preflightLocalInstall(dist);
	installLocalArtifacts(artifacts, bin);
	console.log(`Installed dinobot and ${artifacts.natives.length} native addon(s) to ${bin}`);
}
