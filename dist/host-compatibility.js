export const UNSUPPORTED_HOST_MESSAGE = "Forge presets require upstream Pi (systemPromptOptions and the context_with_system hook). Preset prompt compilation is disabled on this unsupported host; tool policy is still enforced.";
/** Session-scoped detection; hook availability cannot be inferred from pi.on(). */
export function createHostCompatibility() {
    let unsupported = false;
    let warned = false;
    function markUnsupported(ctx) {
        unsupported = true;
        if (warned)
            return;
        warned = true;
        ctx.ui.notify(UNSUPPORTED_HOST_MESSAGE, "warning");
    }
    function activationError(_ctx) {
        return unsupported ? UNSUPPORTED_HOST_MESSAGE : undefined;
    }
    function readPromptOptions(ctx) {
        // This getter belongs only to command contexts, not ordinary lifecycle contexts.
        if (typeof ctx.getSystemPromptOptions !== "function")
            markUnsupported(ctx);
        if (unsupported)
            return undefined;
        const options = ctx.getSystemPromptOptions();
        if (!options)
            markUnsupported(ctx);
        return options;
    }
    return {
        reset() { unsupported = false; warned = false; },
        isUnsupported: () => unsupported,
        markUnsupported,
        activationError,
        readPromptOptions,
    };
}
//# sourceMappingURL=host-compatibility.js.map