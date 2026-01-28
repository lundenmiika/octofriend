import { Agent } from "./agents.ts";
import { Config } from "../config.ts";
import { Transport } from "../transports/transport-common.ts";
import { trajectoryArc } from "../agent/trajectory-arc.ts";
import { toLlmIR, outputToHistory } from "../ir/convert-history-ir.ts";
import { LlmIR } from "../ir/llm-ir.ts";
import { getModelFromConfig, assertKeyForModel, ModelConfig } from "../config.ts";
import { LoadedTools, loadTools } from "../tools/index.ts";
import { t, toTypescript } from "structural";

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

  try {
    // Get model - use agent's model preference or fall back to config
    const effectiveModelOverride = resolveModel(agent, modelOverride);
    const model = getModelFromConfig(config, effectiveModelOverride);
    const apiKey = await assertKeyForModel(model, config);

    // Load tools and filter based on agent's allowed tools
    const allTools = await loadTools(transport, signal, config);
    const filteredTools = filterToolsForAgent(allTools, agent);

    // Create isolated history with just the task
    const history: LlmIR[] = [{ role: "user", content: task }];

    // Collect response
    let responseContent = "";
    let reasoningContent = "";

    const finish = await trajectoryArc({
      apiKey,
      model,
      messages: history,
      config,
      transport,
      abortSignal: signal,
      handler: {
        startResponse: () => {},
        responseProgress: event => {
          if (event.buffer.content) responseContent = event.buffer.content;
          if (event.buffer.reasoning) reasoningContent = event.buffer.reasoning;
        },
        startCompaction: () => {},
        compactionProgress: () => {},
        compactionParsed: () => {},
        autofixingJson: () => {},
        autofixingDiff: () => {},
        retryTool: () => {},
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

# Current working directory
${pwd}
`.trim();
}

// Type for tools that includes the task tool
type LoadedToolsWithTask = LoadedTools & {
  task?: any;
};
