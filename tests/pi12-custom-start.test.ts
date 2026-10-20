import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCapabilityAgentHarness, type CapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";
import { createContext, createHarness, startSession, writeStack } from "./helpers/index-command-harness.ts";
import { getLatestUserMessage } from "../src/compiler.ts";
import { getPreviewSessionMessages } from "../src/preview.ts";
import { resolveHostFamilyVersion } from "../scripts/packed-versions.ts";

const { initTheme, SessionManager } = await import("@earendil-works/pi-coding-agent");
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");
initTheme();
const [hostMajor, hostMinor] = resolveHostFamilyVersion(process.cwd()).split(".").map(Number);
const supportsCustomStart = hostMajor > 1 || (hostMajor === 1 && hostMinor >= 2);
const stack = {
	schemaVersion: 1, id: "wake", autoActivate: true,
	items: [
		{ kind: "block", id: "static", role: "system", content: "STATIC-SENTINEL" },
		{ kind: "block", id: "dynamic", role: "system", content: "LAST=[{{ runtime.lastUserMessage }}]" },
		{ kind: "slot", id: "history", slot: "chat-history" },
	],
	regex: { rules: [{ id: "turn", stage: "history", pattern: "TURN-SECRET", replace: "TURN-REDACTED" }] },
};
function project() {
	const cwd = mkdtempSync(join(tmpdir(), "forge-pi12-wake-"));
	writeStack(cwd, "wake.json", stack);
	return cwd;
}
function assertSystems(h: CapabilityAgentHarness, from: number, expected: string) {
	for (const context of h.streamContexts.slice(from)) {
		const system = getCurrentSystemPrompt(context.messages);
		assert.match(system, /STATIC-SENTINEL/);
		assert.ok(system.includes(`LAST=[${expected}]`), system);
	}
}
async function wake(h: CapabilityAgentHarness, pi: ExtensionAPI) {
	const from = h.streamContexts.length;
	h.setResponses([{ toolCalls: ["fake_read"] }, "wake settled"]);
	pi.sendMessage({ customType: "subagents-completion", content: "CUSTOM-NOT-USER", display: true }, { triggerTurn: true });
	await h.session.waitForIdle();
	assert.equal(h.streamContexts.length, from + 2);
	assert.equal(h.session.extensionRunner.createContext().isIdle(), true);
	assert.equal(h.fetchAttempts, 0);
	return from;
}

// Historical CI hosts do not emit custom before_agent_start at all. Exercise their
// actual behavior, without inventing an event or claiming the 1.2 startup contract.
for (const prior of ["", "HUMAN-MARKER TURN-SECRET"]) {
	test(`real SDK idle custom wake, tools and settlement (${prior ? "after user" : "custom-only startup"})`, async () => {
		const cwd = project();
		let pi!: ExtensionAPI;
		const starts: { custom: boolean; idle: boolean; prompt: boolean }[] = [];
		const h = await createCapabilityAgentHarness({ cwd, native: true, extensionFactories: [api => {
			pi = api;
			api.on("before_agent_start", (event, ctx) => {
				starts.push({ custom: "messageType" in event && event.messageType === "custom", idle: ctx.isIdle(), prompt: "prompt" in event });
			});
		}] });
		try {
			if (prior) { h.setResponses(["done"]); await h.prompt(prior); assertSystems(h, 0, prior); }
			const users = h.manager.buildSessionProjection().messages.filter(m => m.role === "user");
			for (let i = 0; i < 2; i++) {
				const from = await wake(h, pi);
				if (supportsCustomStart) {
					assertSystems(h, from, prior);
					assert.deepEqual(starts.at(-1), { custom: true, idle: false, prompt: false });
					if (prior) {
						assert.match(JSON.stringify(h.streamContexts[from].messages), /TURN-REDACTED/);
						assert.match(JSON.stringify(h.streamContexts[from + 1].messages), /TURN-SECRET/);
					}
				} else assert.equal(starts.filter(s => s.custom).length, 0);
			}
			assert.deepEqual(h.manager.buildSessionProjection().messages.filter(m => m.role === "user"), users, "custom wake never fabricates user history");
			// A new user run after settlement must not inherit the custom snapshot.
			h.setResponses(["new user done"]); const from = h.streamContexts.length;
			await h.prompt("NEXT-USER"); assertSystems(h, from, "NEXT-USER");
		} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("real SDK busy custom steering stays in the user compile-run snapshot", async () => {
	const cwd = project(); let pi!: ExtensionAPI;
	const h = await createCapabilityAgentHarness({ cwd, native: true, extensionFactories: [api => { pi = api; }] });
	try {
		h.setOnDriver(ctx => {
			assert.equal(ctx.isIdle(), false);
			pi.sendMessage({ customType: "subagents-completion", content: "BUSY-CUSTOM", display: true }, { deliverAs: "steer", triggerTurn: true });
		});
		h.setResponses([{ toolCalls: ["fake_driver"] }, "steering done", "settled"]);
		await h.prompt("BUSY-USER"); await h.session.waitForIdle();
		assertSystems(h, 0, "BUSY-USER");
		assert.equal(h.beforeAgentStartEvents.length, 1);
		assert.ok(h.streamContexts.length >= 2);
		assert.match(JSON.stringify(h.streamContexts.at(-1)), /BUSY-CUSTOM/);
		assert.equal(h.fetchAttempts, 0);
	} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("real SDK custom wake uses branch/resume/compaction projection, not abandoned or summarized user history", async () => {
	const cwd = project(); const sessionDir = join(cwd, "sessions"); let pi!: ExtensionAPI;
	const factory = (api: ExtensionAPI) => { pi = api; };
	let h = await createCapabilityAgentHarness({ cwd, native: true, sessionManager: SessionManager.create(cwd, sessionDir), extensionFactories: [factory] });
	try {
		h.setResponses(["first done"]); await h.prompt("BRANCH-USER");
		const branchLeaf = h.manager.getLeafId()!;
		h.setResponses(["abandoned done"]); await h.prompt("ABANDONED-USER");
		await h.session.navigateTree(branchLeaf, { summarize: false });
		let from = await wake(h, pi);
		if (supportsCustomStart) assertSystems(h, from, "BRANCH-USER");
		const file = h.manager.getSessionFile()!;
		await h.dispose();
		h = await createCapabilityAgentHarness({ cwd, native: true, sessionManager: SessionManager.open(file, sessionDir, cwd), extensionFactories: [factory] });
		from = await wake(h, pi);
		if (supportsCustomStart) assertSystems(h, from, "BRANCH-USER");
		h.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } });
		h.setResponses(["compaction summary", "turn prefix summary"]);
		await h.session.compact();
		const expected = getLatestUserMessage(getPreviewSessionMessages(h.session.extensionRunner.createContext())) ?? "";
		assert.equal(expected, "", "compacted user text must not be recovered from raw old entries");
		from = await wake(h, pi);
		if (supportsCustomStart) assertSystems(h, from, expected);
	} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

for (const messageType of [undefined, "user"]) for (const prompt of ["EXPANDED-PROMPT", ""]) {
	test(`legacy/user prompt remains authoritative before System compilation (${messageType}, ${JSON.stringify(prompt)})`, async () => {
		const cwd = project(); const h = createHarness();
		const { ctx } = createContext(cwd, [{ type: "message", id: "old", parentId: null, message: { role: "user", content: "OLD-HISTORY", timestamp: 1 } }]);
		try {
			await startSession(h, ctx);
			await h.events.before_agent_start({ ...(messageType ? { messageType } : {}), prompt, images: prompt ? undefined : [{ type: "image", data: "AA==", mimeType: "image/png" }], systemPrompt: "base", systemPromptOptions: ctx.getSystemPromptOptions() }, ctx);
			const result = await h.events.context_with_system({ messages: [{ role: "user", content: "HISTORY-IS-NOT-EXPANDED-PROMPT", timestamp: 2 }] }, ctx);
			assert.match(result.messages[0].content, /STATIC-SENTINEL/);
			assert.ok(result.messages[0].content.includes(`LAST=[${prompt}]`));
		} finally { await h.events.session_shutdown({}, ctx); rmSync(cwd, { recursive: true, force: true }); }
	});
}

for (const image of [false, true]) test(`custom snapshot follows history helper (image=${image}) and freezes before context rewriting`, async () => {
	const cwd = project(); const h = createHarness();
	writeStack(cwd, "wake.json", { ...stack, items: [
		...stack.items,
		{ kind: "block", id: "snapshot", role: "user", content: "SNAPSHOT=[{{ runtime.lastUserMessage }}]" },
	] });
	const entries = [
		{ type: "message", id: "text", parentId: null, message: { role: "user", content: "ELIGIBLE", timestamp: 1 } },
		{ type: "message", id: "empty", parentId: "text", message: { role: "user", content: "  ", timestamp: 2 } },
		...(image ? [{ type: "message", id: "image", parentId: "empty", message: { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 3 } }] : []),
	];
	const { ctx } = createContext(cwd, entries, { idle: false });
	try {
		await startSession(h, ctx);
		await h.events.before_agent_start({ messageType: "custom", message: { role: "custom", content: "NOT-USER" }, systemPrompt: "base", systemPromptOptions: ctx.getSystemPromptOptions() }, ctx);
		for (let i = 0; i < 2; i++) {
			// Simulate a host context projection / tool followup containing different text.
			const result = await h.events.context_with_system({ messages: [{ role: "user", content: "LATE-TEXT", timestamp: 4 }] }, ctx);
			// Existing preview helper deliberately renders image content as [image].
			const expected = image ? "[image]" : "ELIGIBLE";
			assert.ok(result.messages[0].content.includes(`LAST=[${expected}]`));
			if (i === 0) assert.ok(JSON.stringify(result.messages).includes(`SNAPSHOT=[${expected}]`), "message compilation shares the frozen custom snapshot");
		}
	} finally { await h.events.session_shutdown({}, ctx); rmSync(cwd, { recursive: true, force: true }); }
});
