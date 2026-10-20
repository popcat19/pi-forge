import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const UNSUPPORTED_HOST_MESSAGE = "Forge presets require upstream Pi (systemPromptOptions and the context_with_system hook). Required prompt inputs are unavailable; new preset/profile activation and preset compilation/preview are disabled for this session. Earlier selections/settings are not rolled back; Forge continues applying its tool policy independently and does not abort provider dispatch. Use /preset use none to disable the preset.";
/** Session-scoped detection; hook availability cannot be inferred from pi.on(). */
export declare function createHostCompatibility(): {
    reset(): void;
    isUnsupported: () => boolean;
    markUnsupported: (ctx: ExtensionContext) => void;
    activationError: (_ctx?: ExtensionContext) => string | undefined;
    commandActivationError: (ctx: ExtensionCommandContext) => string | undefined;
    readPromptOptions: (ctx: ExtensionCommandContext) => BuildSystemPromptOptions | undefined;
};
export type HostCompatibility = ReturnType<typeof createHostCompatibility>;
//# sourceMappingURL=host-compatibility.d.ts.map