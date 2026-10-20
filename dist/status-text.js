/** Presentation-only fallback; never wraps status delivery or runtime state changes. */
export function formatStatusText(ctx, color, text) {
    try {
        return ctx.ui.theme?.fg(color, text) ?? text;
    }
    catch {
        // Custom hosts may omit theme; uninitialized SDK theme proxies can throw.
        return text;
    }
}
//# sourceMappingURL=status-text.js.map