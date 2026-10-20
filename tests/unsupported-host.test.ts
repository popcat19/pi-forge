import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { UNSUPPORTED_HOST_MESSAGE } from "../src/host-compatibility.ts";
import { promptRuntimeFromCompileOptions, promptRuntimeFromPi } from "../src/prompt-runtime.ts";
import { createContext, createHarness, latestEditorUrl, startSession, writeProfile, writeStack } from "./helpers/index-command-harness.ts";

async function setup(t: TestContext, policy: "allow" | "deny" = "allow", autoProfile = false) {
	const cwd = mkdtempSync(join(tmpdir(), "forge-unsupported-host-"));
	writeStack(cwd, "restricted.json", {
		schemaVersion: 1, id: "restricted", autoActivate: true,
		tools: policy === "allow" ? { allow: ["read"] } : { deny: ["bash"] },
		items: [{ kind: "block", id: "system", role: "system", content: "FORGE_SENTINEL" }],
	});
	writeStack(cwd, "other.json", { schemaVersion: 1, id: "other", items: [] });
	const model = { provider: "test", id: "model", api: "openai-completions", reasoning: false };
	const targetModel = { ...model, id: "target", reasoning: true };
	const harness = createHarness({ activeTools: ["read", "bash"], currentModel: model, models: [model, targetModel] });
	const context = createContext(cwd, [], { modelRuntime: harness });
	for (const [id, promptStack] of [["with-preset", "other"], ["without-preset", null]] as const) {
		writeProfile(cwd, `${id}.json`, { schemaVersion: 1, type: "pi-forge.agent-profile", id, autoActivate: autoProfile && id === "with-preset", model: { provider: "test", id: "target" }, thinkingLevel: "high", promptStack: autoProfile && id === "with-preset" ? "restricted" : promptStack });
	}
	let aborts = 0;
	context.ctx.abort = () => { aborts++; };
	t.after(async () => {
		await harness.commands.preset.handler("ui stop", context.ctx);
		await harness.events.session_shutdown({}, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	});
	// Session lifecycle contexts intentionally have no command-only prompt getter.
	const lifecycleCtx = Object.create(context.ctx);
	Object.defineProperty(lifecycleCtx, "getSystemPromptOptions", { value: undefined });
	await startSession(harness, lifecycleCtx);
	const missingTurn = () => harness.events.before_agent_start({ prompt: "hello", systemPrompt: ["omp base"] }, context.ctx);
	const warnings = () => context.notifications.filter(n => n.message === UNSUPPORTED_HOST_MESSAGE && n.type === "warning");
	return { harness, context, lifecycleCtx, missingTurn, warnings, aborts: () => aborts };
}

test("missing options never throw or abort; warn only once across turns, retaining no stale compilation", async (t) => {
	const f = await setup(t);
	const validEvent = { prompt: "hello", systemPrompt: "base", systemPromptOptions: f.context.ctx.getSystemPromptOptions() };
	await f.harness.events.before_agent_start(validEvent, f.context.ctx);
	const messages = [{ role: "system", content: "base", timestamp: 0 }];
	const normal = await f.harness.events.context_with_system({ messages }, f.context.ctx);
	assert.match(normal.messages[0].content, /FORGE_SENTINEL/);
	for (let i = 0; i < 3; i++) {
		await assert.doesNotReject(f.missingTurn());
		const result = await f.harness.events.context_with_system({ messages }, f.context.ctx);
		assert.deepEqual(result?.messages ?? messages, messages);
		await f.harness.events.agent_settled({}, f.context.ctx);
	}
	// A later valid event cannot silently re-enable a session already rejected.
	await f.harness.events.before_agent_start(validEvent, f.context.ctx);
	const disabled = await f.harness.events.context_with_system({ messages }, f.context.ctx);
	assert.deepEqual(disabled?.messages ?? messages, messages);
	assert.equal(f.warnings().length, 1);
	assert.equal(f.aborts(), 0);
});

for (const getter of ["missing", "empty"] as const) {
	for (const [command, args] of [["preset", "use other"], ["profile", "use with-preset"], ["profile", "use without-preset"]]) {
		test(`CLI ${command} ${args} preflights ${getter} prompt getter before the first turn`, async (t) => {
			const f = await setup(t);
			if (getter === "missing") delete f.context.ctx.getSystemPromptOptions;
			else f.context.ctx.getSystemPromptOptions = () => undefined;
			const before = {
				tools: f.harness.getActiveTools(), persisted: structuredClone(f.harness.appended),
				statuses: { ...f.context.statuses }, model: f.harness.getCurrentModel(), thinking: f.harness.getThinkingLevel(),
			};
			await assert.doesNotReject(f.harness.commands[command].handler(args, f.context.ctx));
			assert.equal(f.context.notifications.at(-1)!.message, UNSUPPORTED_HOST_MESSAGE);
			assert.deepEqual({
				tools: f.harness.getActiveTools(), persisted: f.harness.appended,
				statuses: f.context.statuses, model: f.harness.getCurrentModel(), thinking: f.harness.getThinkingLevel(),
			}, before);
			assert.equal(f.harness.setModelCalls.length, 0);
			assert.equal(f.harness.setThinkingLevelCalls.length, 0);
			await f.missingTurn();
			assert.equal(f.warnings().length, 1);
			await f.harness.commands.preset.handler("use off", f.context.ctx);
			assert.deepEqual(f.harness.getActiveTools(), ["read", "bash"]);
		});
	}
}

test("early auto-profile settings and policy remain applied after first-turn unsupported detection", async (t) => {
	const f = await setup(t, "allow", true);
	assert.equal(f.warnings().length, 0, "ordinary lifecycle contexts need no command getter");
	assert.equal(f.harness.getCurrentModel().id, "target");
	assert.equal(f.harness.getThinkingLevel(), "high");
	assert.deepEqual(f.harness.getActiveTools(), ["read"]);
	// Supported-host notices stay terse; the not-rolled-back boundary is stated once detection happens.
	assert.ok(f.context.notifications.some(n => /auto-activated profile/.test(n.message)));
	assert.ok(!f.context.notifications.some(n => /prompt compatibility/.test(n.message)));
	const before = structuredClone(f.harness.appended);
	await f.missingTurn();
	await f.harness.events.input({}, f.lifecycleCtx);
	await f.harness.events.turn_start({}, f.lifecycleCtx);
	assert.equal(f.harness.getCurrentModel().id, "target");
	assert.equal(f.harness.getThinkingLevel(), "high");
	assert.equal(f.harness.setModelCalls.length, 1);
	assert.equal(f.harness.setThinkingLevelCalls.length, 1);
	assert.deepEqual(f.harness.getActiveTools(), ["read"]);
	assert.deepEqual(f.harness.appended, before);
	assert.equal(f.warnings().length, 1);
	assert.equal(f.aborts(), 0);
});

test("unsupported host refuses CLI preset and profile activation without changing selection, model or policy", async (t) => {
	const f = await setup(t);
	await f.missingTurn();
	const before = { tools: f.harness.getActiveTools(), persisted: structuredClone(f.harness.appended), status: f.context.statuses["pi-forge"] };
	for (const [command, args] of [["preset", "use other"], ["profile", "use with-preset"], ["profile", "use without-preset"]]) {
		await f.harness.commands[command].handler(args, f.context.ctx);
		assert.equal(f.context.notifications.at(-1)!.message, UNSUPPORTED_HOST_MESSAGE);
	}
	assert.deepEqual({ tools: f.harness.getActiveTools(), persisted: f.harness.appended, status: f.context.statuses["pi-forge"] }, before);
	assert.equal(f.harness.setModelCalls.length, 0);
	assert.equal(f.harness.setThinkingLevelCalls.length, 0);
	assert.equal(f.warnings().length, 1);
});

for (const policy of ["allow", "deny"] as const) test(`unsupported host preserves ${policy} tool selection and execution blocking`, async (t) => {
	const f = await setup(t, policy);
	await f.missingTurn();
	for (let i = 0; i < 3; i++) {
		await f.harness.events.input({}, f.context.ctx);
		await f.harness.events.turn_start({}, f.context.ctx);
		assert.deepEqual(f.harness.getActiveTools(), ["read"]);
		assert.deepEqual(await f.harness.events.tool_call({ toolName: "bash" }, f.context.ctx), {
			block: true, reason: 'Tool "bash" is blocked by prompt stack "restricted".',
		});
		assert.equal(await f.harness.events.tool_call({ toolName: "read" }, f.context.ctx), undefined);
		await f.missingTurn();
	}
	// Explicit disabling is still available; unsupported detection itself never clears policy.
	await f.harness.commands.preset.handler("use none", f.context.ctx);
	assert.deepEqual(f.harness.getActiveTools(), ["read", "bash"]);
});

test("warning budget is per session, not per compile cycle or tree navigation", async (t) => {
	const f = await setup(t);
	await f.missingTurn();
	await f.harness.events.session_tree({}, f.context.ctx);
	await f.harness.events.session_compact({}, f.context.ctx);
	await f.harness.events.agent_settled({}, f.context.ctx);
	assert.deepEqual(f.harness.getActiveTools(), ["read"]);
	assert.equal((await f.harness.events.tool_call({ toolName: "bash" }, f.context.ctx)).block, true);
	await f.missingTurn();
	assert.equal(f.warnings().length, 1);
	await startSession(f.harness, f.lifecycleCtx);
	await f.harness.events.before_agent_start({ prompt: "recovered", systemPrompt: "base", systemPromptOptions: f.context.ctx.getSystemPromptOptions() }, f.lifecycleCtx);
	const recovered = await f.harness.events.context_with_system({ messages: [{ role: "system", content: "base", timestamp: 0 }] }, f.lifecycleCtx);
	assert.match(recovered.messages[0].content, /FORGE_SENTINEL/);
	await f.missingTurn();
	assert.equal(f.warnings().length, 2);
});

test("missing command getter disables preview and web editor gracefully", async (t) => {
	const f = await setup(t);
	delete f.context.ctx.getSystemPromptOptions;
	await assert.doesNotReject(f.harness.commands.preset.handler("preview restricted", f.context.ctx));
	assert.equal(f.context.editors.at(-1)!.text, UNSUPPORTED_HOST_MESSAGE);
	await assert.doesNotReject(f.harness.commands.preset.handler("ui", f.context.ctx));
	await f.missingTurn();
	assert.equal(f.warnings().length, 1);
	assert.equal(f.aborts(), 0);
});

test("already-open web editor refuses stale preview and activation after unsupported detection, but allows disable", async (t) => {
	const f = await setup(t);
	await f.harness.commands.preset.handler("ui", f.context.ctx);
	const url = latestEditorUrl(f.context.editors);
	const headers = { "x-pi-forge-token": url.searchParams.get("token")!, "content-type": "application/json" };
	const preview = () => fetch(new URL("/api/stacks/restricted/preview", url), {
		method: "POST", headers,
		body: JSON.stringify({ stack: { schemaVersion: 1, id: "restricted", items: [{ kind: "block", id: "system", role: "system", content: "WEB_PREVIEW_SENTINEL" }] } }),
	});
	const initial = await preview();
	assert.equal(initial.status, 200);
	assert.match((await initial.json() as { text: string }).text, /WEB_PREVIEW_SENTINEL/);
	await f.missingTurn();
	// Cached options survive in the open editor; they must not yield a hypothetical preview.
	for (let i = 0; i < 2; i++) {
		const response = await preview();
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), { error: UNSUPPORTED_HOST_MESSAGE });
	}
	const before = f.harness.getActiveTools();
	for (const path of ["/api/stacks/other/activate", "/api/profiles/with-preset/apply", "/api/profiles/without-preset/apply"]) {
		const response = await fetch(new URL(path, url), { method: "POST", headers: { "x-pi-forge-token": url.searchParams.get("token")! } });
		assert.equal(response.status, 409);
		assert.match((await response.json() as { error: string }).error, /Forge presets require upstream Pi/);
	}
	assert.deepEqual(f.harness.getActiveTools(), before);
	assert.equal(f.harness.setModelCalls.length, 0);
	assert.equal(f.harness.setThinkingLevelCalls.length, 0);
	assert.equal(f.warnings().length, 1);
	const disable = await fetch(new URL("/api/disable", url), { method: "POST", headers });
	assert.equal(disable.status, 200);
	await disable.json();
	assert.deepEqual(f.harness.getActiveTools(), ["read", "bash"]);
});

test("normal Pi still compiles and activates with no unsupported warning", async (t) => {
	const f = await setup(t);
	// Upstream Pi ordinary lifecycle contexts do not have the command-only getter.
	const lifecycleCtx = { ...f.context.ctx };
	delete lifecycleCtx.getSystemPromptOptions;
	await f.harness.events.before_agent_start({ prompt: "hello", systemPrompt: "base", systemPromptOptions: f.context.ctx.getSystemPromptOptions() }, lifecycleCtx);
	const result = await f.harness.events.context_with_system({ messages: [{ role: "system", content: "base", timestamp: 0 }] }, lifecycleCtx);
	assert.match(result.messages[0].content, /FORGE_SENTINEL/);
	await f.harness.events.agent_settled({}, f.context.ctx);
	await f.harness.commands.preset.handler("use other", f.context.ctx);
	assert.equal(f.context.statuses["pi-forge"], "stack:other");
	await f.harness.commands.profile.handler("use with-preset", f.context.ctx);
	assert.match(f.context.notifications.at(-1)!.message, /applied profile/);
	assert.equal(f.warnings().length, 0);
	assert.equal(f.aborts(), 0);
});

test("getter returning no options warns once and refuses editor and activation", async (t) => {
	const f = await setup(t);
	f.context.ctx.getSystemPromptOptions = () => undefined;
	await assert.doesNotReject(f.harness.commands.preset.handler("ui", f.context.ctx));
	await assert.doesNotReject(f.harness.commands.preset.handler("preview restricted", f.context.ctx));
	await f.harness.commands.preset.handler("use other", f.context.ctx);
	assert.equal(f.context.notifications.at(-1)!.message, UNSUPPORTED_HOST_MESSAGE);
	assert.equal(f.warnings().length, 1);
	assert.deepEqual(f.harness.getActiveTools(), ["read"]);
});

test("missing options warns even with no preset, without changing the baseline toolset", async (t) => {
	const f = await setup(t);
	await f.harness.commands.preset.handler("use none", f.context.ctx);
	await assert.doesNotReject(f.missingTurn());
	await assert.doesNotReject(f.missingTurn());
	assert.deepEqual(f.harness.getActiveTools(), ["read", "bash"]);
	assert.equal(f.warnings().length, 1);
	assert.equal(f.aborts(), 0);
});

test("compiler adapters reject missing inputs centrally with a clear error, never an undefined dereference", () => {
	for (const adapt of [() => promptRuntimeFromPi(undefined, undefined), () => promptRuntimeFromCompileOptions(undefined)]) {
		assert.throws(adapt, { name: "Error", message: UNSUPPORTED_HOST_MESSAGE });
	}
});
