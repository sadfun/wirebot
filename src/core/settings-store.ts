import { z } from "zod";
import { JsonStore } from "../shared/json-store.js";
import type { Logger } from "../shared/logger.js";

const settingsSchema = z.strictObject({
  remoteClientContext: z.boolean(),
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
      { version: 1, remoteClientContext: true },
      logger,
      "Ignoring invalid Wirebot settings",
    );
  }

  public read(): WirebotSettings {
    return { remoteClientContext: this.state.remoteClientContext };
  }

  public async update(input: unknown): Promise<WirebotSettings> {
    const settings = settingsSchema.parse(input);
    await this.persist({ version: 1, ...settings });
    return settings;
  }
}
