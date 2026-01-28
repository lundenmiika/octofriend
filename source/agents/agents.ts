import path from "path";
import { parse as parseYaml } from "yaml";
import { Transport, getEnvVar } from "../transports/transport-common.ts";
import * as logger from "../logger.ts";
import { Config } from "../config.ts";

const AGENT_FILE_EXTENSION = ".md";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

const NAME_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;

/**
 * Agent definition compatible with Claude Code's .claude/agents/ format.
 *
 * Agents are defined as Markdown files with YAML frontmatter:
 * ```markdown
 * ---
 * name: code-reviewer
 * description: Reviews code for quality and best practices
 * tools: Read, Glob, Grep
 * model: sonnet
 * ---
 *
 * You are a code reviewer...
 * ```
 */
export type Agent = {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  permissionMode?: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan";
  skills?: string[];
  prompt: string;
  filePath: string;
};

type AgentFrontmatter = {
  name?: string;
  description?: string;
  tools?: string | string[];
  disallowedTools?: string | string[];
  model?: string;
  permissionMode?: string;
  skills?: string | string[];
};

// Built-in agent types that match Claude Code's Task tool
export const BUILTIN_AGENTS: Agent[] = [
  {
    name: "Explore",
    description:
      "Fast agent for exploring codebases. Use PROACTIVELY when searching for files, understanding code structure, or finding relevant code. Ideal for quick lookups.",
    tools: ["read", "list", "skill"],
    model: "haiku",
    prompt: `You are a fast codebase exploration agent. Your job is to quickly find files, search code, and answer questions about codebase structure.

Focus on:
- Finding files by patterns
- Searching code for keywords or patterns
- Understanding codebase organization
- Providing concise answers about code structure

Be thorough but efficient. Return focused, actionable results.`,
    filePath: "<builtin>",
  },
  {
    name: "Plan",
    description:
      "Software architect agent for designing implementation plans. Use when asked to plan, design, or architect a feature before implementing.",
    tools: ["read", "list", "skill"],
    model: "inherit",
    prompt: `You are a software architect agent. Your job is to design implementation plans for tasks.

When given a task:
1. Research the relevant codebase areas
2. Identify key files and dependencies
3. Consider architectural trade-offs
4. Create a step-by-step implementation plan

Return structured plans with:
- Overview of the approach
- Files to create/modify
- Key considerations
- Potential risks`,
    filePath: "<builtin>",
  },
  {
    name: "general-purpose",
    description:
      "General-purpose agent for complex, multi-step tasks. Has access to all tools. Use for tasks that require multiple operations or extended work.",
    model: "inherit",
    prompt: `You are a general-purpose coding agent. You can handle complex, multi-step tasks autonomously.

Work through tasks systematically:
1. Understand the requirements
2. Research the codebase as needed
3. Implement changes carefully
4. Verify your work

Return a summary of what you accomplished.`,
    filePath: "<builtin>",
  },
  {
    name: "Bash",
    description:
      "Command execution specialist for running bash commands, git operations, and terminal tasks. Use for build commands, tests, or shell operations.",
    tools: ["shell"],
    model: "inherit",
    prompt: `You are a command execution specialist. Your job is to run bash commands to accomplish tasks.

Focus on:
- Git operations
- Build commands
- File system operations
- Development tooling

Be careful with destructive operations. Return command outputs and summaries.`,
    filePath: "<builtin>",
  },
];

export function validateAgent(agent: Agent): string[] {
  const errors: string[] = [];

  if (!agent.name) {
    errors.push("name is required");
  } else {
    if (agent.name.length > MAX_NAME_LENGTH) {
      errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
    }
    if (!NAME_PATTERN.test(agent.name)) {
      errors.push(
        "name must be alphanumeric with hyphens, no leading/trailing/consecutive hyphens",
      );
    }
  }

  if (!agent.description) {
    errors.push("description is required");
  } else if (agent.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (agent.model && !["sonnet", "opus", "haiku", "inherit"].includes(agent.model)) {
    errors.push(`invalid model: ${agent.model}`);
  }

  return errors;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return null;
  }

  const rest = normalized.slice(4);
  const endIndex = rest.indexOf("\n---");

  if (endIndex === -1) {
    return null;
  }

  return {
    frontmatter: rest.slice(0, endIndex),
    body: rest.slice(endIndex + 4).trim(),
  };
}

function parseToolsList(tools: string | string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  if (Array.isArray(tools)) return tools;
  // Support comma-separated string format: "Read, Glob, Grep"
  return tools
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
}

export function parseAgentContent(content: string, filePath: string): Agent | null {
  const split = splitFrontmatter(content);
  if (!split) return null;

  let frontmatter: AgentFrontmatter;
  try {
    frontmatter = parseYaml(split.frontmatter) as AgentFrontmatter;
  } catch {
    return null;
  }

  if (!frontmatter || typeof frontmatter !== "object") return null;
  if (!frontmatter.name || !frontmatter.description) return null;

  const model = frontmatter.model as Agent["model"];
  const permissionMode = frontmatter.permissionMode as Agent["permissionMode"];

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseToolsList(frontmatter.tools),
    disallowedTools: parseToolsList(frontmatter.disallowedTools),
    model: model && ["sonnet", "opus", "haiku", "inherit"].includes(model) ? model : undefined,
    permissionMode,
    skills: parseToolsList(frontmatter.skills),
    prompt: split.body,
    filePath,
  };
}

async function* walkAgentsDirectory(
  transport: Transport,
  signal: AbortSignal,
  dirPath: string,
): AsyncGenerator<string> {
  let entries: Array<{ entry: string; isDirectory: boolean }>;
  try {
    entries = await transport.readdir(signal, dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (signal.aborted) return;

    const fullPath = path.join(dirPath, entry.entry);

    if (!entry.isDirectory && entry.entry.endsWith(AGENT_FILE_EXTENSION)) {
      yield fullPath;
    }
  }
}

/**
 * Discovers agents from Claude Code-compatible locations:
 * 1. .claude/agents/ in the current project
 * 2. ~/.claude/agents/ for user-level agents
 *
 * Also includes built-in agents (Explore, Plan, general-purpose, Bash).
 */
export async function discoverAgents(
  transport: Transport,
  signal: AbortSignal,
  _config: Config,
): Promise<Agent[]> {
  const agentsPaths = await getAgentsPaths(transport, signal);

  const agents: Agent[] = [...BUILTIN_AGENTS];
  const seen = new Set<string>();
  const seenNames = new Set<string>(BUILTIN_AGENTS.map(a => a.name.toLowerCase()));

  for (const basePath of agentsPaths) {
    if (signal.aborted) break;

    const exists = await transport.pathExists(signal, basePath);
    if (!exists) continue;

    for await (const filePath of walkAgentsDirectory(transport, signal, basePath)) {
      if (signal.aborted) break;
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      try {
        const content = await transport.readFile(signal, filePath);
        const agent = parseAgentContent(content, filePath);

        if (!agent) {
          logger.error("info", `Failed to parse agent file: ${filePath}`);
          continue;
        }

        const errors = validateAgent(agent);
        if (errors.length > 0) {
          logger.error("info", `Agent validation failed for ${filePath}: ${errors.join(", ")}`);
          continue;
        }

        const nameLower = agent.name.toLowerCase();
        if (seenNames.has(nameLower)) {
          logger.error("info", `Duplicate agent name "${agent.name}" at ${filePath}, skipping`);
          continue;
        }
        seenNames.add(nameLower);

        agents.push(agent);
      } catch (e) {
        logger.error("info", `Error reading agent file ${filePath}: ${e}`);
      }
    }
  }

  return agents;
}

async function getAgentsPaths(transport: Transport, signal: AbortSignal): Promise<string[]> {
  const paths: string[] = [];

  // Project-level: .claude/agents/
  const pwd = await transport.cwd(signal);
  paths.push(path.join(pwd, ".claude", "agents"));

  // User-level: ~/.claude/agents/
  const home = await getEnvVar(signal, transport, "HOME", 5000);
  paths.push(path.join(home, ".claude", "agents"));

  return paths;
}

export function toPromptXML(agents: Agent[]): string {
  if (agents.length === 0) return "";

  const lines: string[] = ["<available_agents>"];

  for (const agent of agents) {
    lines.push("  <agent>");
    lines.push(`    <name>${escapeXml(agent.name)}</name>`);
    lines.push(`    <description>${escapeXml(agent.description)}</description>`);
    if (agent.tools) {
      lines.push(`    <tools>${escapeXml(agent.tools.join(", "))}</tools>`);
    }
    if (agent.model) {
      lines.push(`    <model>${escapeXml(agent.model)}</model>`);
    }
    lines.push("  </agent>");
  }

  lines.push("</available_agents>");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
