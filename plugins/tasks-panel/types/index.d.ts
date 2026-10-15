export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  status: TaskStatus
  blockedBy: string[]
  owner?: string
  // A subagent's TaskUpdate touched it, or it has an owner
  byAgent: boolean
}

// A pending AskUserQuestion call and its question texts
export type Ask = { id: string; questions: string[] }

export type Plan = { path: string; goal: string | null; questions: string[] }

declare module 'claude-code' {
  interface PluginState {
    'tasks-panel': { tasks: Task[]; asks: Ask[]; plan: Plan | null }
  }
}
