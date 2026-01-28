import { Agent } from "./agents.ts";
import { Config } from "../config.ts";
import { Transport } from "../transports/transport-common.ts";
import { trajectoryArc } from "../agent/trajectory-arc.ts";
import { toLlmIR, outputToHistory } from "../ir/convert-history-ir.ts";
import { LlmIR } from "../ir/llm-ir.ts";
import { getModelFromConfig, assertKeyForModel, ModelConfig } from "../config.ts";
import { LoadedTools, loadTools } from "../tools/index.ts";
import { ToolDef } from "../tools/common.ts";
import { t, toTypescript } from "structural";
import { useBackgroundAgentsStore, AgentQuestion } from "./background-store.ts";
import { recordAgentProgress } from "./watchdog.ts";
import { randomUUID } from "crypto";

// Global flag to track if we're inside a subagent context
let subagentDepth = 0;
const MAX_SUBAGENT_DEPTH = 1;

export function isInSubagentContext(): boolean {
  return subagentDepth > 0;
}

export function canSpawnSubagent(): boolean {
  return subagentDepth < MAX_SUBAGENT_DEPTH;
}

export type SubagentResult = {
  success: boolean;
  summary: string;
  error?: string;
};

type RunSubagentParams = {
  agent: Agent;
  task: string;
  signal: AbortSignal;
  transport: Transport;
  config: Config;
  modelOverride: string | null;
  /** Optional: ID for background agent to receive streaming updates */
  backgroundAgentId?: string;
};

/**
 * Runs a subagent with an isolated conversation context.
 *
 * The subagent:
 * - Uses its own system prompt (from the agent definition)
 * - Has an isolated conversation history (just the task)
 * - Can use only the tools specified in the agent definition
 * - Cannot spawn other subagents (depth limit = 1)
 */
export async function runSubagent({
  agent,
  task,
  signal,
  transport,
  config,
  modelOverride,
  backgroundAgentId,
}: RunSubagentParams): Promise<SubagentResult> {
  if (!canSpawnSubagent()) {
    return {
      success: false,
      summary: "",
      error: "Subagents cannot spawn other subagents (max depth reached)",
    };
  }

  // Increment depth to prevent nested subagent spawning
  subagentDepth++;

  // Get store for streaming updates (if background agent)
  const store = backgroundAgentId ? useBackgroundAgentsStore.getState() : null;

  try {
    // Get model - use agent's model preference or fall back to config
    const effectiveModelOverride = resolveModel(agent, modelOverride);
    const model = getModelFromConfig(config, effectiveModelOverride);
    const apiKey = await assertKeyForModel(model, config);

    // Load tools and filter based on agent's allowed tools
    const allTools = await loadTools(transport, signal, config);
    const filteredTools = filterToolsForAgent(allTools, agent);

    // Inject ask-user tool for background agents to enable mid-flight queries
    if (backgroundAgentId) {
      (filteredTools as any)["ask_user"] = createAskUserTool(backgroundAgentId);
    }

    // Create isolated history with just the task
    const history: LlmIR[] = [{ role: "user", content: task }];

    // Collect response
    let responseContent = "";
    let reasoningContent = "";
    let lastStreamUpdate = 0;
    const STREAM_THROTTLE_MS = 100; // Throttle UI updates

    const finish = await trajectoryArc({
      apiKey,
      model,
      messages: history,
      config,
      transport,
      abortSignal: signal,
      handler: {
        startResponse: () => {
          if (store && backgroundAgentId) {
            store.updateAgent(backgroundAgentId, { streamingContent: "" });
          }
        },
        responseProgress: event => {
          if (event.buffer.content) responseContent = event.buffer.content;
          if (event.buffer.reasoning) reasoningContent = event.buffer.reasoning;

          // Send streaming updates to UI (throttled)
          if (store && backgroundAgentId) {
            const now = Date.now();
            if (now - lastStreamUpdate > STREAM_THROTTLE_MS) {
              store.updateAgent(backgroundAgentId, {
                streamingContent: event.buffer.content || event.buffer.reasoning || "",
              });
              lastStreamUpdate = now;

              // Record progress for watchdog health monitoring
              recordAgentProgress(backgroundAgentId);
            }
          }
        },
        startCompaction: () => {},
        compactionProgress: () => {},
        compactionParsed: () => {},
        autofixingJson: () => {},
        autofixingDiff: () => {},
        retryTool: event => {
          // Track tool execution
          if (store && backgroundAgentId && event.irs.length > 0) {
            const lastIr = event.irs[event.irs.length - 1];
            if ("toolName" in lastIr && lastIr.toolName) {
              store.setToolCall(backgroundAgentId, {
                name: lastIr.toolName,
                status: "running",
                startTime: Date.now(),
              });
            }
          }
        },
      },
      // Custom system prompt and tools for the subagent
      customSystemPrompt: async () => {
        return generateSubagentSystemPrompt({
          agent,
          config,
          transport,
          tools: filteredTools,
          signal,
        });
      },
      customTools: filteredTools,
    });

    // Clear current tool call when done
    if (store && backgroundAgentId) {
      store.setToolCall(backgroundAgentId, undefined);
    }

    // Process result
    const historyItems = outputToHistory(finish.irs);
    const assistantMessages = historyItems.filter(h => h.type === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1];

    let summary = responseContent;
    if (lastAssistant && "content" in lastAssistant) {
      summary = lastAssistant.content;
    }

    if (finish.reason.type === "request-error") {
      return {
        success: false,
        summary: "",
        error: finish.reason.requestError,
      };
    }

    return {
      success: true,
      summary: summary || "(No response from subagent)",
    };
  } catch (e) {
    return {
      success: false,
      summary: "",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // Always decrement depth when done
    subagentDepth--;
  }
}

function resolveModel(agent: Agent, parentModelOverride: string | null): string | null {
  if (!agent.model || agent.model === "inherit") {
    return parentModelOverride;
  }
  // Map agent model names to actual model identifiers
  // This may need adjustment based on your config structure
  return agent.model;
}

function filterToolsForAgent(allTools: Partial<LoadedTools>, agent: Agent): Partial<LoadedTools> {
  // If no tools restriction, return all tools (except 'task' to prevent recursion)
  if (!agent.tools && !agent.disallowedTools) {
    const { task, ...rest } = allTools as any;
    return rest;
  }

  const filtered: Partial<LoadedTools> = {};

  // Normalize tool names to lowercase for comparison
  const allowedSet = agent.tools ? new Set(agent.tools.map(t => t.toLowerCase())) : null;
  const disallowedSet = agent.disallowedTools
    ? new Set(agent.disallowedTools.map(t => t.toLowerCase()))
    : new Set<string>();

  // Always disallow 'task' tool to prevent recursive subagent spawning
  disallowedSet.add("task");

  for (const [name, tool] of Object.entries(allTools)) {
    const nameLower = name.toLowerCase();

    // Skip if disallowed
    if (disallowedSet.has(nameLower)) continue;

    // If allowlist exists, only include allowed tools
    if (allowedSet && !allowedSet.has(nameLower)) continue;

    (filtered as any)[name] = tool;
  }

  return filtered;
}

async function generateSubagentSystemPrompt({
  agent,
  config,
  transport,
  tools,
  signal,
}: {
  agent: Agent;
  config: Config;
  transport: Transport;
  tools: Partial<LoadedTools>;
  signal: AbortSignal;
}): Promise<string> {
  const pwd = await transport.shell(signal, "pwd", 5000);

  const toolDocs = Object.entries(tools)
    .map(([_, tool]) => toTypescript(tool.Schema))
    .join("\n\n");

  return `
You are a subagent named "${agent.name}".

${agent.prompt}

# Context

You are running as a subagent, delegated a specific task by the main agent.
Your job is to complete this task and return a useful summary.

# Tools

You have access to the following tools:

${toolDocs}

# Guidelines

- Focus on completing the delegated task
- Be thorough but efficient
- Return a clear, actionable summary of your findings or actions
- You cannot spawn other subagents
- If you are truly blocked and need user input, use the ask_user tool (if available)
- Prefer making reasonable assumptions over asking questions - only ask when truly necessary

# Current working directory
${pwd}
`.trim();
}

// Type for tools that includes the task tool
type LoadedToolsWithTask = LoadedTools & {
  task?: any;
};

/**
 * Creates an ask-user tool for background agents to request user input.
 * This allows subagents to pause and ask clarifying questions when stuck.
 *
 * The tool:
 * - Sets agent status to "waiting_for_user"
 * - Stores the question in pendingQuestion
 * - Returns a promise that resolves when user answers
 */
function createAskUserTool(backgroundAgentId: string): ToolDef<any> {
  const ArgumentsSchema = t.subtype({
    question: t.str.comment("The question to ask the user"),
    context: t.optional(t.str.comment("Additional context about why you need this information")),
  });

  const Schema = t
    .subtype({
      name: t.value("ask_user"),
      arguments: ArgumentsSchema,
    })
    .comment(
      `Ask the user a question and wait for their response.

Use this tool when you are blocked and need clarification from the user.
The agent will pause until the user provides an answer.

Examples of when to use:
- Ambiguous requirements that could be interpreted multiple ways
- Need to choose between multiple valid approaches
- Missing information that cannot be inferred
- Confirmation before making significant changes

Do NOT use this for:
- Information you can find by reading files or searching
- Questions that have obvious answers
- Progress updates (the user can see your progress)`,
    );

  return {
    Schema,
    ArgumentsSchema,
    async validate() {
      return null;
    },
    async run(_signal, _transport, call) {
      const { question, context } = call.arguments;
      const store = useBackgroundAgentsStore.getState();

      // Create a promise that will be resolved when user answers
      return new Promise<{ content: string }>(resolve => {
        const questionId = randomUUID();

        const pendingQuestion: AgentQuestion = {
          id: questionId,
          question: context ? `${question}\n\nContext: ${context}` : question,
          resolve: (answer: string) => {
            resolve({
              content: `User answered: ${answer}`,
            });
          },
        };

        // Update agent state to waiting and store the question
        store.updateAgent(backgroundAgentId, {
          status: "waiting_for_user",
          pendingQuestion,
        });
      });
    },
  };
}
