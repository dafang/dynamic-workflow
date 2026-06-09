export function resolveBackendName(value) {
    if (value === undefined || value === "current")
        return "current";
    throw unsupportedBackendError(String(value));
}
export function unsupportedBackendError(name) {
    const error = new Error(`Unsupported backend ${name}; dynamic-workflow MVP only executes backend current.`);
    error.name = "UnsupportedBackendError";
    return error;
}
//# sourceMappingURL=backend.js.map