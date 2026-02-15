/**
 * TypeScript types for GitHub Projects V2 GraphQL responses.
 *
 * These types model the GraphQL schema for Projects V2, Issues,
 * and related entities used throughout the MCP server.
 */
export function toolSuccess(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
export function toolError(message) {
    return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
export function resolveProjectOwner(config) {
    return config.projectOwner || config.owner;
}
//# sourceMappingURL=types.js.map