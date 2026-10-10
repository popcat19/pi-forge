import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const UNSUPPORTED_HOST_MESSAGE = "Forge presets require upstream Pi (systemPromptOptions and the context_with_system hook). Preset prompt compilation is disabled on this unsupported host; tool policy is still enforced.";
/** Session-scoped detection; hook availability cannot be inferred from pi.on(). */
export declare function createHostCompatibility(): {
    reset(): void;
    isUnsupported: () => boolean;
    markUnsupported: (ctx: ExtensionContext) => void;
    activationError: (_ctx?: ExtensionContext) => string | undefined;
    readPromptOptions: (ctx: ExtensionCommandContext) => BuildSystemPromptOptions | undefined;
};
export type HostCompatibility = ReturnType<typeof createHostCompatibility>;
//# sourceMappingURL=host-compatibility.d.ts.map