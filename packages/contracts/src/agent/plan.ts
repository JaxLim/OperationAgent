import { z } from 'zod';
import { utf8ByteLength } from '../events/tool-output.js';

export const PLAN_LIMITS = Object.freeze({ maxSteps: 24, maxTitleChars: 160, stalledTurns: 4, maxReminders: 2 });
const step = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/),
  title: z.string().trim().min(1).max(PLAN_LIMITS.maxTitleChars),
  status: z.enum(['pending', 'in_progress', 'completed']),
  dependsOn: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,48}$/)).max(PLAN_LIMITS.maxSteps).default([]),
});
export const UpdatePlanInputSchema = z.strictObject({ steps: z.array(step).min(1).max(PLAN_LIMITS.maxSteps) }).superRefine(({ steps }, context) => {
  const byId = new Map(steps.map(item => [item.id, item]));
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (byId.size !== steps.length) invalid('DUPLICATE_STEP_ID');
  if (steps.filter(item => item.status === 'in_progress').length > 1) invalid('MULTIPLE_ACTIVE_STEPS');
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const item = byId.get(id);
    if (!item) return false;
    for (const dependency of item.dependsOn) {
      if (!visit(dependency)) return false;
      if (item.status !== 'pending' && byId.get(dependency)?.status !== 'completed') return false;
    }
    visiting.delete(id); visited.add(id);
    return new Set(item.dependsOn).size === item.dependsOn.length;
  }
  for (const item of steps) if (!visit(item.id)) { invalid('INVALID_PLAN_DEPENDENCY'); break; }
  if (utf8ByteLength(JSON.stringify({ steps })) > 12_288) invalid('PLAN_TOO_LARGE');
});
export type UpdatePlanInput = z.infer<typeof UpdatePlanInputSchema>;
export const TaskPlanSchema = UpdatePlanInputSchema.safeExtend({ revision: z.int().positive(), turn: z.int().min(1).max(40) });
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
