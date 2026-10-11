import { z } from "zod";

export const routingDecisionSchema = z.strictObject({
  task: z.enum(["simple", "question", "task", "complex", "research", "bug_research"]),
  fast: z.boolean(),
});

export type RoutingDecision = z.infer<typeof routingDecisionSchema>;
