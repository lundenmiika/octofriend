import { t } from "structural";
import { unionAll } from "../../types.ts";
import { defineTool, ToolDef } from "../common.ts";
import { discoverAgents, Agent } from "../../agents/agents.ts";
import { runSubagent, canSpawnSubagent } from "../../agents/runner.ts";
import { useBackgroundAgentsStore, BackgroundAgent } from "../../agents/background-store.ts";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

let agentIdCounter = 0;

function generateAgentId(): string {
  return `agent_${Date.now()}_${++agentIdCounter}`;
}

async function getOutputDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "octofriend-agents");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Task tool - Compatible with Claude Code's Task tool interface.
 *
 * Spawns a subagent to handle complex, multi-step tasks autonomously.
 * The subagent runs with an isolated conversation context and returns
 * a summary of its work.
 *
 * Built-in subagent types:
 * - Explore: Fast codebase exploration (uses haiku model). Use proactively for file discovery.
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

  const agentDescriptions = agents
    .map(a => `- ${a.name}: ${a.description}${a.model ? ` (model: ${a.model})` : ""}`)
    .join("\n");

  const agentNameSchemas = agents.map(a => t.value(a.name));
  const ArgumentsSchema = t.subtype({
    subagent_type: unionAll(agentNameSchemas),
    description: t.str.comment("Short 3-5 word description of the task"),
    prompt: t.str.comment("Detailed task instructions for the subagent"),
    model: t.optional(t.value("sonnet").or(t.value("opus")).or(t.value("haiku"))),
    run_in_background: t.optional(
      t.bool.comment("Run agent in background. Returns immediately with agent ID."),
    ),
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
- run_in_background: If true, runs async and returns agent ID immediately

Use this tool when:
- The task requires multiple steps or exploration
- You need specialized analysis (code review, testing, etc.)
- You want to delegate work to a focused agent

Use run_in_background=true when:
- You want to run multiple agents in parallel
- The task doesn't block your current work

The subagent cannot spawn other subagents (max depth = 1).`,
    );

  return {
    Schema,
    ArgumentsSchema,
    async validate() {
      return null;
    },
    async run(signal, transport, call, config, modelOverride) {
      const { subagent_type, description, prompt, model, run_in_background } = call.arguments;

      const agent = agents.find(a => a.name.toLowerCase() === subagent_type.toLowerCase());

      if (!agent) {
        return {
          content: `Error: Unknown subagent type "${subagent_type}". Available types: ${agents.map(a => a.name).join(", ")}`,
        };
      }

      // Use model from arguments if provided, otherwise use agent's preference
      const effectiveModelOverride =
        model || (agent.model !== "inherit" ? agent.model : null) || modelOverride;

      // Background execution mode
      if (run_in_background) {
        const agentId = generateAgentId();
        const outputDir = await getOutputDir();
        const outputFile = path.join(outputDir, `${agentId}.txt`);

        // Initialize output file
        await fs.writeFile(
          outputFile,
          `Agent: ${agent.name}\nTask: ${description}\nStatus: running\nStarted: ${new Date().toISOString()}\n\n--- Output ---\n`,
        );

        // Add to the shared store for UI visibility
        const bgAgent: BackgroundAgent = {
          id: agentId,
          agentName: agent.name,
          description,
          task: prompt,
          status: "running",
          outputFile,
          startTime: Date.now(),
        };

        const store = useBackgroundAgentsStore.getState();
        store.addAgent(bgAgent);

        // Start the agent in background (don't await)
        (async () => {
          try {
            const result = await runSubagent({
              agent,
              task: prompt,
              signal,
              transport,
              config,
              modelOverride: effectiveModelOverride,
              backgroundAgentId: agentId, // Enable streaming updates
            });

            const endTime = Date.now();
            const status = result.success ? "completed" : "failed";

            // Update store
            store.updateAgent(agentId, {
              status,
              endTime,
              output: result.success ? result.summary : undefined,
              error: result.success ? undefined : result.error,
            });

            // Update output file
            await fs.appendFile(
              outputFile,
              `\n--- Result ---\nStatus: ${status}\nCompleted: ${new Date().toISOString()}\n\n${result.success ? result.summary : `Error: ${result.error}`}`,
            );
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);

            // Update store
            store.updateAgent(agentId, {
              status: "failed",
              endTime: Date.now(),
              error: errorMsg,
            });

            // Update output file
            await fs.appendFile(outputFile, `\n--- Result ---\nStatus: failed\nError: ${errorMsg}`);
          }
        })();

        return {
          content: `Background agent started.
Agent ID: ${agentId}
Output file: ${outputFile}

The agent is now running in the background. Check the status bar below for progress.`,
        };
      }

      // Synchronous execution (default)
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
