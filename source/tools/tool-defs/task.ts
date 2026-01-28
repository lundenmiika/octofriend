import { t } from "structural";
import { unionAll } from "../../types.ts";
import { defineTool, ToolDef } from "../common.ts";
import { discoverAgents, Agent } from "../../agents/agents.ts";
import { runSubagent, canSpawnSubagent } from "../../agents/runner.ts";
import { useBackgroundAgentsStore, BackgroundAgent } from "../../agents/background-store.ts";
import { startWatchdog, isWatchdogRunning } from "../../agents/watchdog.ts";
import {
  useCoordinationStore,
  TaskContract,
  generateCoordinationInstructions,
} from "../../agents/coordination.ts";
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
    // Coordination parameters - CRITICAL for parallel agents
    allowed_write_paths: t.optional(
      t
        .array(t.str)
        .comment(
          "File paths/globs this agent MAY write to. Other paths are forbidden. Use for parallel safety.",
        ),
    ),
    forbidden_paths: t.optional(
      t.array(t.str).comment("File paths/globs this agent must NOT touch (read or write)."),
    ),
    read_only: t.optional(
      t.bool.comment("If true, agent cannot modify any files. Use for exploration tasks."),
    ),
    restrictions: t.optional(
      t.array(t.str).comment("Additional restrictions/boundaries for this task."),
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

Coordination parameters (IMPORTANT for parallel agents):
- allowed_write_paths: Array of file paths/globs the agent MAY write to. CRITICAL for parallel safety!
- forbidden_paths: Array of paths the agent must not touch
- read_only: If true, agent cannot modify any files (use for exploration)
- restrictions: Additional boundaries/rules for the agent

PARALLEL AGENT SAFETY:
When running multiple agents in parallel, you MUST:
1. Assign non-overlapping allowed_write_paths to each agent
2. Use read_only=true for exploration agents
3. List paths being modified by siblings in forbidden_paths
4. Keep tasks focused and scoped

Example for safe parallelization:
- Agent A: allowed_write_paths=["src/components/**"], forbidden_paths=["src/utils/**"]
- Agent B: allowed_write_paths=["src/utils/**"], forbidden_paths=["src/components/**"]

The subagent cannot spawn other subagents (max depth = 1).`,
    );

  return {
    Schema,
    ArgumentsSchema,
    async validate() {
      return null;
    },
    async run(signal, transport, call, config, modelOverride) {
      const {
        subagent_type,
        description,
        prompt,
        model,
        run_in_background,
        allowed_write_paths,
        forbidden_paths,
        read_only,
        restrictions,
      } = call.arguments;

      const agent = agents.find(a => a.name.toLowerCase() === subagent_type.toLowerCase());

      if (!agent) {
        return {
          content: `Error: Unknown subagent type "${subagent_type}". Available types: ${agents.map(a => a.name).join(", ")}`,
        };
      }

      // Use model from arguments if provided, otherwise use agent's preference
      const effectiveModelOverride =
        model || (agent.model !== "inherit" ? agent.model : null) || modelOverride;

      // Create task contract for coordination
      const agentId = generateAgentId();
      const coordinationStore = useCoordinationStore.getState();

      // Get sibling context (other active agents)
      const siblingContext = coordinationStore.getSiblingContext(agentId);

      const contract: TaskContract = {
        taskId: `${agent.name}-${agentId}`,
        objective: description,
        allowedWritePaths: allowed_write_paths,
        forbiddenPaths: forbidden_paths,
        readOnly: read_only ?? false,
        restrictions: restrictions,
        siblingContext: siblingContext.length > 0 ? siblingContext : undefined,
      };

      // Register contract
      coordinationStore.registerContract(agentId, contract);

      // Try to acquire file ownership if write paths specified
      if (allowed_write_paths && allowed_write_paths.length > 0) {
        const acquired = coordinationStore.acquireFiles(agentId, agent.name, allowed_write_paths);
        if (!acquired) {
          coordinationStore.removeContract(agentId);
          return {
            content: `Error: Could not acquire file ownership for paths: ${allowed_write_paths.join(", ")}. Another agent may be working on these files.`,
          };
        }
      }

      // Generate coordination instructions to inject into the prompt
      const coordinationInstructions = generateCoordinationInstructions(contract);

      // Combine prompt with coordination instructions
      const enhancedPrompt = coordinationInstructions
        ? `${prompt}\n\n---\n\n${coordinationInstructions}`
        : prompt;

      // Background execution mode
      if (run_in_background) {
        const outputDir = await getOutputDir();
        const outputFile = path.join(outputDir, `${agentId}.txt`);

        // Create abort controller for this agent (allows early termination)
        const agentAbortController = new AbortController();

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
        store.addAgent(bgAgent, agentAbortController);

        // Start watchdog if not already running (monitors agent health)
        if (!isWatchdogRunning()) {
          startWatchdog({
            checkIntervalMs: 30_000, // Check every 30 seconds
            parentCheckInIntervalMs: 300_000, // Parent wake window every 5 minutes
            noProgressThresholdMs: 60_000, // 1 minute no progress = warning
            sameToolCallThreshold: 3, // Same tool+params 3 times = stuck loop
            stallAction: "escalate", // Show panel and alert user
            maxConsecutiveStalls: 3, // Auto-terminate after 3 stalls
          });
        }

        // Start the agent in background (don't await)
        (async () => {
          try {
            const result = await runSubagent({
              agent,
              task: enhancedPrompt, // Use prompt with coordination instructions
              signal: agentAbortController.signal, // Use agent-specific abort signal
              transport,
              config,
              modelOverride: effectiveModelOverride,
              backgroundAgentId: agentId, // Enable streaming updates
            });

            // Check if we were terminated (store already updated status)
            const currentAgent = useBackgroundAgentsStore.getState().agents.get(agentId);
            if (currentAgent?.status === "failed" && currentAgent?.error === "Terminated by user") {
              // Already handled by terminateAgent
              await fs.appendFile(
                outputFile,
                `\n--- Result ---\nStatus: terminated\nTerminated: ${new Date().toISOString()}\n\n${currentAgent.output || "No partial output"}`,
              );
              return;
            }

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
            // Check if aborted by user
            if (agentAbortController.signal.aborted) {
              // Termination handled by terminateAgent action
              return;
            }

            const errorMsg = e instanceof Error ? e.message : String(e);

            // Update store
            store.updateAgent(agentId, {
              status: "failed",
              endTime: Date.now(),
              error: errorMsg,
            });

            // Update output file
            await fs.appendFile(outputFile, `\n--- Result ---\nStatus: failed\nError: ${errorMsg}`);
          } finally {
            // Clean up coordination contract
            coordinationStore.removeContract(agentId);
          }
        })();

        return {
          content: `Background agent started.
Agent ID: ${agentId}
Output file: ${outputFile}

The agent is now running in the background. Check the status bar below for progress.
Press Ctrl+B to focus on agents panel, then 't' to terminate if needed.`,
        };
      }

      // Synchronous execution (default)
      try {
        const result = await runSubagent({
          agent,
          task: enhancedPrompt, // Use prompt with coordination instructions
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
      } finally {
        // Clean up coordination contract
        coordinationStore.removeContract(agentId);
      }
    },
  } satisfies ToolDef<t.GetType<typeof Schema>>;
});
