import { z } from "zod";
import { JsonStore } from "../shared/json-store.js";
import type { Logger } from "../shared/logger.js";

export const settingsPatchSchema = z
  .strictObject({
    remoteClientContext: z.boolean(),
    autoMode: z.boolean(),
  })
  .partial();

const settingsSchema = z.strictObject({
  remoteClientContext: z.boolean(),
  autoMode: z.boolean().default(true),
});

const storedSettingsSchema = settingsSchema.extend({
  version: z.literal(1),
});

export type WirebotSettings = z.infer<typeof settingsSchema>;

export class WirebotSettingsStore extends JsonStore<z.infer<typeof storedSettingsSchema>> {
  public constructor(path: string, logger: Logger) {
    super(
      path,
      storedSettingsSchema,
      { version: 1, remoteClientContext: true, autoMode: true },
      logger,
      "Ignoring invalid Wirebot settings",
    );
  }

  public read(): WirebotSettings {
    return { remoteClientContext: this.state.remoteClientContext, autoMode: this.state.autoMode };
  }

  public async update(input: unknown): Promise<WirebotSettings> {
    const settings = settingsSchema.parse({ ...this.read(), ...settingsPatchSchema.parse(input) });
    await this.persist({ version: 1, ...settings });
    return settings;
  }
}
