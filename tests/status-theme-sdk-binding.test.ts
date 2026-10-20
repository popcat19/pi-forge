import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionError, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import piForge from "../src/index.ts";
import { writeStack } from "./helpers/index-command-harness.ts";

// Model the pi-web-ui 0.103+ property shape, without installing that consumer.
// The actual SDK runner wrapper (not a test spread implementation) loses this getter.
class GetterUIContext {
	statuses: Record<string, string | undefined> = {};
	notices: string[] = [];
	get theme() { return getThemeByName("dark")!; }
	setStatus = (key: string, value: string | undefined) => { this.statuses[key] = value; };
	notify = (message: string) => { this.notices.push(message); };
}

test("real AgentSession/ExtensionRunner drops prototype theme but Forge startup and preset tools still apply", async () => {
	const root = mkdtempSync(join(tmpdir(), "forge-theme-sdk-"));
	const previous = {
		globalDir: process.env.PI_FORGE_GLOBAL_DIR,
		config: process.env.PI_FORGE_GLOBAL_CONFIG_PATH,
	};
	process.env.PI_FORGE_GLOBAL_DIR = join(root, "global");
	process.env.PI_FORGE_GLOBAL_CONFIG_PATH = join(root, "global-config.json");
	const originalFetch = globalThis.fetch;
	let networkAttempts = 0;
	globalThis.fetch = async () => { networkAttempts++; throw Error("network forbidden in theme binding test"); };
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		writeStack(cwd, "probe.json", {
			schemaVersion: 2, id: "probe", autoActivate: true,
			tools: { allow: ["read"], initial: ["read"] },
			items: [
				{ kind: "block", id: "system", role: "system", content: "THEME-BINDING-PROBE" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		});
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
		}, { projectTrusted: true });
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsPath: null,
			allowModelNetwork: false, refreshOnCreate: false,
		});
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, extensionFactories: [piForge],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const manager = SessionManager.inMemory(cwd);
		({ session } = await createAgentSession({
			cwd, agentDir, resourceLoader: loader, modelRuntime, settingsManager,
			sessionManager: manager, tools: ["read", "bash"],
		}));
		assert.deepEqual(session.getActiveToolNames(), ["read", "bash"]);
		const ui = new GetterUIContext();
		assert.equal(Object.hasOwn(ui, "theme"), false);
		assert.equal(typeof Object.getOwnPropertyDescriptor(GetterUIContext.prototype, "theme")?.get, "function");
		assert.equal(typeof ui.theme.fg("accent", "probe"), "string");
		const errors: ExtensionError[] = [];
		await session.bindExtensions({
			mode: "rpc", uiContext: ui as unknown as ExtensionUIContext, onError: error => errors.push(error),
		});
		const ctx = session.extensionRunner.createContext();
		assert.equal(ctx.hasUI, true);
		assert.equal(ctx.ui.theme, undefined);
		assert.equal(Object.hasOwn(ui, "theme"), false, "Forge must not repair/mutate the host");
		assert.deepEqual(errors, []);
		assert.equal(ui.statuses["pi-forge"], "stack:probe");
		assert.equal(ui.statuses["pi-forge-tools"], "tools:1");
		assert.deepEqual(session.getActiveToolNames(), ["read"], "startup policy must complete before any command");
		const command = session.extensionRunner.getCommand("preset")!;
		await command.handler("use none", session.extensionRunner.createCommandContext());
		assert.deepEqual(session.getActiveToolNames(), ["read", "bash"]);
		await command.handler("use project:probe", session.extensionRunner.createCommandContext());
		assert.deepEqual(session.getActiveToolNames(), ["read"]);
		assert.equal(ui.statuses["pi-forge"], "stack:probe");
		assert.deepEqual(errors, []);
		assert.equal(manager.getBranch().filter(entry => entry.type === "message").length, 0);
		assert.equal(networkAttempts, 0);
	} finally {
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session?.dispose();
			globalThis.fetch = originalFetch;
			if (previous.globalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
			else process.env.PI_FORGE_GLOBAL_DIR = previous.globalDir;
			if (previous.config === undefined) delete process.env.PI_FORGE_GLOBAL_CONFIG_PATH;
			else process.env.PI_FORGE_GLOBAL_CONFIG_PATH = previous.config;
			rmSync(root, { recursive: true, force: true });
		}
	}
});
