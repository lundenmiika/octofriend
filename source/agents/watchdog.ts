import { useBackgroundAgentsStore, BackgroundAgent } from "./background-store.ts";
import { createHash } from "crypto";

/**
 * Configuration for the agent watchdog
 */
export type WatchdogConfig = {
  /** How often to check individual agent health (ms) */
  checkIntervalMs: number;

  /** Parent wake/check-in interval - fires callback for parent to assess all agents (ms) */
  parentCheckInIntervalMs: number;

  /** No streaming updates for this long = potentially stuck (ms) */
  noProgressThresholdMs: number;

  /** Same tool+params called this many times = stuck in a loop */
  sameToolCallThreshold: number;

  /** Waiting for user this long = auto-escalate (ms) */
  waitingForUserThresholdMs: number;

  /** What action to take when agent is stuck */
  stallAction: "warn" | "terminate" | "nudge" | "escalate";

  /** Max consecutive stalls before forced termination */
  maxConsecutiveStalls: number;
};

const DEFAULT_CONFIG: WatchdogConfig = {
  checkIntervalMs: 30_000, // Check every 30 seconds
  parentCheckInIntervalMs: 300_000, // Parent wake window every 5 minutes
  noProgressThresholdMs: 60_000, // 1 minute no progress
  sameToolCallThreshold: 3, // Same tool+params 3 times = stuck
  waitingForUserThresholdMs: 300_000, // 5 minutes waiting for user
  stallAction: "warn",
  maxConsecutiveStalls: 3,
};

export type StallReason = "no_progress" | "tool_loop" | "waiting_too_long" | "unknown";

export type AgentHealthStatus = {
  agentId: string;
  isHealthy: boolean;
  stallReason?: StallReason;
  stallDurationMs?: number;
  consecutiveStalls: number;
  lastCheckTime: number;
  /** Info about detected loop if tool_loop */
  loopInfo?: {
    toolName: string;
    paramsHash: string;
    callCount: number;
  };
};

/**
 * Tracked tool call with parameter hash for loop detection
 */
type TrackedToolCall = {
  toolName: string;
  paramsHash: string;
  timestamp: number;
};

/**
 * Summary provided to parent during check-in
 */
export type ParentCheckInSummary = {
  timestamp: number;
  totalAgents: number;
  runningAgents: number;
  waitingAgents: number;
  completedAgents: number;
  failedAgents: number;
  healthStatuses: AgentHealthStatus[];
  /** Agents that appear to need attention */
  needsAttention: Array<{
    agentId: string;
    agentName: string;
    reason: string;
    suggestion: string;
  }>;
};

type WatchdogState = {
  isRunning: boolean;
  checkIntervalId: NodeJS.Timeout | null;
  parentCheckInIntervalId: NodeJS.Timeout | null;
  config: WatchdogConfig;
  healthStatus: Map<string, AgentHealthStatus>;
  stallCounts: Map<string, number>;
  lastProgressTime: Map<string, number>;
  /** Tool call history per agent for loop detection */
  toolCallHistory: Map<string, TrackedToolCall[]>;
  /** Callbacks */
  onStallDetected?: (agentId: string, status: AgentHealthStatus) => void;
  onAgentTerminated?: (agentId: string, reason: string) => void;
  onParentCheckIn?: (summary: ParentCheckInSummary) => void;
};

let watchdogState: WatchdogState = {
  isRunning: false,
  checkIntervalId: null,
  parentCheckInIntervalId: null,
  config: DEFAULT_CONFIG,
  healthStatus: new Map(),
  stallCounts: new Map(),
  lastProgressTime: new Map(),
  toolCallHistory: new Map(),
};

/**
 * Start the watchdog to monitor background agents
 */
export function startWatchdog(
  config?: Partial<WatchdogConfig>,
  callbacks?: {
    onStallDetected?: (agentId: string, status: AgentHealthStatus) => void;
    onAgentTerminated?: (agentId: string, reason: string) => void;
    /** Called on parent wake windows - parent can assess and take action */
    onParentCheckIn?: (summary: ParentCheckInSummary) => void;
  },
): void {
  if (watchdogState.isRunning) {
    return;
  }

  watchdogState.config = { ...DEFAULT_CONFIG, ...config };
  watchdogState.onStallDetected = callbacks?.onStallDetected;
  watchdogState.onAgentTerminated = callbacks?.onAgentTerminated;
  watchdogState.onParentCheckIn = callbacks?.onParentCheckIn;
  watchdogState.isRunning = true;

  // Run initial check
  checkAgents();

  // Schedule periodic health checks
  watchdogState.checkIntervalId = setInterval(checkAgents, watchdogState.config.checkIntervalMs);

  // Schedule parent check-in intervals
  if (watchdogState.config.parentCheckInIntervalMs > 0) {
    watchdogState.parentCheckInIntervalId = setInterval(
      triggerParentCheckIn,
      watchdogState.config.parentCheckInIntervalMs,
    );
  }
}

/**
 * Stop the watchdog
 */
export function stopWatchdog(): void {
  if (watchdogState.checkIntervalId) {
    clearInterval(watchdogState.checkIntervalId);
    watchdogState.checkIntervalId = null;
  }
  if (watchdogState.parentCheckInIntervalId) {
    clearInterval(watchdogState.parentCheckInIntervalId);
    watchdogState.parentCheckInIntervalId = null;
  }
  watchdogState.isRunning = false;
}

/**
 * Update watchdog config while running
 */
export function updateWatchdogConfig(config: Partial<WatchdogConfig>): void {
  const oldConfig = watchdogState.config;
  watchdogState.config = { ...watchdogState.config, ...config };

  // Restart intervals if they changed
  if (watchdogState.isRunning) {
    if (config.checkIntervalMs && config.checkIntervalMs !== oldConfig.checkIntervalMs) {
      if (watchdogState.checkIntervalId) {
        clearInterval(watchdogState.checkIntervalId);
      }
      watchdogState.checkIntervalId = setInterval(
        checkAgents,
        watchdogState.config.checkIntervalMs,
      );
    }

    if (
      config.parentCheckInIntervalMs !== undefined &&
      config.parentCheckInIntervalMs !== oldConfig.parentCheckInIntervalMs
    ) {
      if (watchdogState.parentCheckInIntervalId) {
        clearInterval(watchdogState.parentCheckInIntervalId);
        watchdogState.parentCheckInIntervalId = null;
      }
      if (config.parentCheckInIntervalMs > 0) {
        watchdogState.parentCheckInIntervalId = setInterval(
          triggerParentCheckIn,
          watchdogState.config.parentCheckInIntervalMs,
        );
      }
    }
  }
}

/**
 * Get current health status for all agents
 */
export function getAgentHealthStatuses(): Map<string, AgentHealthStatus> {
  return new Map(watchdogState.healthStatus);
}

/**
 * Record that an agent made progress (call this when streaming updates arrive)
 */
export function recordAgentProgress(agentId: string): void {
  watchdogState.lastProgressTime.set(agentId, Date.now());
  // Reset stall count on progress
  watchdogState.stallCounts.set(agentId, 0);
}

/**
 * Record a tool call with its parameters for loop detection.
 * Call this when a tool is invoked.
 */
export function recordToolCall(
  agentId: string,
  toolName: string,
  params: Record<string, unknown>,
): void {
  const paramsHash = hashParams(params);
  const history = watchdogState.toolCallHistory.get(agentId) ?? [];

  history.push({
    toolName,
    paramsHash,
    timestamp: Date.now(),
  });

  // Keep only last 20 tool calls for memory efficiency
  if (history.length > 20) {
    history.shift();
  }

  watchdogState.toolCallHistory.set(agentId, history);

  // Also record as progress
  recordAgentProgress(agentId);
}

/**
 * Hash parameters to create a fingerprint for loop detection
 */
function hashParams(params: Record<string, unknown>): string {
  const normalized = JSON.stringify(params, Object.keys(params).sort());
  return createHash("md5").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Check if agent is in a tool call loop (same tool + same params repeatedly)
 */
function detectToolLoop(agentId: string): {
  isLoop: boolean;
  toolName?: string;
  paramsHash?: string;
  count?: number;
} {
  const history = watchdogState.toolCallHistory.get(agentId);
  if (!history || history.length < watchdogState.config.sameToolCallThreshold) {
    return { isLoop: false };
  }

  // Look at recent calls
  const recentCalls = history.slice(-watchdogState.config.sameToolCallThreshold);

  // Check if all recent calls are the same tool+params
  const firstCall = recentCalls[0];
  const allSame = recentCalls.every(
    call => call.toolName === firstCall.toolName && call.paramsHash === firstCall.paramsHash,
  );

  if (allSame) {
    // Count total consecutive same calls
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (
        history[i].toolName === firstCall.toolName &&
        history[i].paramsHash === firstCall.paramsHash
      ) {
        count++;
      } else {
        break;
      }
    }

    return {
      isLoop: true,
      toolName: firstCall.toolName,
      paramsHash: firstCall.paramsHash,
      count,
    };
  }

  return { isLoop: false };
}

/**
 * Main health check function - runs periodically
 */
function checkAgents(): void {
  const store = useBackgroundAgentsStore.getState();
  const agents = Array.from(store.agents.values());
  const now = Date.now();

  for (const agent of agents) {
    // Only check running agents
    if (agent.status !== "running" && agent.status !== "waiting_for_user") {
      // Clean up tracking for completed/failed agents
      cleanupAgentTracking(agent.id);
      continue;
    }

    const status = assessAgentHealth(agent, now);
    watchdogState.healthStatus.set(agent.id, status);

    if (!status.isHealthy) {
      handleStall(agent, status);
    }
  }
}

/**
 * Clean up tracking data for an agent
 */
function cleanupAgentTracking(agentId: string): void {
  watchdogState.healthStatus.delete(agentId);
  watchdogState.stallCounts.delete(agentId);
  watchdogState.lastProgressTime.delete(agentId);
  watchdogState.toolCallHistory.delete(agentId);
}

/**
 * Assess the health of a single agent
 */
function assessAgentHealth(agent: BackgroundAgent, now: number): AgentHealthStatus {
  const config = watchdogState.config;
  const lastProgress = watchdogState.lastProgressTime.get(agent.id) ?? agent.startTime;
  const consecutiveStalls = watchdogState.stallCounts.get(agent.id) ?? 0;

  const baseStatus: AgentHealthStatus = {
    agentId: agent.id,
    isHealthy: true,
    consecutiveStalls,
    lastCheckTime: now,
  };

  // Check for waiting_for_user timeout
  if (agent.status === "waiting_for_user") {
    const waitingDuration = now - lastProgress;
    if (waitingDuration > config.waitingForUserThresholdMs) {
      return {
        ...baseStatus,
        isHealthy: false,
        stallReason: "waiting_too_long",
        stallDurationMs: waitingDuration,
      };
    }
    return baseStatus; // Waiting for user is okay within threshold
  }

  // Check for tool call loop (same tool + same params repeatedly)
  const loopCheck = detectToolLoop(agent.id);
  if (loopCheck.isLoop) {
    return {
      ...baseStatus,
      isHealthy: false,
      stallReason: "tool_loop",
      loopInfo: {
        toolName: loopCheck.toolName!,
        paramsHash: loopCheck.paramsHash!,
        callCount: loopCheck.count!,
      },
    };
  }

  // Check for no progress (no streaming, no tool calls)
  const timeSinceProgress = now - lastProgress;
  if (timeSinceProgress > config.noProgressThresholdMs) {
    return {
      ...baseStatus,
      isHealthy: false,
      stallReason: "no_progress",
      stallDurationMs: timeSinceProgress,
    };
  }

  return baseStatus;
}

/**
 * Handle a detected stall based on configuration
 */
function handleStall(agent: BackgroundAgent, status: AgentHealthStatus): void {
  const config = watchdogState.config;
  const stallCount = (watchdogState.stallCounts.get(agent.id) ?? 0) + 1;
  watchdogState.stallCounts.set(agent.id, stallCount);

  // Update status with new stall count
  status.consecutiveStalls = stallCount;

  // Notify callback
  if (watchdogState.onStallDetected) {
    watchdogState.onStallDetected(agent.id, status);
  }

  // Force terminate if max stalls exceeded
  if (stallCount >= config.maxConsecutiveStalls) {
    terminateStuckAgent(agent, status, "Max consecutive stalls exceeded");
    return;
  }

  // Take configured action
  switch (config.stallAction) {
    case "warn":
      logStallWarning(agent, status);
      break;

    case "terminate":
      terminateStuckAgent(agent, status, `Stalled: ${status.stallReason}`);
      break;

    case "nudge":
      nudgeAgent(agent, status);
      break;

    case "escalate":
      escalateToUser(agent, status);
      break;
  }
}

/**
 * Log a warning about a stalled agent
 */
function logStallWarning(agent: BackgroundAgent, status: AgentHealthStatus): void {
  let message = `[Watchdog] Agent "${agent.agentName}" (${agent.id}) appears stuck: ${status.stallReason}`;

  if (status.stallDurationMs) {
    message += ` for ${(status.stallDurationMs / 1000).toFixed(0)}s`;
  }

  if (status.loopInfo) {
    message += ` (${status.loopInfo.toolName} called ${status.loopInfo.callCount}x with same params)`;
  }

  message += ` (stall #${status.consecutiveStalls})`;

  console.warn(message);
}

/**
 * Terminate a stuck agent
 */
function terminateStuckAgent(
  agent: BackgroundAgent,
  status: AgentHealthStatus,
  reason: string,
): void {
  const store = useBackgroundAgentsStore.getState();

  let fullReason = `Auto-terminated by watchdog: ${reason} (${status.stallReason}`;

  if (status.stallDurationMs) {
    fullReason += `, ${(status.stallDurationMs / 1000).toFixed(0)}s`;
  }

  if (status.loopInfo) {
    fullReason += `, ${status.loopInfo.toolName} looped ${status.loopInfo.callCount}x`;
  }

  fullReason += ")";

  // Use the store's terminate function
  store.terminateAgent(agent.id);

  // Update with more specific error message
  store.updateAgent(agent.id, {
    error: fullReason,
  });

  // Notify callback
  if (watchdogState.onAgentTerminated) {
    watchdogState.onAgentTerminated(agent.id, fullReason);
  }

  // Clean up tracking
  cleanupAgentTracking(agent.id);
}

/**
 * Send a "nudge" to the agent to try to unstick it
 */
function nudgeAgent(agent: BackgroundAgent, status: AgentHealthStatus): void {
  const store = useBackgroundAgentsStore.getState();
  const nudgeMessage = getNudgeMessage(status);

  store.sendUserMessage(agent.id, nudgeMessage);

  console.log(`[Watchdog] Sent nudge to agent "${agent.agentName}": ${nudgeMessage}`);
}

/**
 * Generate a nudge message based on the stall reason
 */
function getNudgeMessage(status: AgentHealthStatus): string {
  switch (status.stallReason) {
    case "tool_loop":
      return (
        `[System] You appear to be in a loop - you've called ${status.loopInfo?.toolName} ` +
        `${status.loopInfo?.callCount} times with the same parameters. ` +
        "Try a different approach or different parameters."
      );

    case "no_progress":
      return (
        "[System] No progress detected for a while. " +
        "Please provide a status update or indicate if you need help."
      );

    case "waiting_too_long":
      return (
        "[System] You've been waiting for user input for a while. " +
        "Consider whether you can proceed with a reasonable assumption."
      );

    default:
      return (
        "[System] Health check: are you making progress? " +
        "Please continue or indicate if you're stuck."
      );
  }
}

/**
 * Escalate to user by showing the agent panel and highlighting the issue
 */
function escalateToUser(agent: BackgroundAgent, status: AgentHealthStatus): void {
  const store = useBackgroundAgentsStore.getState();

  // Select and show the stuck agent
  store.selectAgent(agent.id);
  store.showPanel();

  let escalationNote = `[Watchdog Alert] This agent appears stuck (${status.stallReason})`;

  if (status.loopInfo) {
    escalationNote += ` - calling ${status.loopInfo.toolName} repeatedly with same params`;
  }

  escalationNote += ". Consider terminating it (press 't') or providing guidance.";

  store.sendUserMessage(agent.id, escalationNote);

  console.log(`[Watchdog] Escalated agent "${agent.agentName}" to user attention`);
}

/**
 * Trigger parent check-in - called on the parent wake interval
 */
function triggerParentCheckIn(): void {
  if (!watchdogState.onParentCheckIn) {
    return;
  }

  const store = useBackgroundAgentsStore.getState();
  const agents = Array.from(store.agents.values());
  const now = Date.now();

  const summary: ParentCheckInSummary = {
    timestamp: now,
    totalAgents: agents.length,
    runningAgents: agents.filter(a => a.status === "running").length,
    waitingAgents: agents.filter(a => a.status === "waiting_for_user").length,
    completedAgents: agents.filter(a => a.status === "completed").length,
    failedAgents: agents.filter(a => a.status === "failed").length,
    healthStatuses: Array.from(watchdogState.healthStatus.values()),
    needsAttention: [],
  };

  // Identify agents that need attention
  for (const agent of agents) {
    if (agent.status !== "running" && agent.status !== "waiting_for_user") {
      continue;
    }

    const healthStatus = watchdogState.healthStatus.get(agent.id);
    const lastProgress = watchdogState.lastProgressTime.get(agent.id) ?? agent.startTime;
    const timeSinceProgress = now - lastProgress;
    const stallCount = watchdogState.stallCounts.get(agent.id) ?? 0;

    // Agent waiting for user
    if (agent.status === "waiting_for_user") {
      summary.needsAttention.push({
        agentId: agent.id,
        agentName: agent.agentName,
        reason: `Waiting for user input (${(timeSinceProgress / 1000).toFixed(0)}s)`,
        suggestion: "Answer the agent's question or terminate if not needed",
      });
      continue;
    }

    // Agent with health issues
    if (healthStatus && !healthStatus.isHealthy) {
      let suggestion = "Monitor or terminate";

      if (healthStatus.stallReason === "tool_loop") {
        suggestion = `Agent is looping on ${healthStatus.loopInfo?.toolName}. Consider terminating or providing guidance.`;
      } else if (healthStatus.stallReason === "no_progress") {
        suggestion = "No output for a while. May be stuck or doing long computation.";
      }

      summary.needsAttention.push({
        agentId: agent.id,
        agentName: agent.agentName,
        reason: `${healthStatus.stallReason} (stalls: ${stallCount})`,
        suggestion,
      });
      continue;
    }

    // Long-running agent (> 10 minutes)
    const runningTime = now - agent.startTime;
    if (runningTime > 600_000) {
      summary.needsAttention.push({
        agentId: agent.id,
        agentName: agent.agentName,
        reason: `Running for ${(runningTime / 60000).toFixed(0)} minutes`,
        suggestion: "Check if making expected progress",
      });
    }
  }

  watchdogState.onParentCheckIn(summary);
}

/**
 * Manually trigger a parent check-in (useful for on-demand status)
 */
export function getParentCheckInSummary(): ParentCheckInSummary {
  const store = useBackgroundAgentsStore.getState();
  const agents = Array.from(store.agents.values());
  const now = Date.now();

  const summary: ParentCheckInSummary = {
    timestamp: now,
    totalAgents: agents.length,
    runningAgents: agents.filter(a => a.status === "running").length,
    waitingAgents: agents.filter(a => a.status === "waiting_for_user").length,
    completedAgents: agents.filter(a => a.status === "completed").length,
    failedAgents: agents.filter(a => a.status === "failed").length,
    healthStatuses: Array.from(watchdogState.healthStatus.values()),
    needsAttention: [],
  };

  // Build needsAttention list (same logic as triggerParentCheckIn)
  for (const agent of agents) {
    if (agent.status !== "running" && agent.status !== "waiting_for_user") {
      continue;
    }

    const healthStatus = watchdogState.healthStatus.get(agent.id);
    const lastProgress = watchdogState.lastProgressTime.get(agent.id) ?? agent.startTime;
    const timeSinceProgress = now - lastProgress;
    const stallCount = watchdogState.stallCounts.get(agent.id) ?? 0;

    if (agent.status === "waiting_for_user") {
      summary.needsAttention.push({
        agentId: agent.id,
        agentName: agent.agentName,
        reason: `Waiting for user input (${(timeSinceProgress / 1000).toFixed(0)}s)`,
        suggestion: "Answer the agent's question or terminate if not needed",
      });
      continue;
    }

    if (healthStatus && !healthStatus.isHealthy) {
      let suggestion = "Monitor or terminate";
      if (healthStatus.stallReason === "tool_loop") {
        suggestion = `Agent is looping on ${healthStatus.loopInfo?.toolName}. Consider terminating.`;
      } else if (healthStatus.stallReason === "no_progress") {
        suggestion = "No output for a while. May be stuck.";
      }

      summary.needsAttention.push({
        agentId: agent.id,
        agentName: agent.agentName,
        reason: `${healthStatus.stallReason} (stalls: ${stallCount})`,
        suggestion,
      });
    }
  }

  return summary;
}

/**
 * Check if watchdog is currently running
 */
export function isWatchdogRunning(): boolean {
  return watchdogState.isRunning;
}

/**
 * Get current watchdog configuration
 */
export function getWatchdogConfig(): WatchdogConfig {
  return { ...watchdogState.config };
}
