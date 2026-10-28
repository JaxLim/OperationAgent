import { z } from 'zod';
export const ServiceTreeIdentitySchema = z.strictObject({ mainRunId: z.uuid(), expressRunId: z.uuid() });
export type ServiceTreeIdentity = z.infer<typeof ServiceTreeIdentitySchema>;
