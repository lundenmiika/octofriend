import { create } from "zustand";

/**
 * Background agent state - shared between task tool and UI.
 */
export type BackgroundAgent = {
  id: string;
  agentName: string;
  description: string;
  task: string;
  status: "running" | "completed" | "failed";
  outputFile: string;
  startTime: number;
  endTime?: number;
  output?: string;
  error?: string;
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
