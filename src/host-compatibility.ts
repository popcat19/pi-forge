import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const UNSUPPORTED_HOST_MESSAGE = "Forge presets require upstream Pi (systemPromptOptions and the context_with_system hook). Required prompt inputs are unavailable; new preset/profile activation and preset compilation/preview are disabled for this session. Earlier selections/settings are not rolled back; Forge continues applying its tool policy independently and does not abort provider dispatch. Use /preset use none to disable the preset.";

/** Session-scoped detection; hook availability cannot be inferred from pi.on(). */
export function createHostCompatibility() {
	let unsupported = false;
	let warned = false;

	function markUnsupported(ctx: ExtensionContext): void {
		unsupported = true;
		if (warned) return;
		warned = true;
		ctx.ui.notify(UNSUPPORTED_HOST_MESSAGE, "warning");
	}

	function activationError(_ctx?: ExtensionContext): string | undefined {
		return unsupported ? UNSUPPORTED_HOST_MESSAGE : undefined;
	}

	function readPromptOptions(ctx: ExtensionCommandContext): BuildSystemPromptOptions | undefined {
		// This getter belongs only to command contexts, not ordinary lifecycle contexts.
		if (typeof ctx.getSystemPromptOptions !== "function") markUnsupported(ctx);
		if (unsupported) return undefined;
		const options = ctx.getSystemPromptOptions();
		if (!options) markUnsupported(ctx);
		return options;
	}

	function commandActivationError(ctx: ExtensionCommandContext): string | undefined {
		// Only command entry points may require this getter. Lifecycle contexts lack it.
		readPromptOptions(ctx);
		return activationError();
	}

	return {
		reset() { unsupported = false; warned = false; },
		isUnsupported: () => unsupported,
		markUnsupported,
		activationError,
		commandActivationError,
		readPromptOptions,
	};
}

export type HostCompatibility = ReturnType<typeof createHostCompatibility>;
