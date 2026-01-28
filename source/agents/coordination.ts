/**
 * Agent Coordination System
 *
 * Addresses the "curse of coordination" problem where parallel agents:
 * - Fail to model what partners are doing (42% of failures)
 * - Don't follow through on commitments (32%)
 * - Have communication breakdowns (26%)
 * - Hallucinate shared states
 * - Silently overwrite each other's work
 *
 * Solutions implemented:
 * 1. File scope restrictions - each agent can only write to specific paths
 * 2. Task contracts - explicit boundaries and expectations
 * 3. File ownership tracking - prevent concurrent writes
 * 4. Coordination context - inject info about sibling agents
 */

import { create } from "zustand";

/**
 * Task contract defines explicit boundaries for a subagent
 */
export type TaskContract = {
  /** Unique ID for this task assignment */
  taskId: string;

  /** Human-readable description of what to accomplish */
  objective: string;

  /** Files/directories this agent MAY read (glob patterns) */
  allowedReadPaths?: string[];

  /** Files/directories this agent MAY write (glob patterns) - strict! */
  allowedWritePaths?: string[];

  /** Files/directories this agent must NOT touch */
  forbiddenPaths?: string[];

  /** What this task should produce (for verification) */
  expectedOutputs?: string[];

  /** What this agent should NOT do */
  restrictions?: string[];

  /** Info about sibling agents working in parallel */
  siblingContext?: SiblingAgentInfo[];

  /** Dependencies - task IDs that must complete before this one */
  dependsOn?: string[];

  /** Whether this task is read-only (no file modifications) */
  readOnly?: boolean;
};

/**
 * Minimal info about sibling agents to prevent conflicts
 */
export type SiblingAgentInfo = {
  agentId: string;
  agentName: string;
  objective: string;
  /** Files this sibling is working on - DO NOT TOUCH */
  ownedPaths: string[];
};

/**
 * File ownership entry
 */
type FileOwnership = {
  path: string;
  ownerId: string; // agent ID
  ownerName: string;
  acquiredAt: number;
  /** If true, allows reads but blocks writes from others */
  exclusive: boolean;
};

/**
 * Coordination state - tracks file ownership and active contracts
 */
type CoordinationState = {
  /** Active task contracts by agent ID */
  contracts: Map<string, TaskContract>;

  /** File ownership tracking */
  fileOwnership: Map<string, FileOwnership>;

  /** Register a task contract for an agent */
  registerContract: (agentId: string, contract: TaskContract) => void;

  /** Remove contract when agent completes */
  removeContract: (agentId: string) => void;

  /** Acquire ownership of files for an agent */
  acquireFiles: (
    agentId: string,
    agentName: string,
    paths: string[],
    exclusive?: boolean,
  ) => boolean;

  /** Release file ownership */
  releaseFiles: (agentId: string) => void;

  /** Check if a path can be written by an agent */
  canWrite: (agentId: string, path: string) => { allowed: boolean; reason?: string };

  /** Get sibling context for an agent (info about other active agents) */
  getSiblingContext: (excludeAgentId: string) => SiblingAgentInfo[];

  /** Get all paths owned by other agents (for conflict avoidance) */
  getOtherOwnedPaths: (excludeAgentId: string) => string[];
};

export const useCoordinationStore = create<CoordinationState>((set, get) => ({
  contracts: new Map(),
  fileOwnership: new Map(),

  registerContract: (agentId, contract) => {
    set(state => {
      const newContracts = new Map(state.contracts);
      newContracts.set(agentId, contract);
      return { contracts: newContracts };
    });
  },

  removeContract: agentId => {
    set(state => {
      const newContracts = new Map(state.contracts);
      newContracts.delete(agentId);
      return { contracts: newContracts };
    });

    // Also release any file ownership
    get().releaseFiles(agentId);
  },

  acquireFiles: (agentId, agentName, paths, exclusive = true) => {
    const { fileOwnership } = get();

    // Check for conflicts first
    for (const path of paths) {
      const existing = fileOwnership.get(path);
      if (existing && existing.ownerId !== agentId && existing.exclusive) {
        console.warn(
          `[Coordination] Cannot acquire ${path} for ${agentName} - ` +
            `already owned by ${existing.ownerName}`,
        );
        return false;
      }
    }

    // Acquire all paths
    set(state => {
      const newOwnership = new Map(state.fileOwnership);
      for (const path of paths) {
        newOwnership.set(path, {
          path,
          ownerId: agentId,
          ownerName: agentName,
          acquiredAt: Date.now(),
          exclusive,
        });
      }
      return { fileOwnership: newOwnership };
    });

    return true;
  },

  releaseFiles: agentId => {
    set(state => {
      const newOwnership = new Map(state.fileOwnership);
      for (const [path, ownership] of newOwnership) {
        if (ownership.ownerId === agentId) {
          newOwnership.delete(path);
        }
      }
      return { fileOwnership: newOwnership };
    });
  },

  canWrite: (agentId, path) => {
    const { fileOwnership, contracts } = get();
    const contract = contracts.get(agentId);

    // Check if read-only contract
    if (contract?.readOnly) {
      return { allowed: false, reason: "Task contract is read-only" };
    }

    // Check file ownership by others
    const ownership = fileOwnership.get(path);
    if (ownership && ownership.ownerId !== agentId && ownership.exclusive) {
      return {
        allowed: false,
        reason: `File owned by ${ownership.ownerName} - coordinate before modifying`,
      };
    }

    // Check allowed write paths in contract
    if (contract?.allowedWritePaths && contract.allowedWritePaths.length > 0) {
      const isAllowed = contract.allowedWritePaths.some(pattern => matchesGlob(path, pattern));
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Path not in allowed write scope: ${contract.allowedWritePaths.join(", ")}`,
        };
      }
    }

    // Check forbidden paths
    if (contract?.forbiddenPaths) {
      const isForbidden = contract.forbiddenPaths.some(pattern => matchesGlob(path, pattern));
      if (isForbidden) {
        return { allowed: false, reason: "Path is in forbidden list" };
      }
    }

    return { allowed: true };
  },

  getSiblingContext: excludeAgentId => {
    const { contracts, fileOwnership } = get();
    const siblings: SiblingAgentInfo[] = [];

    for (const [agentId, contract] of contracts) {
      if (agentId === excludeAgentId) continue;

      // Gather owned paths for this sibling
      const ownedPaths: string[] = [];
      for (const [path, ownership] of fileOwnership) {
        if (ownership.ownerId === agentId) {
          ownedPaths.push(path);
        }
      }

      // Also include declared allowed write paths
      if (contract.allowedWritePaths) {
        ownedPaths.push(...contract.allowedWritePaths);
      }

      siblings.push({
        agentId,
        agentName: contract.taskId, // Use taskId as name
        objective: contract.objective,
        ownedPaths: [...new Set(ownedPaths)], // Dedupe
      });
    }

    return siblings;
  },

  getOtherOwnedPaths: excludeAgentId => {
    const { fileOwnership } = get();
    const paths: string[] = [];

    for (const [path, ownership] of fileOwnership) {
      if (ownership.ownerId !== excludeAgentId) {
        paths.push(path);
      }
    }

    return paths;
  },
}));

/**
 * Simple glob matching (supports * and **)
 */
function matchesGlob(path: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // Convert glob to regex
  const regexPattern = normalizedPattern
    .replace(/\./g, "\\.") // Escape dots
    .replace(/\*\*/g, "<<<GLOBSTAR>>>") // Temp placeholder for **
    .replace(/\*/g, "[^/]*") // * matches anything except /
    .replace(/<<<GLOBSTAR>>>/g, ".*"); // ** matches anything including /

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normalizedPath);
}

/**
 * Generate coordination instructions to inject into subagent system prompt
 */
export function generateCoordinationInstructions(contract: TaskContract): string {
  const sections: string[] = [];

  sections.push("# Task Contract\n");
  sections.push(`**Objective**: ${contract.objective}\n`);

  if (contract.readOnly) {
    sections.push(
      "**Mode**: READ-ONLY - You may explore and analyze but MUST NOT modify any files.\n",
    );
  }

  if (contract.allowedWritePaths && contract.allowedWritePaths.length > 0) {
    sections.push("**Allowed Write Paths** (you may ONLY modify files matching these patterns):");
    for (const p of contract.allowedWritePaths) {
      sections.push(`  - ${p}`);
    }
    sections.push("");
  }

  if (contract.forbiddenPaths && contract.forbiddenPaths.length > 0) {
    sections.push("**Forbidden Paths** (DO NOT read or modify):");
    for (const p of contract.forbiddenPaths) {
      sections.push(`  - ${p}`);
    }
    sections.push("");
  }

  if (contract.restrictions && contract.restrictions.length > 0) {
    sections.push("**Restrictions**:");
    for (const r of contract.restrictions) {
      sections.push(`  - ${r}`);
    }
    sections.push("");
  }

  if (contract.expectedOutputs && contract.expectedOutputs.length > 0) {
    sections.push("**Expected Outputs** (what you should produce):");
    for (const o of contract.expectedOutputs) {
      sections.push(`  - ${o}`);
    }
    sections.push("");
  }

  if (contract.siblingContext && contract.siblingContext.length > 0) {
    sections.push("# Sibling Agents (DO NOT interfere with their work)\n");
    sections.push(
      "Other agents are working in parallel. To avoid conflicts, DO NOT modify their files.\n",
    );

    for (const sibling of contract.siblingContext) {
      sections.push(`**${sibling.agentName}**: ${sibling.objective}`);
      if (sibling.ownedPaths.length > 0) {
        sections.push(`  Files they own (DO NOT MODIFY): ${sibling.ownedPaths.join(", ")}`);
      }
      sections.push("");
    }
  }

  sections.push("# Coordination Rules\n");
  sections.push("1. Stay within your assigned scope - do not modify files outside allowed paths");
  sections.push(
    "2. Do not assume what sibling agents have done - only trust your own observations",
  );
  sections.push("3. If you need something outside your scope, report it and ask for guidance");
  sections.push("4. Complete your specific objective, nothing more");
  sections.push("5. If you encounter conflicts, STOP and report rather than overwriting");

  return sections.join("\n");
}

/**
 * Validate that a task can be safely parallelized
 */
export function validateParallelization(contracts: TaskContract[]): {
  safe: boolean;
  conflicts: string[];
} {
  const conflicts: string[] = [];

  // Check for overlapping write paths
  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const a = contracts[i];
      const b = contracts[j];

      if (!a.allowedWritePaths || !b.allowedWritePaths) continue;

      for (const pathA of a.allowedWritePaths) {
        for (const pathB of b.allowedWritePaths) {
          if (pathsOverlap(pathA, pathB)) {
            conflicts.push(
              `Tasks "${a.taskId}" and "${b.taskId}" both write to overlapping paths: ${pathA}, ${pathB}`,
            );
          }
        }
      }
    }
  }

  return {
    safe: conflicts.length === 0,
    conflicts,
  };
}

/**
 * Check if two path patterns could overlap
 */
function pathsOverlap(a: string, b: string): boolean {
  // Simple check - if either is a prefix of the other or they're equal
  const normA = a.replace(/\*/g, "");
  const normB = b.replace(/\*/g, "");

  return normA.startsWith(normB) || normB.startsWith(normA) || a === b;
}

/**
 * Helper to create a read-only exploration contract
 */
export function createExplorationContract(
  taskId: string,
  objective: string,
  focusPaths?: string[],
): TaskContract {
  return {
    taskId,
    objective,
    readOnly: true,
    allowedReadPaths: focusPaths,
    restrictions: [
      "Do not modify any files",
      "Do not create new files",
      "Focus on analysis and reporting",
    ],
    expectedOutputs: [
      "Summary of findings",
      "Relevant file paths",
      "Recommendations if applicable",
    ],
  };
}

/**
 * Helper to create a scoped modification contract
 */
export function createScopedModificationContract(
  taskId: string,
  objective: string,
  writePaths: string[],
  options?: {
    forbiddenPaths?: string[];
    restrictions?: string[];
    expectedOutputs?: string[];
  },
): TaskContract {
  return {
    taskId,
    objective,
    readOnly: false,
    allowedWritePaths: writePaths,
    forbiddenPaths: options?.forbiddenPaths ?? [],
    restrictions: options?.restrictions ?? [
      "Only modify files within allowed paths",
      "Do not refactor or change code outside your scope",
      "Keep changes focused on the objective",
    ],
    expectedOutputs: options?.expectedOutputs ?? ["Modified files within allowed paths"],
  };
}
