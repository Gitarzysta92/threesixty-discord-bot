import type { Client, GatewayIntentBits } from 'discord.js';
import type { Command } from './command.js';

export interface BotModule {
  readonly id: string;
  readonly intents: readonly GatewayIntentBits[];
  readonly commands: readonly Command[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function applyModuleIntents(client: Client, modules: readonly BotModule[]) {
  // discord.js freezes the initial bitfield; add() returns a new instance.
  client.options.intents = client.options.intents.add(...modules.flatMap(module => [...module.intents])).freeze();
}

/** Start independently; unwind previously started modules if startup fails. */
export class ModuleHost {
  private started: BotModule[] = [];
  constructor(private readonly modules: readonly BotModule[]) {
    if (new Set(modules.map(module => module.id)).size !== modules.length) {
      throw new Error('Duplicate module ID');
    }
  }
  async start() {
    try {
      for (const module of this.modules) {
        await module.start();
        this.started.push(module);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    const errors: unknown[] = [];
    for (const module of this.started.splice(0).reverse()) {
      try { await module.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Module shutdown failed');
  }
}
