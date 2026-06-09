import { getStepDefinition } from "./registry.js";
export function computeResourceLocks(steps, defaultScope = "workspace") {
    const locks = [];
    for (const step of steps) {
        const definition = getStepDefinition(step.type);
        const scopeValue = step.input?.resource_scope;
        const scope = typeof scopeValue === "string" && scopeValue.trim() !== "" ? scopeValue : defaultScope;
        if (definition.mayWrite) {
            locks.push({ step_id: step.step_id, scope, mode: "write" });
        }
        else {
            locks.push({ step_id: step.step_id, scope, mode: "read" });
        }
    }
    return locks;
}
export function writerConflicts(locks, dependencies = {}) {
    const writersByScope = new Map();
    for (const lock of locks) {
        if (lock.mode !== "write")
            continue;
        writersByScope.set(lock.scope, [...(writersByScope.get(lock.scope) ?? []), lock.step_id]);
    }
    const conflicts = {};
    for (const [scope, writers] of writersByScope.entries()) {
        const concurrent = writers.filter((writer, index) => writers.some((other, otherIndex) => otherIndex !== index && !hasDependencyPath(writer, other, dependencies) && !hasDependencyPath(other, writer, dependencies)));
        if (concurrent.length > 1) {
            conflicts[scope] = concurrent;
        }
    }
    return conflicts;
}
function hasDependencyPath(from, to, dependencies) {
    const visited = new Set();
    const queue = [...(dependencies[from] ?? [])];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current))
            continue;
        if (current === to)
            return true;
        visited.add(current);
        queue.push(...(dependencies[current] ?? []));
    }
    return false;
}
//# sourceMappingURL=resources.js.map