import type { Verdict } from '@yuno/shared';

export const REPLY_PROTOCOL = `When you finish, reply with your result for the next step.
If you are reviewing or deciding, end with exactly one line: VERDICT: APPROVED or VERDICT: REJECTED
(when rejecting, explain what to fix above that line).
To remember something for future sessions, add a line: REMEMBER: <fact>
Work only inside the workspace directory you are given.`;

export function parseReply(reply: string): {
  text: string;
  verdict: Verdict | null;
  memories: string[];
} {
  let verdict: Verdict | null = null;
  const memories: string[] = [];
  const visible: string[] = [];
  for (const line of reply.split(/\r?\n/)) {
    const memory = /^\s*REMEMBER:\s*(.*)$/i.exec(line);
    if (memory) {
      const fact = memory[1]?.trim();
      if (fact) memories.push(fact);
      continue;
    }
    const decision = /^\s*VERDICT:\s*(APPROVED|REJECTED)\s*$/i.exec(line);
    if (decision) {
      verdict =
        decision[1]?.toLowerCase() === 'approved' ? 'approved' : 'rejected';
    }
    visible.push(line);
  }
  return { text: visible.join('\n'), verdict, memories };
}
