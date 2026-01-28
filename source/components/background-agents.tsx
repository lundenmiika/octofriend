import React from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "./ink/spinner.tsx";
import { useColor } from "../theme.ts";
import {
  useBackgroundAgentsStore,
  useBackgroundAgents,
  useRunningAgentsCount,
  useSelectedAgent,
  BackgroundAgent,
} from "../agents/background-store.ts";

/**
 * Compact indicator shown below the input bar.
 * Shows count of running agents with keyboard hint.
 *
 * Press Enter when focused to expand the panel.
 */
export function BackgroundAgentsIndicator({ focused }: { focused: boolean }) {
  const agents = useBackgroundAgents();
  const runningCount = useRunningAgentsCount();
  const { togglePanel, panelVisible } = useBackgroundAgentsStore();
  const themeColor = useColor();

  // Handle keyboard when focused
  useInput(
    (input, key) => {
      if (key.return) {
        togglePanel();
      }
    },
    { isActive: focused },
  );

  if (agents.length === 0) return null;

  const completedCount = agents.filter(a => a.status === "completed").length;
  const failedCount = agents.filter(a => a.status === "failed").length;

  const statusParts: string[] = [];
  if (runningCount > 0) statusParts.push(`${runningCount} running`);
  if (completedCount > 0) statusParts.push(`${completedCount} done`);
  if (failedCount > 0) statusParts.push(`${failedCount} failed`);

  return (
    <Box
      width="100%"
      paddingX={1}
      borderStyle={focused ? "round" : undefined}
      borderColor={focused ? themeColor : undefined}
    >
      <Box gap={1}>
        {runningCount > 0 && (
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        )}
        <Text color={focused ? themeColor : "gray"}>
          {agents.length} background agent{agents.length !== 1 ? "s" : ""}
        </Text>
        <Text dimColor>({statusParts.join(", ")})</Text>
        {focused && (
          <Text dimColor>
            {" "}
            — Press <Text color={themeColor}>Enter</Text> to {panelVisible ? "hide" : "view"}
          </Text>
        )}
        {!focused && (
          <Text dimColor>
            {" "}
            — <Text color="gray">Ctrl+B</Text> to focus
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * Expanded panel showing all agents with tabbed interface.
 * Left/Right arrows switch between agents.
 * Shows agent output/status in detail.
 */
export function BackgroundAgentsPanel({ focused }: { focused: boolean }) {
  const agents = useBackgroundAgents();
  const selectedAgent = useSelectedAgent();
  const { selectNextAgent, selectPrevAgent, hidePanel, panelVisible, removeAgent } =
    useBackgroundAgentsStore();
  const themeColor = useColor();

  // Handle keyboard navigation
  useInput(
    (input, key) => {
      if (key.rightArrow || input === "l") {
        selectNextAgent();
      } else if (key.leftArrow || input === "h") {
        selectPrevAgent();
      } else if (key.escape || input === "q") {
        hidePanel();
      } else if (input === "d" && selectedAgent && selectedAgent.status !== "running") {
        // Dismiss completed/failed agent
        removeAgent(selectedAgent.id);
      }
    },
    { isActive: focused && panelVisible },
  );

  if (!panelVisible || agents.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={focused ? themeColor : "gray"}
      paddingX={1}
    >
      {/* Tab bar */}
      <Box gap={1} marginBottom={1}>
        {agents.map((agent, index) => (
          <AgentTab
            key={agent.id}
            agent={agent}
            isSelected={selectedAgent?.id === agent.id}
            index={index}
          />
        ))}
        <Box flexGrow={1} />
        <Text dimColor>←/→ switch | q close | d dismiss</Text>
      </Box>

      {/* Selected agent details */}
      {selectedAgent && <AgentDetails agent={selectedAgent} />}
    </Box>
  );
}

function AgentTab({
  agent,
  isSelected,
  index,
}: {
  agent: BackgroundAgent;
  isSelected: boolean;
  index: number;
}) {
  const themeColor = useColor();

  const statusIcon = {
    running: "◐",
    waiting_for_user: "?",
    completed: "✓",
    failed: "✗",
  }[agent.status];

  const statusColor = {
    running: "cyan",
    waiting_for_user: "yellow",
    completed: "green",
    failed: "red",
  }[agent.status];

  return (
    <Box>
      <Text color={isSelected ? themeColor : "gray"} bold={isSelected} inverse={isSelected}>
        {" "}
        <Text color={statusColor}>{statusIcon}</Text> {agent.agentName}{" "}
      </Text>
    </Box>
  );
}

function AgentDetails({ agent }: { agent: BackgroundAgent }) {
  const themeColor = useColor();

  const duration = agent.endTime
    ? ((agent.endTime - agent.startTime) / 1000).toFixed(1)
    : ((Date.now() - agent.startTime) / 1000).toFixed(1);

  // Determine what status color to use
  const statusColor =
    agent.status === "running"
      ? "cyan"
      : agent.status === "waiting_for_user"
        ? "yellow"
        : agent.status === "completed"
          ? "green"
          : "red";

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box gap={2}>
        <Text>
          <Text bold color={themeColor}>
            {agent.agentName}
          </Text>
          <Text dimColor> — {agent.description}</Text>
        </Text>
      </Box>

      {/* Status line */}
      <Box gap={2}>
        <Text>
          Status:{" "}
          <Text color={statusColor}>
            {agent.status}
            {agent.status === "running" && (
              <>
                {" "}
                <Spinner type="dots" />
              </>
            )}
          </Text>
        </Text>
        {agent.currentToolCall && (
          <Text>
            <Text dimColor>Tool:</Text>{" "}
            <Text color="cyan">
              {agent.currentToolCall.name} <Spinner type="dots" />
            </Text>
          </Text>
        )}
        <Text dimColor>Duration: {duration}s</Text>
      </Box>

      {/* Tool history */}
      {agent.toolHistory && agent.toolHistory.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>Tools used: {agent.toolHistory.map(t => t.name).join(" → ")}</Text>
        </Box>
      )}

      {/* Task */}
      <Box marginTop={1}>
        <Text>
          <Text bold>Task:</Text> {truncate(agent.task, 200)}
        </Text>
      </Box>

      {/* Streaming content (when running) */}
      {agent.status === "running" && agent.streamingContent && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">
            Progress:
          </Text>
          <Box paddingLeft={1} height={4} overflow="hidden">
            <Text wrap="wrap" dimColor>
              {truncate(agent.streamingContent, 300)}
            </Text>
          </Box>
        </Box>
      )}

      {/* Pending question (waiting for user) */}
      {agent.status === "waiting_for_user" && agent.pendingQuestion && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">
            Agent is asking:
          </Text>
          <Box paddingLeft={1}>
            <Text color="yellow">{agent.pendingQuestion.question}</Text>
          </Box>
          <Text dimColor>Type your answer and press Enter</Text>
        </Box>
      )}

      {/* Final Output */}
      {agent.output && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={themeColor}>
            Output:
          </Text>
          <Box paddingLeft={1}>
            <Text wrap="wrap">{truncate(agent.output, 500)}</Text>
          </Box>
        </Box>
      )}

      {/* Error */}
      {agent.error && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="red">
            Error:
          </Text>
          <Box paddingLeft={1}>
            <Text color="red" wrap="wrap">
              {agent.error}
            </Text>
          </Box>
        </Box>
      )}

      {/* Output file hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Full output: <Text color="gray">{agent.outputFile}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
