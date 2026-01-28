import { create } from "zustand";

/**
 * Tool call being executed by a subagent
 */
export type AgentToolCall = {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  startTime?: number;
};

/**
 * Pending question from subagent to user
 */
export type AgentQuestion = {
  id: string;
  question: string;
  resolve: (answer: string) => void;
};

/**
 * Background agent state - shared between task tool and UI.
 */
export type BackgroundAgent = {
  id: string;
  agentName: string;
  description: string;
  task: string;
  status: "running" | "waiting_for_user" | "completed" | "failed";
  outputFile: string;
  startTime: number;
  endTime?: number;
  output?: string;
  error?: string;

  // Streaming progress
  streamingContent?: string;
  currentToolCall?: AgentToolCall;
  toolHistory?: AgentToolCall[];

  // User interaction
  pendingQuestion?: AgentQuestion;
  userMessages?: string[];
};

export type BackgroundAgentsState = {
  agents: Map<string, BackgroundAgent>;
  selectedAgentId: string | null;
  panelVisible: boolean;

  // Actions
  addAgent: (agent: BackgroundAgent) => void;
  updateAgent: (id: string, update: Partial<BackgroundAgent>) => void;
  removeAgent: (id: string) => void;
  selectAgent: (id: string | null) => void;
  togglePanel: () => void;
  showPanel: () => void;
  hidePanel: () => void;
  selectNextAgent: () => void;
  selectPrevAgent: () => void;

  // Streaming updates
  appendStreamingContent: (id: string, content: string) => void;
  setToolCall: (id: string, toolCall: AgentToolCall | undefined) => void;

  // User interaction
  answerQuestion: (agentId: string, answer: string) => void;
  sendUserMessage: (agentId: string, message: string) => void;
};

export const useBackgroundAgentsStore = create<BackgroundAgentsState>((set, get) => ({
  agents: new Map(),
  selectedAgentId: null,
  panelVisible: false,

  addAgent: agent => {
    set(state => {
      const newAgents = new Map(state.agents);
      newAgents.set(agent.id, agent);
      return {
        agents: newAgents,
        // Auto-select first agent if none selected
        selectedAgentId: state.selectedAgentId ?? agent.id,
      };
    });
  },

  updateAgent: (id, update) => {
    set(state => {
      const agent = state.agents.get(id);
      if (!agent) return state;

      const newAgents = new Map(state.agents);
      newAgents.set(id, { ...agent, ...update });
      return { agents: newAgents };
    });
  },

  removeAgent: id => {
    set(state => {
      const newAgents = new Map(state.agents);
      newAgents.delete(id);

      // Update selection if removed agent was selected
      let newSelectedId = state.selectedAgentId;
      if (state.selectedAgentId === id) {
        const agentIds = Array.from(newAgents.keys());
        newSelectedId = agentIds.length > 0 ? agentIds[0] : null;
      }

      return {
        agents: newAgents,
        selectedAgentId: newSelectedId,
        panelVisible: newAgents.size > 0 ? state.panelVisible : false,
      };
    });
  },

  selectAgent: id => {
    set({ selectedAgentId: id });
  },

  togglePanel: () => {
    const { agents, panelVisible } = get();
    if (agents.size === 0) return;
    set({ panelVisible: !panelVisible });
  },

  showPanel: () => {
    const { agents } = get();
    if (agents.size === 0) return;
    set({ panelVisible: true });
  },

  hidePanel: () => {
    set({ panelVisible: false });
  },

  selectNextAgent: () => {
    const { agents, selectedAgentId } = get();
    const agentIds = Array.from(agents.keys());
    if (agentIds.length === 0) return;

    const currentIndex = selectedAgentId ? agentIds.indexOf(selectedAgentId) : -1;
    const nextIndex = (currentIndex + 1) % agentIds.length;
    set({ selectedAgentId: agentIds[nextIndex] });
  },

  selectPrevAgent: () => {
    const { agents, selectedAgentId } = get();
    const agentIds = Array.from(agents.keys());
    if (agentIds.length === 0) return;

    const currentIndex = selectedAgentId ? agentIds.indexOf(selectedAgentId) : 0;
    const prevIndex = (currentIndex - 1 + agentIds.length) % agentIds.length;
    set({ selectedAgentId: agentIds[prevIndex] });
  },

  appendStreamingContent: (id, content) => {
    set(state => {
      const agent = state.agents.get(id);
      if (!agent) return state;

      const newAgents = new Map(state.agents);
      newAgents.set(id, {
        ...agent,
        streamingContent: (agent.streamingContent || "") + content,
      });
      return { agents: newAgents };
    });
  },

  setToolCall: (id, toolCall) => {
    set(state => {
      const agent = state.agents.get(id);
      if (!agent) return state;

      const newAgents = new Map(state.agents);
      const toolHistory = agent.toolHistory || [];

      // If completing a tool call, add to history
      if (agent.currentToolCall && (!toolCall || toolCall.name !== agent.currentToolCall.name)) {
        toolHistory.push({ ...agent.currentToolCall, status: "completed" });
      }

      newAgents.set(id, {
        ...agent,
        currentToolCall: toolCall,
        toolHistory,
      });
      return { agents: newAgents };
    });
  },

  answerQuestion: (agentId, answer) => {
    const agent = get().agents.get(agentId);
    if (!agent?.pendingQuestion) return;

    // Resolve the pending promise
    agent.pendingQuestion.resolve(answer);

    // Update state
    set(state => {
      const ag = state.agents.get(agentId);
      if (!ag) return state;

      const newAgents = new Map(state.agents);
      newAgents.set(agentId, {
        ...ag,
        status: "running",
        pendingQuestion: undefined,
        userMessages: [
          ...(ag.userMessages || []),
          `Q: ${ag.pendingQuestion?.question}`,
          `A: ${answer}`,
        ],
      });
      return { agents: newAgents };
    });
  },

  sendUserMessage: (agentId, message) => {
    set(state => {
      const agent = state.agents.get(agentId);
      if (!agent) return state;

      const newAgents = new Map(state.agents);
      newAgents.set(agentId, {
        ...agent,
        userMessages: [...(agent.userMessages || []), `User: ${message}`],
      });
      return { agents: newAgents };
    });
    // Note: Actually injecting user message into subagent would require
    // more complex architecture (message queue, etc.)
  },
}));

// Helper hooks for common selections
export function useBackgroundAgents() {
  return useBackgroundAgentsStore(state => Array.from(state.agents.values()));
}

export function useRunningAgentsCount() {
  return useBackgroundAgentsStore(
    state => Array.from(state.agents.values()).filter(a => a.status === "running").length,
  );
}

export function useSelectedAgent() {
  return useBackgroundAgentsStore(state => {
    if (!state.selectedAgentId) return null;
    return state.agents.get(state.selectedAgentId) ?? null;
  });
}
