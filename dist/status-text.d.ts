import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type StatusColor = Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0];
/** Presentation-only fallback; never wraps status delivery or runtime state changes. */
export declare function formatStatusText(ctx: Pick<ExtensionContext, "ui">, color: StatusColor, text: string): string;
export {};
//# sourceMappingURL=status-text.d.ts.map