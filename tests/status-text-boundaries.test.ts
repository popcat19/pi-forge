import assert from "node:assert/strict";
import test from "node:test";
import { formatStatusText } from "../src/status-text.ts";
import { createPromptStackRuntime } from "../src/runtime/prompt-stack-runtime.ts";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import { registerPayloadCommands, armPayloadIntercept } from "../src/payload-command.ts";
import { createPayloadState } from "../src/payload-state.ts";

test("formatting handles Proxy/getter faults without caching failure or losing receiver/empty output", () => {
	const revocable = Proxy.revocable({}, {});
	revocable.revoke();
	const ctx: any = { ui: { theme: revocable.proxy } };
	assert.equal(formatStatusText(ctx, "accent", "plain"), "plain");
	let gets = 0;
	const target = {
		tag: "ok",
		get fg() {
			gets++;
			return function (this: any, _color: string, text: string) {
				assert.equal(this, proxy);
				return this.tag + ":" + text;
			};
		},
	};
	const proxy = new Proxy(target, {});
	ctx.ui.theme = proxy;
	assert.equal(formatStatusText(ctx, "accent", "plain"), "ok:plain");
	assert.equal(gets, 1);
	ctx.ui.theme = { get fg() { throw new Error("getter fault"); } };
	assert.equal(formatStatusText(ctx, "accent", "plain"), "plain");
	for (const output of ["", null, undefined]) {
		ctx.ui.theme = { fg() { return output; } };
		assert.equal(formatStatusText(ctx, "accent", "plain"), output ?? "plain");
	}
	ctx.ui.theme = proxy;
	assert.equal(formatStatusText(ctx, "accent", "plain"), "ok:plain");
	assert.equal(gets, 2);
});

test("reload continues post-status tool-policy sync with a throwing theme and hasUI=false", async () => {
	let syncs = 0, reloads = 0;
	const workspace: any = {
		loadExtensions: async () => {},
		reload() { reloads++; },
		snapshot: () => ({ active: { stack: { id: "probe" } } }),
	};
	const runtime = createPromptStackRuntime({} as any, workspace, {} as any, {
		syncToolPolicy() { syncs++; },
	});
	const statuses: Record<string, string | undefined> = {};
	const ctx: any = {
		hasUI: false, cwd: "/fixture", isProjectTrusted: () => true,
		ui: {
			theme: { fg() { throw new Error("bad theme"); } },
			setStatus(key: string, value: string) { statuses[key] = value; },
		},
	};
	await runtime.reloadStacks(ctx);
	assert.equal(syncs, 1);
	assert.equal(reloads, 1);
	assert.equal(statuses["pi-forge"], "stack:probe");
});

test("payload formatting failure does not interrupt overwrite assignment or notification", async () => {
	const state = createPayloadState();
	let notifications = 0;
	const statuses: Record<string, string | undefined> = {};
	const command = registerPayloadCommands({ registerCommand() {} } as any, state);
	const ctx: any = {
		cwd: "/fixture", hasUI: false, isProjectTrusted: () => true,
		ui: {
			theme: undefined,
			setStatus(key: string, value: string) { statuses[key] = value; },
			notify() { notifications++; },
		},
	};
	await command.handler("next save=not-created.json --overwrite", ctx);
	assert.equal(state.interceptNextProviderPayload, true);
	assert.equal(state.interceptPayloadOverwrite, true);
	assert.equal(notifications, 1);
	assert.equal(statuses["pi-forge-intercept"], "payload:armed+save");
});

test("status getter, tool mutation and notification failures propagate by identity", () => {
	const fault = new Error("non-presentation fault");
	const cycle: any = {};
	const runtime = createPromptStackRuntime(
		{} as any, { snapshot: () => ({ active: { stack: { id: "probe" } } }) } as any,
		cycle, { syncToolPolicy() {} },
	);
	const ui: any = { theme: undefined, get setStatus() { throw fault; } };
	assert.throws(() => runtime.updateStatus({ ui } as any), error => error === fault);
	const diagnostics: any = [{ level: "error", message: "bad" }];
	assert.throws(() => runtime.recordCompileDiagnostics({ ui } as any, diagnostics), error => error === fault);
	assert.equal(cycle.latestCompileDiagnostics, diagnostics);
	const toolRuntime = createToolPolicyRuntime({
		getActiveTools: () => ["bash"],
		getAllTools: () => [{ name: "bash" }, { name: "read" }],
		setActiveTools() { throw fault; },
	} as any, () => ({ stack: { tools: { allow: ["read"], initial: ["read"] } } }) as any);
	assert.throws(() => toolRuntime.sync({ ui: {
		theme: undefined, setStatus() { assert.fail("must not reach status"); },
	} } as any), error => error === fault);
	const ctx: any = { ui: { theme: undefined, setStatus() {}, notify() { throw fault; } } };
	assert.throws(() => armPayloadIntercept(createPayloadState(), ctx, undefined, "web"), error => error === fault);
});
