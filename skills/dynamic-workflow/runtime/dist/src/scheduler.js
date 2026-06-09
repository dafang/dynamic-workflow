export function initialStepStates(manifest) {
    return Object.fromEntries(manifest.nodes.map((node) => [
        node.step_id,
        {
            step_id: node.step_id,
            state: "queued",
            attempts: 0
        }
    ]));
}
export function getReadyStepIds(manifest, states) {
    return manifest.nodes
        .filter((node) => states[node.step_id]?.state === "queued")
        .filter((node) => node.depends_on.every((dependency) => {
        const dependencyState = states[dependency]?.state;
        return dependencyState === "succeeded" || dependencyState === "skipped";
    }))
        .map((node) => node.step_id)
        .sort();
}
export function blockDownstream(manifest, states, failedStepId) {
    const queue = [...(manifest.reverse_dependencies[failedStepId] ?? [])];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            continue;
        const state = states[current];
        if (state && state.state === "queued") {
            state.state = "blocked";
            state.failure = `Blocked by failed dependency ${failedStepId}.`;
        }
        queue.push(...(manifest.reverse_dependencies[current] ?? []));
    }
}
//# sourceMappingURL=scheduler.js.map