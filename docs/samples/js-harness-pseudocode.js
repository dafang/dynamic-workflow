// Claude-style dynamic workflow harness pseudocode.
// This is not meant to be executed directly. It illustrates how a JS runtime
// could expose controlled workflow primitives to an agent-generated script.

export default async function runWorkflow(ctx) {
  const classification = await agent("Classify the user request.", {
    input: ctx.userRequest,
    role: "classifier",
    outputSchema: {
      kind: ["single_function", "multi_function_build", "debug", "research"],
      confidence: "number",
      reason: "string",
    },
  })

  if (classification.confidence < 0.7) {
    return askUser("I need one clarification before planning this workflow.")
  }

  if (classification.kind === "multi_function_build") {
    const buildResults = await parallel([
      agent("Build function A from the requested app capabilities.", {
        backend: "codex",
        role: "executor",
        tools: ["app_builder"],
        outputSchema: "builder_result",
      }),
      agent("Build function B from the requested app capabilities.", {
        backend: "claude",
        role: "executor",
        tools: ["app_builder"],
        outputSchema: "builder_result",
      }),
    ])

    const review = await agent("Verify these generated functions.", {
      backend: "codex",
      role: "adversarial_reviewer",
      tools: ["read_only"],
      input: buildResults,
      outputSchema: {
        ok: "boolean",
        findings: "array",
        blocking: "array",
      },
    })

    if (!review.ok) {
      return {
        status: "failed",
        reason: "Generated functions did not pass verification.",
        review,
      }
    }

    const uiEntry = await agent("Update the app entry UI for these capabilities.", {
      backend: "claude",
      role: "executor",
      tools: ["ui_entry_agent"],
      input: buildResults,
      outputSchema: "ui_entry_update_result",
    })

    return await agent("Synthesize a user-facing summary.", {
      backend: "claude",
      role: "synthesizer",
      input: { buildResults, review, uiEntry },
    })
  }

  return agent("Handle this request with the normal single-agent path.", {
    input: ctx.userRequest,
  })
}
