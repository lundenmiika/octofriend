import { t } from "structural";
import { unionAll } from "../../types.ts";
import { defineTool, ToolDef } from "../common.ts";
import { discoverAgents, Agent } from "../../agents/agents.ts";
import { runSubagent, canSpawnSubagent } from "../../agents/runner.ts";

/**
 * Task tool - Compatible with Claude Code's Task tool interface.
 *
 * Spawns a subagent to handle complex, multi-step tasks autonomously.
 * The subagent runs with an isolated conversation context and returns
 * a summary of its work.
 *
 * Built-in subagent types:
 * - Explore: Fast codebase exploration (uses haiku model)
 * - Plan: Implementation planning and architecture
 * - general-purpose: Complex multi-step tasks with all tools
 * - Bash: Command execution specialist
 *
 * Custom agents can be defined in:
 * - .claude/agents/*.md (project-level)
 * - ~/.claude/agents/*.md (user-level)
 */
export default defineTool(async function (signal, transport, config) {
  // Don't expose task tool if we're already in a subagent context
  if (!canSpawnSubagent()) {
    return null;
  }

  const agents = await discoverAgents(transport, signal, config);
  if (agents.length === 0) return null;

  const agentDescriptions = JSON.stringify(
    agents.map(a => ({
      name: a.name,
      description: a.description,
      model: a.model,
      tools: a.tools,
    })),
    null,
    2,
  );

  const agentNameSchemas = agents.map(a => t.value(a.name));
  const ArgumentsSchema = t.subtype({
    subagent_type: unionAll(agentNameSchemas),
    description: t.str.comment("Short 3-5 word description of the task"),
    prompt: t.str.comment("Detailed task instructions for the subagent"),
    model: t.optional(t.value("sonnet").or(t.value("opus")).or(t.value("haiku"))),
  });

  const Schema = t
    .subtype({
      name: t.value("task"),
      arguments: ArgumentsSchema,
    })
    .comment(
      `Spawns a subagent to handle a task autonomously. The subagent runs with isolated context and returns a summary.

Available subagent types:
${agentDescriptions}

Parameters:
- subagent_type: The type of agent to spawn (required)
- description: Short 3-5 word description of the task (required)
- prompt: Detailed task instructions for the subagent (required)
- model: Optional model override (sonnet, opus, haiku)

Use this tool when:
- The task requires multiple steps or exploration
- You need specialized analysis (code review, testing, etc.)
- You want to delegate work to a focused agent

The subagent cannot spawn other subagents (max depth = 1).`,
    );

  return {
    Schema,
    ArgumentsSchema,
    async validate() {
      return null;
    },
    async run(signal, transport, call, config, modelOverride) {
      const { subagent_type, description, prompt, model } = call.arguments;

      const agent = agents.find(a => a.name.toLowerCase() === subagent_type.toLowerCase());

      if (!agent) {
        return {
          content: `Error: Unknown subagent type "${subagent_type}". Available types: ${agents.map(a => a.name).join(", ")}`,
        };
      }

      // Use model from arguments if provided, otherwise use agent's preference
      const effectiveModelOverride =
        model || (agent.model !== "inherit" ? agent.model : null) || modelOverride;

      const result = await runSubagent({
        agent,
        task: prompt,
        signal,
        transport,
        config,
        modelOverride: effectiveModelOverride,
      });

      if (!result.success) {
        return {
          content: `Subagent "${agent.name}" failed: ${result.error || "Unknown error"}`,
        };
      }

      return {
        content: `[Subagent: ${agent.name}] Task: ${description}

${result.summary}`,
      };
    },
  } satisfies ToolDef<t.GetType<typeof Schema>>;
});
