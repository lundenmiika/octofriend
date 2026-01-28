import { useBackgroundAgentsStore, BackgroundAgent } from "./background-store.ts";

/**
 * Configuration for the agent watchdog
 */
export type WatchdogConfig = {
  /** How often to check agents (ms) */
  checkIntervalMs: number;
  /** No streaming updates for this long = potentially stuck (ms) */
  noProgressThresholdMs: number;
  /** Tool running for this long = potentially stuck (ms) */
  toolStuckThresholdMs: number;
  /** Waiting for user this long = auto-escalate (ms) */
  waitingForUserThresholdMs: number;
  /** What action to take when agent is stuck */
  stallAction: "warn" | "terminate" | "nudge" | "escalate";
  /** Max consecutive stalls before forced termination */
  maxConsecutiveStalls: number;
};

const DEFAULT_CONFIG: WatchdogConfig = {
  checkIntervalMs: 30_000, // Check every 30 seconds
  noProgressThresholdMs: 60_000, // 1 minute no progress
  toolStuckThresholdMs: 120_000, // 2 minutes on same tool
  waitingForUserThresholdMs: 300_000, // 5 minutes waiting for user
  stallAction: "warn",
  maxConsecutiveStalls: 3,
};

export type StallReason = "no_progress" | "tool_stuck" | "waiting_too_long" | "unknown";

export type AgentHealthStatus = {
  agentId: string;
  isHealthy: boolean;
  stallReason?: StallReason;
  stallDurationMs?: number;
  consecutiveStalls: number;
  lastCheckTime: number;
};

type WatchdogState = {
  isRunning: boolean;
  intervalId: NodeJS.Timeout | null;
  config: WatchdogConfig;
  healthStatus: Map<string, AgentHealthStatus>;
  stallCounts: Map<string, number>;
  lastProgressTime: Map<string, number>;
  onStallDetected?: (agentId: string, status: AgentHealthStatus) => void;
  onAgentTerminated?: (agentId: string, reason: string) => void;
};

let watchdogState: WatchdogState = {
  isRunning: false,
  intervalId: null,
  config: DEFAULT_CONFIG,
  healthStatus: new Map(),
  stallCounts: new Map(),
  lastProgressTime: new Map(),
};

/**
 * Start the watchdog to monitor background agents
 */
export function startWatchdog(
  config?: Partial<WatchdogConfig>,
  callbacks?: {
    onStallDetected?: (agentId: string, status: AgentHealthStatus) => void;
    onAgentTerminated?: (agentId: string, reason: string) => void;
  },
): void {
  if (watchdogState.isRunning) {
    return;
  }

  watchdogState.config = { ...DEFAULT_CONFIG, ...config };
  watchdogState.onStallDetected = callbacks?.onStallDetected;
  watchdogState.onAgentTerminated = callbacks?.onAgentTerminated;
  watchdogState.isRunning = true;

  // Run initial check
  checkAgents();

  // Schedule periodic checks
  watchdogState.intervalId = setInterval(checkAgents, watchdogState.config.checkIntervalMs);
}

/**
 * Stop the watchdog
 */
export function stopWatchdog(): void {
  if (watchdogState.intervalId) {
    clearInterval(watchdogState.intervalId);
    watchdogState.intervalId = null;
  }
  watchdogState.isRunning = false;
}

/**
 * Update watchdog config while running
 */
export function updateWatchdogConfig(config: Partial<WatchdogConfig>): void {
  watchdogState.config = { ...watchdogState.config, ...config };

  // Restart with new interval if changed
  if (config.checkIntervalMs && watchdogState.isRunning) {
    stopWatchdog();
    startWatchdog(watchdogState.config);
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
      watchdogState.healthStatus.delete(agent.id);
      watchdogState.stallCounts.delete(agent.id);
      watchdogState.lastProgressTime.delete(agent.id);
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
    const waitingDuration = now - (agent.startTime + (lastProgress - agent.startTime));
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

  // Check for tool stuck
  if (agent.currentToolCall) {
    const toolDuration = now - (agent.currentToolCall.startTime ?? now);
    if (toolDuration > config.toolStuckThresholdMs) {
      return {
        ...baseStatus,
        isHealthy: false,
        stallReason: "tool_stuck",
        stallDurationMs: toolDuration,
      };
    }
  }

  // Check for no progress
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
  const durationSec = ((status.stallDurationMs ?? 0) / 1000).toFixed(0);
  console.warn(
    `[Watchdog] Agent "${agent.agentName}" (${agent.id}) appears stuck: ` +
      `${status.stallReason} for ${durationSec}s (stall #${status.consecutiveStalls})`,
  );
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

  const fullReason =
    `Auto-terminated by watchdog: ${reason} (${status.stallReason}, ` +
    `${((status.stallDurationMs ?? 0) / 1000).toFixed(0)}s)`;

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
  watchdogState.healthStatus.delete(agent.id);
  watchdogState.stallCounts.delete(agent.id);
  watchdogState.lastProgressTime.delete(agent.id);
}

/**
 * Send a "nudge" to the agent to try to unstick it
 * This injects a user message into the agent's pending messages
 */
function nudgeAgent(agent: BackgroundAgent, status: AgentHealthStatus): void {
  const store = useBackgroundAgentsStore.getState();

  const nudgeMessage = getNudgeMessage(status);

  // Use the sendUserMessage function to inject a nudge
  store.sendUserMessage(agent.id, nudgeMessage);

  console.log(`[Watchdog] Sent nudge to agent "${agent.agentName}": ${nudgeMessage}`);
}

/**
 * Generate a nudge message based on the stall reason
 */
function getNudgeMessage(status: AgentHealthStatus): string {
  switch (status.stallReason) {
    case "tool_stuck":
      return (
        "[System] The current tool operation is taking longer than expected. " +
        "Consider whether it might be stuck and if you should try a different approach."
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

  // Add a user message indicating the escalation
  const escalationNote =
    `[Watchdog Alert] This agent appears stuck (${status.stallReason}). ` +
    `Consider terminating it (press 't') or providing guidance.`;

  store.sendUserMessage(agent.id, escalationNote);

  console.log(`[Watchdog] Escalated agent "${agent.agentName}" to user attention`);
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
