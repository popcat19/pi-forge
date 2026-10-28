import { randomUUID } from "node:crypto";
import { activeStateProjectKey } from "./active-state.js";
import { parseResourceSelector } from "./resource-identity.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
/** Development/test override for the user-owned global Forge root. */
export const GLOBAL_FORGE_DIR_ENV = "PI_FORGE_GLOBAL_DIR";
export function promptStacksDir(cwd) {
    return join(cwd, ".pi", "forge", "prompt-stacks");
}
export function agentProfilesDir(cwd) {
    return join(cwd, ".pi", "forge", "agent-profiles");
}
export function agentProfilePath(cwd, id) {
    return join(agentProfilesDir(cwd), `${id}.json`);
}
export function isInsideAgentProfileStorage(cwd, filePath) {
    return isInsideDir(agentProfilesDir(cwd), filePath);
}
export function isSafeAgentProfileMutationPath(cwd, filePath) {
    if (!isInsideAgentProfileStorage(cwd, filePath))
        return false;
    return pathTraversesNoSymlink(cwd, filePath);
}
export function forgeDir(cwd) {
    return join(cwd, ".pi", "forge");
}
export function forgeExtensionsDir(cwd) {
    return join(forgeDir(cwd), "extensions");
}
export function globalForgeDir() {
    return process.env[GLOBAL_FORGE_DIR_ENV] ?? join(homedir(), ".pi", "forge");
}
export function globalPromptStacksDir() {
    return join(globalForgeDir(), "prompt-stacks");
}
export function globalAgentProfilesDir() {
    return join(globalForgeDir(), "agent-profiles");
}
export function globalAgentProfilePath(id) {
    return join(globalAgentProfilesDir(), `${id}.json`);
}
export function globalForgeExtensionsDir() {
    return join(globalForgeDir(), "extensions");
}
export function isInsideGlobalAgentProfileStorage(filePath) {
    return isInsideDir(globalAgentProfilesDir(), filePath);
}
export function isSafeGlobalAgentProfileMutationPath(filePath) {
    if (!isInsideGlobalAgentProfileStorage(filePath))
        return false;
    return pathTraversesNoSymlink(globalForgeDir(), filePath);
}
export function legacyPromptStacksDir(cwd) {
    return join(cwd, ".pi", "prompt-stacks");
}
export function promptStackReadDirs(cwd) {
    return [promptStacksDir(cwd), legacyPromptStacksDir(cwd)];
}
export function promptStackPath(cwd, id) {
    return join(promptStacksDir(cwd), `${id}.json`);
}
export function isInsidePromptStackStorage(cwd, filePath) {
    return promptStackReadDirs(cwd).some((dir) => isInsideDir(dir, filePath));
}
export function isSafePromptStackMutationPath(cwd, filePath) {
    if (!isInsidePromptStackStorage(cwd, filePath))
        return false;
    return pathTraversesNoSymlink(cwd, filePath);
}
export function isInsideGlobalPromptStackStorage(filePath) {
    return isInsideDir(globalPromptStacksDir(), filePath);
}
export function isSafeGlobalPromptStackMutationPath(filePath) {
    if (!isInsideGlobalPromptStackStorage(filePath))
        return false;
    return pathTraversesNoSymlink(globalForgeDir(), filePath);
}
function isInsideDir(rootDir, filePath) {
    const root = resolve(rootDir);
    const target = resolve(filePath);
    const rel = relative(root, target);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
function pathTraversesNoSymlink(root, filePath) {
    const resolvedRoot = resolve(root);
    const target = resolve(filePath);
    let current = resolvedRoot;
    for (const segment of relative(resolvedRoot, target).split(sep)) {
        current = join(current, segment);
        if (existsSync(current) && lstatSync(current).isSymbolicLink())
            return false;
    }
    return true;
}
export function readRememberedPreset(cwd) {
    try {
        const value = JSON.parse(readFileSync(join(globalForgeDir(), "last-preset.json"), "utf8"));
        if (!value || value.version !== 1 || typeof value.selector !== "string")
            return undefined;
        if (value.selector === "none")
            return "none";
        const parsed = parseResourceSelector(value.selector);
        if (!parsed.ok || !parsed.selector.scope)
            return undefined;
        if (parsed.selector.scope === "project" && value.projectKey !== activeStateProjectKey(cwd))
            return undefined;
        return value.selector;
    }
    catch {
        return undefined;
    }
}
export function writeRememberedPreset(selector, cwd) {
    const dir = globalForgeDir();
    const temporary = join(dir, `.last-preset-${randomUUID()}.tmp`);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(temporary, JSON.stringify({
            version: 1,
            selector,
            ...(selector.startsWith("project:") ? { projectKey: activeStateProjectKey(cwd) } : {}),
        }) + "\n", { flag: "wx", mode: 0o600 });
        renameSync(temporary, join(dir, "last-preset.json"));
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
//# sourceMappingURL=storage.js.map