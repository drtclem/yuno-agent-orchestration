// Each editable leaf setting is one dimension; collection contents form one setting.
export const AGENT_DIMENSIONS = [
  { key: 'name', label: 'Name', group: 'Basics' },
  { key: 'role', label: 'Role', group: 'Basics' },
  { key: 'systemPrompt', label: 'System prompt', group: 'Basics' },
  { key: 'model', label: 'Model', group: 'Basics' },
  { key: 'tools.bash', label: 'Bash enabled', group: 'Tools & permissions' },
  { key: 'tools.edit', label: 'Edit enabled', group: 'Tools & permissions' },
  {
    key: 'tools.webfetch',
    label: 'Webfetch enabled',
    group: 'Tools & permissions',
  },
  {
    key: 'permissions.bash',
    label: 'Bash permission',
    group: 'Tools & permissions',
  },
  {
    key: 'permissions.edit',
    label: 'Edit permission',
    group: 'Tools & permissions',
  },
  {
    key: 'permissions.webfetch',
    label: 'Webfetch permission',
    group: 'Tools & permissions',
  },
  {
    key: 'permissions.denyBash',
    label: 'Blocked commands',
    group: 'Tools & permissions',
  },
  {
    key: 'permissions.canDeploy',
    label: 'Can deploy',
    group: 'Tools & permissions',
  },
  { key: 'channel', label: 'Slack binding', group: 'Channels' },
  { key: 'schedules', label: 'Schedules', group: 'Schedules' },
  { key: 'memories', label: 'Memory', group: 'Memory' },
  { key: 'skills', label: 'Skills', group: 'Skills' },
  {
    key: 'guardrails.runCostCapUsd',
    label: 'Run cost cap',
    group: 'Guardrails',
  },
  {
    key: 'guardrails.dailyCostCapUsd',
    label: 'Daily cost cap',
    group: 'Guardrails',
  },
  {
    key: 'guardrails.maxTurnsPerHour',
    label: 'Max turns per hour',
    group: 'Guardrails',
  },
  {
    key: 'guardrails.turnTimeoutMs',
    label: 'Turn timeout',
    group: 'Guardrails',
  },
] as const;
