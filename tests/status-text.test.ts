import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { formatStatusText } from "../src/status-text.ts";
import { createPromptStackRuntime } from "../src/runtime/prompt-stack-runtime.ts";
import { createHarness, createContext, startSession, writeStack } from "./helpers/index-command-harness.ts";

test("real dark/light Theme fg output stays byte-identical and receiver-bound", () => {
	for (const name of ["dark", "light"]) {
		initTheme(name, false);
		for (const color of ["accent", "warning", "error"] as const) {
			for (const text of ["stack:猫猫", ""]) {
				assert.equal(formatStatusText({ ui: { theme } } as any, color, text), theme.fg(color, text));
			}
		}
	}
});

test("missing/null/malformed theme and throwing theme getter fall back only within formatting", () => {
	for (const unavailable of [undefined, null, {}, { fg: 42 }, { fg() { throw Error("format error"); } }]) {
		assert.equal(formatStatusText({ ui: { theme: unavailable } } as any, "accent", "plain"), "plain");
	}
	const ui = { get theme() { throw Error("Theme not initialized. Call initTheme() first."); } };
	assert.equal(formatStatusText({ ui } as any, "warning", "plain"), "plain");
	const receiver = {
		tag: "receiver",
		fg(this: any, color: string, text: string) {
			assert.equal(this, receiver);
			return this.tag + ":" + color + ":" + text;
		},
	};
	assert.equal(formatStatusText({ ui: { theme: receiver } } as any, "error", "plain"), "receiver:error:plain");
});

test("actual SDK uninitialized theme Proxy degrades to plain in a fresh process", () => {
	const home = mkdtempSync(join(tmpdir(), "forge-uninitialized-theme-"));
	try {
		const script = `
			import assert from 'node:assert/strict';
			import {theme} from './node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
			import {formatStatusText} from './src/status-text.ts';
			assert.throws(()=>theme.fg('accent','plain'),/not initialized/);
			assert.equal(formatStatusText({ui:{theme}},'accent','plain'),'plain');
			console.log('uninitialized-proxy-fallback:PASS');
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
			env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /fallback:PASS/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

for (const mode of ["absent", "throwing-getter", "receiver"] as const) {
	test("seven status paths preserve runtime operations: " + mode, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "forge-status-text-"));
		writeStack(cwd, "probe.json", {
			schemaVersion: 2, id: "probe", autoActivate: true,
			tools: { allow: ["read"], initial: ["read"] },
			items: [
				{ kind: "block", id: "system", role: "system", content: "Hello {{ parameters.missing }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		});
		const harness = createHarness({ activeTools: ["read", "bash"], allTools: ["read", "bash"] });
		const { ctx, statuses } = createContext(cwd);
		const receiver = {
			prefix: "colored",
			fg(this: any, color: string, text: string) {
				assert.equal(this, receiver);
				return `${this.prefix}:${color}:${text}`;
			},
		};
		if (mode === "absent") ctx.ui.theme = undefined;
		if (mode === "throwing-getter") Object.defineProperty(ctx.ui, "theme", {
			get() { throw Error("theme getter unavailable"); },
		});
		if (mode === "receiver") ctx.ui.theme = receiver;
		const expected = (color: string, text: string) => mode === "receiver" ? `colored:${color}:${text}` : text;
		ctx.hasUI = false;
		try {
			await startSession(harness, ctx);
			assert.equal(statuses["pi-forge"], expected("accent", "stack:probe"));
			assert.deepEqual(harness.getActiveTools(), ["read"]);
			assert.equal(statuses["pi-forge-tools"], expected("accent", "tools:1"));
			await harness.commands.payload.handler("next", ctx);
			assert.equal(statuses["pi-forge-intercept"], expected("warning", "payload:armed"));
			await harness.commands.payload.handler("cancel", ctx);
			assert.equal(statuses["pi-forge-intercept"], undefined);
			ctx.hasUI = true;
			await harness.commands.preset.handler("ui", ctx); // New server branch.
			const editorStatus = statuses["pi-forge-editor"];
			assert.match(editorStatus ?? "", /editor:\d+/);
			await harness.commands.preset.handler("ui", ctx); // Existing server branch.
			assert.equal(statuses["pi-forge-editor"], editorStatus);
			await harness.events.before_agent_start({
				type: "before_agent_start", prompt: "probe", systemPrompt: "BASE",
				systemPromptOptions: ctx.getSystemPromptOptions(),
			}, ctx); // refreshHost branch.
			assert.equal(statuses["pi-forge-editor"], editorStatus);
			await harness.events.context_with_system({
				type: "context_with_system", messages: [{ role: "user", content: "probe", timestamp: 1 }],
			}, ctx);
			assert.equal(statuses["pi-forge-diagnostics"], expected("error", "forge:1e/1w"));
			await harness.commands.preset.handler("ui stop", ctx);
			assert.equal(statuses["pi-forge-editor"], undefined);
			await harness.commands.preset.handler("use none", ctx);
			assert.deepEqual(harness.getActiveTools(), ["read", "bash"]);
			assert.equal(statuses["pi-forge"], undefined);
		} finally {
			await harness.commands.preset.handler("ui stop", ctx);
			await harness.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, ctx);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

test("status delivery exceptions are not swallowed", () => {
	const runtime = createPromptStackRuntime({} as any,
		{ snapshot: () => ({ active: { stack: { id: "probe" } } }) } as any, {} as any, {} as any);
	const fault = Error("transport-failed");
	assert.throws(() => runtime.updateStatus({ ui: {
		theme: undefined, setStatus() { throw fault; },
	} } as any), error => error === fault);
});
