import assert from "node:assert/strict";
import test from "node:test";

import { createToolPolicyRuntime, reconcileToolPolicyBaseline } from "../src/runtime/tool-policy-runtime.ts";

test("tool policy baseline reconciliation preserves late additions and external removals", () => {
	assert.deepEqual(
		reconcileToolPolicyBaseline(["read", "bash", "edit", "write"], ["read"], ["read", "paint"]),
		["read", "bash", "edit", "write", "paint"],
	);
	assert.deepEqual(
		reconcileToolPolicyBaseline(["read", "bash", "edit", "write"], ["read", "bash"], ["read"]),
		["read", "edit", "write"],
	);
});

test("tool policy runtime owns filtering, preview, and restoration state", () => {
	let activeTools = ["read", "bash", "paint"];
	const allTools = [
		{ name: "read", description: "Read files" },
		{ name: "bash", description: "Run commands" },
		{ name: "paint", description: "Paint" },
	];
	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	} as any;
	const state: { active?: any } = {};
	const active = {
		filePath: "/tmp/read-only.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: "read-only" },
		diagnostics: [],
		stack: { schemaVersion: 1 as const, id: "read-only", tools: { allow: ["read"] }, items: [] },
	};
	state.active = active;
	const runtime = createToolPolicyRuntime(pi, () => state.active);

	runtime.sync();
	assert.deepEqual(activeTools, ["read"]);
	assert.deepEqual(runtime.previewToolNames(active.stack), ["read"]);
	assert.match(runtime.blockReason("bash") ?? "", /read-only/);

	allTools.push({ name: "late-tool", description: "Loaded after the policy" });
	activeTools.push("late-tool");
	runtime.restore();
	assert.deepEqual(activeTools, ["read", "bash", "paint", "late-tool"]);
});

test("preview recovers baseline tool metadata after the active policy filtered captured options", () => {
	let activeTools = ["read", "bash"];
	const allTools = [
		{ name: "read", description: "Read files", promptGuidelines: ["Read before editing."] },
		{ name: "bash", description: "Run commands", promptGuidelines: ["Use shell commands deliberately."] },
	];
	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	} as any;
	const active = {
		filePath: "/tmp/read-only.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: "read-only" },
		diagnostics: [],
		stack: { schemaVersion: 1 as const, id: "read-only", tools: { allow: ["read"] }, items: [] },
	};
	const runtime = createToolPolicyRuntime(pi, () => active);

	runtime.sync();
	assert.deepEqual(activeTools, ["read"]);

	const preview = runtime.previewOptions({
		cwd: "/tmp",
		selectedTools: ["read"],
		toolSnippets: { read: "Read files" },
		promptGuidelines: ["Read before editing."],
		contextFiles: [],
		skills: [],
	}, {
		schemaVersion: 1,
		id: "shell-preview",
		tools: { allow: ["bash"] },
		items: [],
	});

	assert.deepEqual(preview.selectedTools, ["bash"]);
	assert.deepEqual(preview.toolSnippets, { bash: "Run commands" });
	assert.deepEqual(preview.promptGuidelines, ["Use shell commands deliberately."]);
});

test("selective tool allow activates registered inactive tools and restores the original baseline", () => {
	let activeTools = ["read", "bash", "edit", "write"];
	const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name }));
	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	} as any;
	const active = {
		filePath: "/tmp/search-tools.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: "search-tools" },
		diagnostics: [],
		stack: {
			schemaVersion: 1 as const,
			id: "search-tools",
			tools: { allow: ["grep", "find", "ls"] },
			items: [],
		},
	};
	const state: { active?: typeof active } = { active };
	const runtime = createToolPolicyRuntime(pi, () => state.active);

	runtime.sync();
	assert.deepEqual(activeTools, ["grep", "find", "ls"]);
	assert.deepEqual(runtime.previewToolNames(active.stack), ["grep", "find", "ls"]);

	state.active = undefined;
	runtime.sync();
	assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);
});

test("an allow list containing wildcard stays on the active baseline", () => {
	let activeTools = ["read", "bash"];
	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => ["read", "bash", "grep", "find", "ls"].map((name) => ({ name })),
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	} as any;
	const active = {
		filePath: "/tmp/wildcard.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: "wildcard" },
		diagnostics: [],
		stack: { schemaVersion: 1 as const, id: "wildcard", tools: { allow: ["*", "grep"] }, items: [] },
	};
	const runtime = createToolPolicyRuntime(pi, () => active);

	runtime.sync();
	assert.deepEqual(activeTools, ["read", "bash"]);
	assert.deepEqual(runtime.previewToolNames(active.stack), ["read", "bash"]);
});

test("explicit selection remembers only after activation and tool-policy preflight succeed", async () => {
	const { createPromptStackRuntime } = await import("../src/runtime/prompt-stack-runtime.ts");
	const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { GLOBAL_FORGE_DIR_ENV, writeRememberedPreset } = await import("../src/storage.ts");
	const previous = process.env[GLOBAL_FORGE_DIR_ENV];
	const root = mkdtempSync(join(tmpdir(), "forge-preflight-memory-"));
	process.env[GLOBAL_FORGE_DIR_ENV] = root;
	try {
		const target = { key: { scope: "global", id: "chosen" }, stack: { id: "chosen" }, diagnostics: [] };
		let active: any;
		let error: string | undefined;
		let syncThrows = false;
		const workspace: any = {
			snapshot: () => ({ stacks: [target], active }),
			setActiveStack: () => { active = target; return true; },
		};
		const ctx: any = { mode: "tui", cwd: root, isProjectTrusted: () => true, ui: { setStatus() {}, notify() {} } };
		const runtime = createPromptStackRuntime({ appendEntry() {} } as any, workspace, {} as any, {
			syncToolPolicy: () => { if (syncThrows) throw new Error("sync failed"); },
			validatePresetSwitch: () => error,
		});
		writeRememberedPreset("none", root);
		error = "retained capability conflict";
		assert.equal(runtime.selectActive("global:chosen", ctx), false);
		assert.equal(active, undefined);
		assert.equal(JSON.parse(readFileSync(join(root, "last-preset.json"), "utf8")).selector, "none");
		writeRememberedPreset("global:chosen", root);
		assert.equal(runtime.restoreRememberedSelection(ctx), false);
		assert.equal(active, undefined);
		error = undefined;
		syncThrows = true;
		writeRememberedPreset("none", root);
		assert.throws(() => runtime.selectActive("global:chosen", ctx), /sync failed/);
		assert.equal(JSON.parse(readFileSync(join(root, "last-preset.json"), "utf8")).selector, "none");
		syncThrows = false;
		assert.equal(runtime.selectActive("global:chosen", ctx), true);
		assert.equal(JSON.parse(readFileSync(join(root, "last-preset.json"), "utf8")).selector, "global:chosen");
		assert.deepEqual(readdirSync(root), ["last-preset.json"]);
	} finally {
		if (previous === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
