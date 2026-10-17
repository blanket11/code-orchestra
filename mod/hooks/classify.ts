// Maps Claude Code tool calls to musical event kinds. Pure functions only:
// no tool input text is kept, just the kind.

export type Kind =
  | 'read' | 'search' | 'edit' | 'write' | 'bash'
  | 'test_pass' | 'test_fail' | 'error' | 'prompt' | 'agent' | 'turn_end'

const READ = new Set(['Read', 'NotebookRead', 'WebFetch', 'LS'])
const SEARCH = new Set(['Grep', 'Glob', 'WebSearch', 'ToolSearch'])
const EDIT = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const WRITE = new Set(['Write'])
const AGENT = new Set(['Task', 'Agent'])

// Commands that run a test suite. A plain exit code 0 is never a test pass.
const TEST_CMD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|pytest|jest|vitest|cargo\s+test|go\s+test|swift\s+test|make\s+test|claude\s+plugin\s+test|deno\s+test)\b/
// Summary lines of common runners: "12 passed", "# pass 5" (TAP), "ℹ pass 5" (node --test spec).
const PASS = /(?:\b[1-9]\d*\s+(?:passed|passing)\b|^\s*[#ℹ]?\s*pass\s+[1-9]\d*\s*$|\bAll tests passed\b)/im
const FAIL = /(?:\b[1-9]\d*\s+(?:failed|failing)\b|^\s*[#ℹ]?\s*fail\s+[1-9]\d*\s*$|\bFAIL\b|\bAssertionError\b)/m

/** Kind to play when the call starts (exploration sings right away). */
export function kindAtStart(tool: string): Kind | null {
  if (READ.has(tool)) return 'read'
  if (SEARCH.has(tool)) return 'search'
  if (AGENT.has(tool)) return 'agent'
  if (tool === 'Bash') return 'bash'
  return null
}

/** Kind to play once the call has answered. */
export function kindAtEnd(
  tool: string,
  command: string | undefined,
  outcome: { isError: boolean; denied: boolean; text: string },
): Kind | null {
  if (outcome.denied) return null
  if (EDIT.has(tool)) return outcome.isError ? 'error' : 'edit'
  if (WRITE.has(tool)) return outcome.isError ? 'error' : 'write'
  if (tool === 'Bash' && command !== undefined && isTestCommand(command)) {
    const text = outcome.text.slice(-20000)
    if (outcome.isError || FAIL.test(text)) return 'test_fail'
    if (PASS.test(text)) return 'test_pass'
    return null // could not judge: no test moment
  }
  if (tool === 'Bash' && outcome.isError) return 'error'
  return null
}

export function isTestCommand(command: string): boolean {
  return TEST_CMD.test(command)
}

/** Short label shown in the pane when an event lands in the music. */
export const KIND_LABEL: Record<Kind, string> = {
  read: 'Read → melody',
  search: 'Search → melody',
  agent: 'Agent → melody+arp',
  edit: 'Edit → beat+bass',
  write: 'Write → beat+bass',
  bash: 'Bash → arp',
  test_pass: 'Tests passed → LIFT',
  test_fail: 'Tests failed → shadow',
  error: 'Error → shadow',
  prompt: 'Prompt → pad swell',
  turn_end: 'Turn done → calm',
}
